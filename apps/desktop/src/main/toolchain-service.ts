import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedToolchainCatalog, ManagedToolchainEvent, ToolEvent, ToolchainInfo, ToolRunRequest, ToolRunResult } from '../shared/types';
import { AppError } from './errors';
import { ManagedToolchainService, type ManagedToolchainOptions } from './managed-toolchain-service';
import { detachedProcessGroup, processTreeAlive, signalProcessTree } from './process-tree';
import type { ProjectService, ProjectToolchainBinding, ProjectToolchainId } from './project-service';

type ToolKind = ToolchainInfo['kind'];
interface ToolDefinition { id: string; name: string; kind: ToolKind; candidates: string[]; versionArgs: string[] }
interface TrustedExecutable { path: string; sha256: string }
interface TrustedExecutablesFile { schemaVersion: 2; tools: Partial<Record<ProjectToolchainId, TrustedExecutable[]>> }

const TOOLS: ToolDefinition[] = [
  { id: 'latex', name: 'LaTeX', kind: 'latex', candidates: ['latexmk', 'xelatex', 'pdflatex', 'lualatex'], versionArgs: ['--version'] },
  { id: 'python', name: 'Python', kind: 'python', candidates: process.platform === 'win32' ? ['python.exe', 'py.exe'] : ['python3', 'python'], versionArgs: ['--version'] },
  { id: 'r', name: 'R', kind: 'r', candidates: process.platform === 'win32' ? ['R.exe', 'Rscript.exe'] : ['R', 'Rscript'], versionArgs: ['--version'] },
  { id: 'pandoc', name: 'Pandoc', kind: 'pandoc', candidates: ['pandoc'], versionArgs: ['--version'] },
  { id: 'compiler', name: 'C/C++ Compiler', kind: 'compiler', candidates: process.platform === 'win32' ? ['clang.exe', 'gcc.exe', 'cl.exe'] : ['cc', 'clang', 'gcc'], versionArgs: ['--version'] },
  { id: 'julia', name: 'Julia', kind: 'other', candidates: ['julia'], versionArgs: ['--version'] },
];

const INSTALL_URLS: Record<string, string> = {
  latex: 'https://www.latex-project.org/get/', python: 'https://www.python.org/downloads/', r: 'https://cran.r-project.org/',
  pandoc: 'https://pandoc.org/installing.html', compiler: 'https://clang.llvm.org/get_started.html', julia: 'https://julialang.org/downloads/',
};

async function safeEnvironment(
  extra: NodeJS.ProcessEnv = {},
  options: { executable?: string; forbiddenRoot?: string; platform?: NodeJS.Platform; pathValue?: string } = {},
): Promise<NodeJS.ProcessEnv> {
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PATHEXT', 'COMSPEC'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  const directories = await childToolSearchDirectories(
    options.platform ?? process.platform,
    options.pathValue ?? extra.PATH ?? process.env.PATH,
    options.executable,
    options.forbiddenRoot,
  );
  return { ...env, ...extra, PATH: directories.join(path.delimiter) };
}

async function capture(
  executable: string,
  args: string[],
  cwd?: string,
  timeoutMs = 7_000,
  forbiddenRoot?: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = await safeEnvironment(extraEnvironment, { executable, forbiddenRoot });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, detached: detachedProcessGroup(), env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(0, 64 * 1024);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    let settled = false;
    let timedOut = false;
    let terminateTimer: NodeJS.Timeout | undefined;
    let failureTimer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminateTimer) clearTimeout(terminateTimer);
      if (failureTimer) clearTimeout(failureTimer);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      terminateTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL', true), 1_500);
      failureTimer = setTimeout(() => finish(() => reject(new AppError('TOOL_PROBE_TIMEOUT', 'Tool version probe did not exit after termination'))), 4_000);
    }, timeoutMs);
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code) => finish(() => {
      if (processTreeAlive(child)) signalProcessTree(child, 'SIGKILL', true);
      if (timedOut) reject(new AppError('TOOL_PROBE_TIMEOUT', 'Tool version probe timed out'));
      else resolve({ code, stdout, stderr });
    }));
  });
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function systemToolSearchDirectories(platform: NodeJS.Platform = process.platform, pathValue = process.env.PATH): string[] {
  const inherited = (pathValue ?? '').split(path.delimiter);
  const common = platform === 'darwin'
    ? ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/Library/Frameworks/R.framework/Resources/bin', '/usr/bin', '/bin']
    : platform === 'linux'
      ? ['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin']
      : [];
  return [...new Set([...inherited, ...common].filter((directory) => directory && path.isAbsolute(directory)))];
}

async function childToolSearchDirectories(
  platform: NodeJS.Platform = process.platform,
  pathValue = process.env.PATH,
  executable?: string,
  forbiddenRoot?: string,
): Promise<string[]> {
  const root = forbiddenRoot ? await realpath(path.resolve(forbiddenRoot)).catch(() => path.resolve(forbiddenRoot)) : undefined;
  const candidates = [executable ? path.dirname(executable) : undefined, ...systemToolSearchDirectories(platform, pathValue)];
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const lexical = path.resolve(candidate);
    if (root && isInside(root, lexical)) continue;
    const canonical = await realpath(lexical).catch(() => lexical);
    if (root && isInside(root, canonical)) continue;
    const key = platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(canonical);
  }
  return directories;
}

async function resolveOnPath(command: string, forbiddenRoot: string): Promise<string | undefined> {
  const names = process.platform === 'win32' && !path.extname(command) ? [command, `${command}.exe`] : [command];
  for (const directory of systemToolSearchDirectories()) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const canonical = await realpath(candidate);
        const relative = path.relative(forbiddenRoot, canonical);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) continue;
        const info = await stat(canonical);
        if (!info.isFile()) continue;
        await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return canonical;
      } catch { /* Try the next absolute PATH entry. */ }
    }
  }
  return undefined;
}

export const toolchainInternals = { capture, childToolSearchDirectories, systemToolSearchDirectories };

export interface PreparedManagedToolchainSelection {
  readonly toolId: ProjectToolchainId;
  readonly version: string;
  readonly executable: string;
  readonly projectSessionToken: string;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertExecutableFile(executablePath: string): Promise<string> {
  if (typeof executablePath !== 'string' || !executablePath || executablePath.length > 4096 || executablePath.includes('\0')) {
    throw new AppError('INVALID_EXECUTABLE', 'Executable path is invalid');
  }
  const canonical = await realpath(path.resolve(executablePath));
  const info = await stat(canonical);
  if (!info.isFile()) throw new AppError('INVALID_EXECUTABLE', 'Selected executable is not a file');
  await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  return canonical;
}

export class ToolchainService {
  private detected = new Map<string, ToolchainInfo>();
  private selectedBindings = new Map<string, ToolchainInfo>();
  private bindingErrors = new Map<string, ToolchainInfo>();
  private trustedBindingHashes = new Map<string, string>();
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly latexOutputs = new Map<string, { root: string; path: string }>();
  private readonly managedRoot: string;
  private readonly trustedExecutablesPath: string;
  private managedService?: ManagedToolchainService;
  private sessionIdentity?: string;
  private sessionToken?: string;
  private detectionPromise?: Promise<ToolchainInfo[]>;
  private detectionComplete = false;

  constructor(
    private readonly projects: ProjectService,
    private readonly emit: (event: ToolEvent) => void,
    private readonly openInstaller: (url: string) => Promise<void>,
    private readonly reviewExecution: (preview: { executable: string; args: string[]; cwd: string }) => Promise<boolean>,
    userDataPath: string,
    private readonly emitManaged: (event: ManagedToolchainEvent) => void = () => undefined,
    private readonly managedOptions: ManagedToolchainOptions = {},
  ) {
    this.managedRoot = path.join(userDataPath, 'toolchains');
    this.trustedExecutablesPath = path.join(userDataPath, 'trusted-toolchains.json');
  }

  beginProjectSession(): void {
    const current = this.projects.current;
    if (!current) throw new AppError('NO_PROJECT', 'Open a project first');
    this.sessionIdentity = `${current.id}\0${current.path}`;
    this.sessionToken = randomUUID();
    this.detectionPromise = undefined;
    this.detectionComplete = false;
    this.detected.clear();
    this.selectedBindings.clear();
    this.bindingErrors.clear();
    this.trustedBindingHashes.clear();
    this.latexOutputs.clear();
  }

  endProjectSession(): void {
    this.sessionIdentity = undefined;
    this.sessionToken = undefined;
    this.detectionPromise = undefined;
    this.detectionComplete = false;
    this.detected.clear();
    this.selectedBindings.clear();
    this.bindingErrors.clear();
    this.trustedBindingHashes.clear();
    this.latexOutputs.clear();
  }

  async list(): Promise<ToolchainInfo[]> {
    if (this.projects.current) this.ensureProjectSession();
    const results: ToolchainInfo[] = [];
    for (const definition of TOOLS) {
      results.push(
        this.selectedBindings.get(definition.id)
        ?? this.bindingErrors.get(definition.id)
        ?? this.detected.get(definition.id)
        ?? { id: definition.id, name: definition.name, kind: definition.kind, status: 'missing', selected: false, managed: false },
      );
    }
    return results;
  }

  ensureDetected(): Promise<ToolchainInfo[]> {
    const token = this.ensureProjectSession();
    if (this.detectionComplete) return this.list();
    return this.detectionPromise ?? this.startDetection(token);
  }

  detect(): Promise<ToolchainInfo[]> {
    const token = this.ensureProjectSession();
    return this.detectionPromise ?? this.startDetection(token);
  }

  async selectExecutable(toolId: string, executablePath: string): Promise<ToolchainInfo> {
    const definition = this.definition(toolId);
    const token = this.ensureProjectSession();
    await this.detectionPromise?.catch((error) => {
      if (this.sessionToken === token) throw error;
    });
    this.assertCurrentSession(token);
    const executable = await this.projects.guard.assertExecutable(executablePath);
    const beforeHash = await sha256File(executable);
    const version = await this.readVersion(executable, definition.versionArgs);
    const afterHash = await sha256File(executable);
    if (afterHash !== beforeHash) throw new AppError('TOOL_CHANGED', 'The selected executable changed while it was being verified; select it again');
    await this.confirmExecutable(definition.id as ProjectToolchainId, executable, afterHash);
    await this.projects.updateToolchainBinding(definition.id as ProjectToolchainId, { source: 'custom', path: executable });
    this.assertCurrentSession(token);
    this.projects.database.db.prepare(`INSERT INTO toolchains(id,executable_path,version,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET executable_path=excluded.executable_path,version=excluded.version,updated_at=excluded.updated_at`)
      .run(toolId, executable, version, new Date().toISOString());
    const selected: ToolchainInfo = { id: toolId, name: definition.name, kind: definition.kind, status: 'ready', path: executable, version, selected: true, managed: false, detail: 'Confirmed project executable' };
    this.selectedBindings.set(toolId, selected);
    this.bindingErrors.delete(toolId);
    this.trustedBindingHashes.set(toolId, afterHash);
    return selected;
  }

  async selectSystem(toolId: string): Promise<ToolchainInfo> {
    const definition = this.definition(toolId);
    const token = this.ensureProjectSession();
    await this.ensureDetected();
    this.assertCurrentSession(token);
    const detected = this.detected.get(toolId);
    if (!detected?.path || detected.status !== 'ready') throw new AppError('TOOL_MISSING', `${definition.name} is not available on the system PATH`);
    await this.projects.updateToolchainBinding(definition.id as ProjectToolchainId, { source: 'system' });
    this.assertCurrentSession(token);
    const selected = { ...detected, selected: true, detail: 'Project configuration · system PATH' };
    this.selectedBindings.set(toolId, selected);
    this.bindingErrors.delete(toolId);
    this.trustedBindingHashes.delete(toolId);
    this.persistSelected(selected);
    return selected;
  }

  async selectForProject(toolId: string, executablePath: string): Promise<void> {
    await this.selectExecutable(toolId, executablePath);
  }

  async install(toolId: string): Promise<void> {
    this.definition(toolId);
    const url = INSTALL_URLS[toolId];
    if (!url) throw new AppError('NO_INSTALLER', 'No installer source is configured for this tool');
    await this.openInstaller(url);
  }

  async managedCatalog(toolId: string): Promise<ManagedToolchainCatalog> {
    this.definition(toolId);
    const selected = this.selectedBindings.get(toolId)?.path;
    return this.managed().catalog(toolId as ProjectToolchainId, selected);
  }

  validateManagedRequest(toolId: string, versionValue: string): { toolId: ProjectToolchainId; version: string } {
    if (typeof toolId !== 'string' || typeof versionValue !== 'string') {
      throw new AppError('INVALID_MANAGED_TOOLCHAIN', 'Managed toolchain request is invalid');
    }
    const definition = this.definition(toolId);
    if (versionValue !== versionValue.trim() || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(versionValue)) {
      throw new AppError('INVALID_TOOLCHAIN_VERSION', 'Managed toolchain version is invalid');
    }
    return { toolId: definition.id as ProjectToolchainId, version: versionValue };
  }

  async prepareManagedInstallation(toolId: string, versionValue: string): Promise<PreparedManagedToolchainSelection> {
    const { toolId: validatedToolId, version } = this.validateManagedRequest(toolId, versionValue);
    const projectSessionToken = this.ensureProjectSession();
    const record = await this.managed().install(validatedToolId, version);
    return { toolId: validatedToolId, version, executable: record.executable, projectSessionToken };
  }

  async prepareInstalledManagedSelection(toolId: string, versionValue: string): Promise<PreparedManagedToolchainSelection> {
    const { toolId: validatedToolId, version } = this.validateManagedRequest(toolId, versionValue);
    const projectSessionToken = this.ensureProjectSession();
    const installed = (await this.managed().installed(validatedToolId)).find((item) => item.version === version);
    if (!installed?.executablePath) throw new AppError('MANAGED_VERSION_NOT_INSTALLED', 'Managed toolchain version is not installed');
    const relative = path.relative(this.managedRoot, installed.executablePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AppError('UNSAFE_MANAGED_PATH', 'Managed executable resolves outside the managed toolchain directory');
    }
    const executable = relative.split(path.sep).join('/');
    await this.managed().verifyExecutable(executable);
    return { toolId: validatedToolId, version, executable, projectSessionToken };
  }

  async selectPreparedManaged(prepared: PreparedManagedToolchainSelection): Promise<ToolchainInfo> {
    const { toolId, version } = this.validateManagedRequest(prepared.toolId, prepared.version);
    this.assertCurrentSession(prepared.projectSessionToken);
    const definition = this.definition(toolId);
    const expectedPrefix = `${toolId}/${version}/`;
    if (!prepared.executable.replaceAll('\\', '/').startsWith(expectedPrefix)) {
      throw new AppError('MANAGED_INSTALL_INVALID', 'Managed executable does not belong to the selected tool and version');
    }
    const managed = this.managed();
    const verified = await managed.verifyExecutable(prepared.executable);
    this.assertCurrentSession(prepared.projectSessionToken);
    const activationEnvironment = await managed.activationEnvironment(prepared.executable);
    const reportedVersion = await this.readVersion(verified.executable, definition.versionArgs, this.projects.guard.root, activationEnvironment);
    if (await sha256File(verified.executable) !== verified.sha256) {
      throw new AppError('MANAGED_INSTALL_CHANGED', 'The managed executable changed while it was being selected; reinstall this version');
    }
    this.assertCurrentSession(prepared.projectSessionToken);
    await this.projects.updateToolchainBinding(toolId, { source: 'managed', path: prepared.executable });
    this.assertCurrentSession(prepared.projectSessionToken);
    const selected: ToolchainInfo = {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      status: 'ready',
      path: verified.executable,
      version: reportedVersion,
      selected: true,
      managed: true,
      detail: `Research IDE managed · ${version}`,
    };
    this.selectedBindings.set(definition.id, selected);
    this.bindingErrors.delete(definition.id);
    this.trustedBindingHashes.set(definition.id, verified.sha256);
    this.persistSelected(selected);
    return selected;
  }

  async removeManaged(toolId: string, version: string): Promise<void> {
    this.definition(toolId);
    const normalizedVersion = version.trim();
    const configured = this.projects.configuredToolchains[toolId as ProjectToolchainId];
    const prefix = `${toolId}/${normalizedVersion}/`;
    if (configured?.source === 'managed' && configured.path.replaceAll('\\', '/').startsWith(prefix)) {
      throw new AppError('MANAGED_VERSION_SELECTED', 'This version is selected by the current project; select another version before removing it');
    }
    await this.managed().remove(toolId as ProjectToolchainId, normalizedVersion);
  }

  async run(request: ToolRunRequest, internalEnvironment: NodeJS.ProcessEnv = {}): Promise<ToolRunResult> {
    if (!request || typeof request !== 'object' || typeof request.toolId !== 'string' || request.toolId.length > 100) throw new AppError('INVALID_RUN_REQUEST', 'Tool run request is invalid');
    if (!Array.isArray(request.args) || request.args.length > 200 || request.args.some((arg) => typeof arg !== 'string' || arg.length > 16_384 || arg.includes('\0'))) {
      throw new AppError('INVALID_ARGUMENTS', 'Tool arguments are invalid');
    }
    const tool = await this.resolveSelected(request.toolId);
    const executable = await this.projects.guard.assertExecutable(tool.path!);
    if (executable !== tool.path) throw new AppError('TOOL_CHANGED', 'The selected executable now resolves to a different path; select it again before running');
    await this.assertTrustedBindingUnchanged(request.toolId, executable);
    const cwd = request.cwd ? await this.projects.guard.existing(request.cwd) : this.projects.guard.root;
    if (!(await stat(cwd)).isDirectory()) throw new AppError('INVALID_CWD', 'Working directory must be a project directory');
    if (!await this.reviewExecution({ executable, args: [...request.args], cwd })) throw new AppError('EXECUTION_DECLINED', 'Tool execution was cancelled');
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const binding = this.projects.configuredToolchains[request.toolId as ProjectToolchainId];
    const activationEnvironment = tool.managed && binding?.source === 'managed'
      ? await this.managed().activationEnvironment(binding.path)
      : {};
    const env = await safeEnvironment({ ...activationEnvironment, ...internalEnvironment }, { executable, forbiddenRoot: this.projects.guard.root });
    const child = spawn(executable, request.args, {
      cwd, env, detached: detachedProcessGroup(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Research IDE has no interactive terminal API.  Close stdin immediately so
    // scripts that attempt to read it receive EOF instead of hanging for 10 min.
    child.stdin.end();
    this.running.set(runId, child);
    let emittedBytes = 0;
    const forward = (type: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (emittedBytes >= 5 * 1024 * 1024) return;
      const text = chunk.toString('utf8').slice(0, 64 * 1024);
      emittedBytes += Buffer.byteLength(text);
      this.emit({ runId, type, text, timestamp: new Date().toISOString() });
    };
    child.stdout.on('data', (chunk: Buffer) => forward('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => forward('stderr', chunk));
    child.once('error', (error) => {
      this.running.delete(runId);
      this.emit({ runId, type: 'error', text: error.message.slice(0, 500), timestamp: new Date().toISOString() });
    });
    child.once('exit', (code) => {
      if (processTreeAlive(child)) signalProcessTree(child, 'SIGKILL', true);
      this.running.delete(runId);
      this.emit({ runId, type: 'exit', exitCode: code ?? -1, timestamp: new Date().toISOString() });
    });
    const timer = setTimeout(() => this.stop(runId).catch(() => undefined), 10 * 60_000);
    child.once('close', () => clearTimeout(timer));
    return { runId, startedAt };
  }

  async stop(runId: string): Promise<void> {
    const child = this.running.get(runId);
    if (!child) return;
    await new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(failureTimer);
        callback();
      };
      const forceTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL', true);
        if (process.platform !== 'win32') finish(resolve);
      }, 1_500);
      const failureTimer = setTimeout(() => finish(() => reject(new AppError('PROCESS_STOP_TIMEOUT', 'Tool process did not exit after forced termination'))), 5_000);
      child.once('exit', () => { if (!processTreeAlive(child)) finish(resolve); });
      signalProcessTree(child, 'SIGTERM');
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
    await this.managedService?.stopAll();
    this.latexOutputs.clear();
  }

  async compileLatex(relativePath: string): Promise<ToolRunResult & { outputId: string; outputPdf: string }> {
    await this.projects.assertMetadataIntegrity();
    if (path.extname(relativePath).toLowerCase() !== '.tex') throw new AppError('NOT_TEX', 'Select a .tex source file to compile');
    const source = await this.projects.guard.existing(relativePath);
    if (!(await stat(source)).isFile()) throw new AppError('NOT_A_FILE', 'LaTeX source is not a file');
    const tool = await this.resolveSelected('latex');
    const executable = await this.projects.guard.assertExecutable(tool.path!);
    if (executable !== tool.path) throw new AppError('TOOL_CHANGED', 'The selected LaTeX executable now resolves to a different path; select it again before compiling');
    await this.assertTrustedBindingUnchanged('latex', executable);
    const engine = path.basename(executable).toLowerCase().replace(/\.exe$/u, '');
    const outputId = randomUUID();
    const buildRoot = await this.projects.internalDirectory('build');
    const outputDirectory = path.join(buildRoot, outputId);
    await mkdir(outputDirectory, { recursive: true });
    const common = ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-no-shell-escape'];
    const args = engine === 'latexmk'
      ? ['-norc', '-pdf', '-pdflatex=pdflatex -no-shell-escape %O %S', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-outdir=${outputDirectory}`, path.basename(source)]
      : engine === 'tectonic'
        ? ['--untrusted', '--keep-logs', '--outdir', outputDirectory, path.basename(source)]
        : [...common, `-output-directory=${outputDirectory}`, path.basename(source)];
    const result = await this.run(
      { toolId: 'latex', args, cwd: this.projects.guard.relative(path.dirname(source)) },
      {
        openin_any: 'p', openout_any: 'p', TEXMFOUTPUT: outputDirectory,
        TEXMF_OUTPUT_DIRECTORY: outputDirectory, TEXINPUTS: `${this.projects.guard.root}//${path.delimiter}`,
        ...(engine === 'tectonic' ? { TECTONIC_UNTRUSTED_MODE: '1' } : {}),
      },
    );
    const outputPdf = `${path.basename(source, path.extname(source))}.pdf`;
    this.latexOutputs.set(outputId, { root: this.projects.guard.root, path: path.join(outputDirectory, outputPdf) });
    return { ...result, outputId, outputPdf };
  }

  async readLatexOutput(outputId: string): Promise<Buffer> {
    await this.projects.assertMetadataIntegrity();
    if (!/^[0-9a-f-]{36}$/iu.test(outputId)) throw new AppError('INVALID_OUTPUT_ID', 'LaTeX output id is invalid');
    const output = this.latexOutputs.get(outputId);
    if (!output || output.root !== this.projects.guard.root) throw new AppError('OUTPUT_NOT_FOUND', 'LaTeX output is not available');
    const lexicalInfo = await import('node:fs/promises').then(({ lstat }) => lstat(output.path)).catch(() => undefined);
    if (lexicalInfo?.isSymbolicLink()) throw new AppError('UNSAFE_OUTPUT', 'Compiled PDF must not be a symbolic link');
    const info = lexicalInfo;
    if (!info?.isFile()) throw new AppError('OUTPUT_NOT_READY', 'LaTeX output is not ready; wait for the compile process to finish');
    if (info.size > 200 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', 'Compiled PDF is larger than 200 MB');
    const canonical = await import('node:fs/promises').then(({ realpath }) => realpath(output.path));
    const buildRoot = await this.projects.internalDirectory('build');
    const relative = path.relative(buildRoot, canonical);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AppError('UNSAFE_OUTPUT', 'Compiled PDF resolves outside the project build directory');
    return readFile(canonical);
  }

  private ensureProjectSession(): string {
    const current = this.projects.current;
    if (!current) throw new AppError('NO_PROJECT', 'Open a project first');
    const identity = `${current.id}\0${current.path}`;
    if (!this.sessionToken || this.sessionIdentity !== identity) this.beginProjectSession();
    return this.sessionToken!;
  }

  private assertCurrentSession(token: string): void {
    const current = this.projects.current;
    const identity = current ? `${current.id}\0${current.path}` : undefined;
    if (!this.sessionToken || this.sessionToken !== token || this.sessionIdentity !== identity) {
      throw new AppError('PROJECT_SESSION_CHANGED', 'The project changed while detecting toolchains');
    }
  }

  private startDetection(token: string): Promise<ToolchainInfo[]> {
    this.detectionComplete = false;
    const promise = this.scanAndBind(token);
    this.detectionPromise = promise;
    void promise.then(
      () => {
        if (this.detectionPromise === promise && this.sessionToken === token) {
          this.detectionPromise = undefined;
          this.detectionComplete = true;
        }
      },
      () => {
        if (this.detectionPromise === promise && this.sessionToken === token) {
          this.detectionPromise = undefined;
          this.detectionComplete = false;
        }
      },
    );
    return promise;
  }

  private async scanAndBind(token: string): Promise<ToolchainInfo[]> {
    this.assertCurrentSession(token);
    const projectRoot = this.projects.guard.root;
    const configured = this.projects.configuredToolchains;
    const results = await Promise.all(TOOLS.map((definition) => this.detectOne(definition, projectRoot)));
    this.assertCurrentSession(token);
    const detected = new Map(results.map((result) => [result.id, result]));
    this.detected = detected;
    this.trustedBindingHashes.clear();
    const trusted = await this.readTrustedExecutables();
    const selected = new Map<string, ToolchainInfo>();
    const errors = new Map<string, ToolchainInfo>();
    for (const definition of TOOLS) {
      const binding = configured[definition.id as ProjectToolchainId];
      if (!binding) continue;
      try {
        const resolved = await this.resolveConfiguredBinding(definition, binding, detected.get(definition.id), trusted, projectRoot);
        if (resolved) selected.set(definition.id, resolved);
      } catch (error) {
        const systemCandidate = detected.get(definition.id);
        errors.set(definition.id, {
          id: definition.id,
          name: definition.name,
          kind: definition.kind,
          status: 'error',
          selected: false,
          managed: binding.source === 'managed',
          detail: error instanceof Error ? error.message : 'Project toolchain binding was blocked',
          systemPath: systemCandidate?.status === 'ready' ? systemCandidate.path : undefined,
          systemVersion: systemCandidate?.status === 'ready' ? systemCandidate.version : undefined,
        });
        this.trustedBindingHashes.delete(definition.id);
      }
    }
    this.assertCurrentSession(token);
    const persist = this.projects.database.db.transaction((values: ToolchainInfo[]) => {
      this.projects.database.db.prepare('DELETE FROM toolchains').run();
      const statement = this.projects.database.db.prepare('INSERT INTO toolchains(id,executable_path,version,updated_at) VALUES(?,?,?,?)');
      const now = new Date().toISOString();
      for (const value of values) statement.run(value.id, value.path!, value.version ?? null, now);
    });
    persist([...selected.values()]);
    this.selectedBindings = selected;
    this.bindingErrors = errors;
    return this.list();
  }

  private async resolveConfiguredBinding(
    definition: ToolDefinition,
    binding: ProjectToolchainBinding,
    systemTool: ToolchainInfo | undefined,
    trusted: TrustedExecutablesFile,
    projectRoot: string,
  ): Promise<ToolchainInfo | undefined> {
    if (binding.source === 'system') {
      if (!systemTool?.path || systemTool.status !== 'ready') return undefined;
      return { ...systemTool, selected: true, detail: 'Project configuration · system PATH' };
    }
    let executable: string;
    if (binding.source === 'managed') {
      const verified = await this.managed().verifyExecutable(binding.path);
      executable = verified.executable;
      this.trustedBindingHashes.set(definition.id, verified.sha256);
    } else {
      if (!path.isAbsolute(binding.path)) throw new AppError('UNSAFE_TOOLCHAIN_CONFIG', 'Custom toolchain paths must be absolute');
      executable = await assertExecutableFile(binding.path);
      const confirmation = trusted.tools[definition.id as ProjectToolchainId]?.find((entry) => entry.path === executable);
      if (!confirmation) {
        throw new AppError('TOOLCHAIN_CONFIRMATION_REQUIRED', 'This custom executable has not been confirmed in the system file picker');
      }
      const beforeHash = await sha256File(executable);
      if (beforeHash !== confirmation.sha256) throw new AppError('TOOLCHAIN_CONFIRMATION_REQUIRED', 'This custom executable changed after it was confirmed; choose it again in the system file picker');
      this.trustedBindingHashes.set(definition.id, confirmation.sha256);
    }
    const activationEnvironment = binding.source === 'managed'
      ? await this.managed().activationEnvironment(binding.path)
      : {};
    const version = await this.readVersion(executable, definition.versionArgs, projectRoot, activationEnvironment);
    const trustedHash = this.trustedBindingHashes.get(definition.id);
    if (trustedHash && await sha256File(executable) !== trustedHash) {
      this.trustedBindingHashes.delete(definition.id);
      throw new AppError('TOOL_CHANGED', 'The configured executable changed while it was being verified; choose it again');
    }
    return {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      status: 'ready',
      path: executable,
      version,
      selected: true,
      managed: binding.source === 'managed',
      detail: binding.source === 'managed' ? 'Project configuration · Research IDE managed' : 'Project configuration · confirmed executable',
    };
  }

  private async readTrustedExecutables(): Promise<TrustedExecutablesFile> {
    try {
      const info = await lstat(this.trustedExecutablesPath);
      if (info.isSymbolicLink() || !info.isFile()) throw new AppError('UNSAFE_TOOLCHAIN_TRUST_STORE', 'Toolchain confirmation registry must be a regular file');
      const parsed = JSON.parse(await readFile(this.trustedExecutablesPath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== 2) return { schemaVersion: 2, tools: {} };
      const rawTools = (parsed as { tools?: unknown }).tools;
      if (!rawTools || typeof rawTools !== 'object' || Array.isArray(rawTools)) return { schemaVersion: 2, tools: {} };
      const tools: TrustedExecutablesFile['tools'] = {};
      for (const id of TOOLS.map((tool) => tool.id as ProjectToolchainId)) {
        const values = (rawTools as Record<string, unknown>)[id];
        if (Array.isArray(values)) tools[id] = values.filter((value): value is TrustedExecutable => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          const entry = value as Partial<TrustedExecutable>;
          return typeof entry.path === 'string' && path.isAbsolute(entry.path) && entry.path.length <= 4096
            && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256);
        }).slice(0, 100);
      }
      return { schemaVersion: 2, tools };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, tools: {} };
      if (error instanceof AppError) throw error;
      return { schemaVersion: 2, tools: {} };
    }
  }

  private async confirmExecutable(toolId: ProjectToolchainId, executable: string, digest: string): Promise<void> {
    const trusted = await this.readTrustedExecutables();
    trusted.tools[toolId] = [...(trusted.tools[toolId] ?? []).filter((entry) => entry.path !== executable), { path: executable, sha256: digest }].slice(-100);
    await mkdir(path.dirname(this.trustedExecutablesPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.trustedExecutablesPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(trusted, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.trustedExecutablesPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async detectOne(definition: ToolDefinition, projectRoot: string): Promise<ToolchainInfo> {
    for (const candidate of definition.candidates) {
      const executable = await resolveOnPath(candidate, projectRoot);
      if (!executable) continue;
      try {
        const version = await this.readVersion(executable, definition.versionArgs, projectRoot);
        return { id: definition.id, name: definition.name, kind: definition.kind, status: 'ready', path: executable, version, selected: false, managed: false, detail: path.basename(executable) };
      } catch { /* continue with next candidate */ }
    }
    return { id: definition.id, name: definition.name, kind: definition.kind, status: 'missing', selected: false, managed: false, detail: 'Not found on the system PATH' };
  }

  private async readVersion(
    executable: string,
    args: string[],
    projectRoot = this.projects.guard.root,
    environment: NodeJS.ProcessEnv = {},
  ): Promise<string> {
    const result = await capture(executable, args, undefined, 7_000, projectRoot, environment);
    if (result.code !== 0 && !result.stdout && !result.stderr) throw new AppError('TOOL_PROBE_FAILED', 'The executable did not report a version');
    return (result.stdout || result.stderr).split(/\r?\n/u).find((line) => line.trim())?.trim().slice(0, 300) ?? 'Detected';
  }

  private async assertTrustedBindingUnchanged(toolId: string, executable: string): Promise<void> {
    const expected = this.trustedBindingHashes.get(toolId);
    if (!expected) return;
    if (await sha256File(executable) !== expected) {
      this.selectedBindings.delete(toolId);
      this.trustedBindingHashes.delete(toolId);
      throw new AppError('TOOL_CHANGED', 'The confirmed executable changed on disk; choose it again before running');
    }
  }

  private persistSelected(value: ToolchainInfo): void {
    this.projects.database.db.prepare(`INSERT INTO toolchains(id,executable_path,version,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET executable_path=excluded.executable_path,version=excluded.version,updated_at=excluded.updated_at`)
      .run(value.id, value.path!, value.version ?? null, new Date().toISOString());
  }

  private definition(id: string): ToolDefinition {
    const definition = TOOLS.find((item) => item.id === id);
    if (!definition) throw new AppError('UNKNOWN_TOOL', 'Unknown toolchain');
    return definition;
  }

  private managed(): ManagedToolchainService {
    return this.managedService ??= new ManagedToolchainService(this.managedRoot, this.emitManaged, this.managedOptions);
  }

  private async resolveSelected(id: string): Promise<ToolchainInfo> {
    const selected = (await this.list()).find((tool) => tool.id === id);
    if (selected?.status === 'ready' && selected.path) return selected;
    await this.ensureDetected();
    const detected = (await this.list()).find((tool) => tool.id === id);
    if (detected?.status !== 'ready' || !detected.path) throw new AppError('TOOL_MISSING', `${this.definition(id).name} is not installed or selected`);
    return detected;
  }
}
