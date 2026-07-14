import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedToolchainCatalog, ManagedToolchainEvent, ManagedToolchainVersion } from '../shared/types';
import { AppError } from './errors';
import { flushFileHandle, syncParentDirectory } from './file-durability';
import { detachedProcessGroup, processTreeAlive, signalProcessTree } from './process-tree';
import type { ProjectToolchainId } from './project-service';

interface ManagedDefinition {
  packageName: string;
  displayName: string;
  relativeExecutables: string[];
  executablePattern: RegExp;
}

export interface ManagedToolchainInstall {
  schemaVersion: 1;
  toolId: ProjectToolchainId;
  packageName: string;
  version: string;
  platform: string;
  executable: string;
  executableSha256: string;
  installedAt: string;
  manager: { name: 'pixi'; version: string };
}

type InstallRecord = ManagedToolchainInstall;

interface PixiReleaseAsset {
  name: string;
  browser_download_url: string;
  digest: string;
  size: number;
}

interface PixiRecord {
  schemaVersion: 1;
  version: string;
  executable: string;
  sha256: string;
}

interface ProcessResult { code: number | null; stdout: string; stderr: string }
interface SafeDirectory { path: string; canonical: string; device: number; inode: number }

export interface ManagedToolchainOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  requestJson?: (url: string, maxBytes: number, signal?: AbortSignal) => Promise<unknown>;
  download?: (url: string, target: string, maxBytes: number, progress: (value: number) => void, signal?: AbortSignal) => Promise<{ sha256: string; size: number }>;
  pixiExecutable?: (signal?: AbortSignal) => Promise<{ path: string; version: string }>;
  runCommand?: (executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal) => Promise<ProcessResult>;
  now?: () => Date;
}

const DEFINITIONS: Record<ProjectToolchainId, ManagedDefinition> = {
  latex: {
    packageName: 'tectonic', displayName: 'Tectonic (LaTeX)',
    relativeExecutables: ['bin/tectonic', 'Library/bin/tectonic.exe'], executablePattern: /^tectonic(?:\.exe)?$/iu,
  },
  python: {
    packageName: 'python', displayName: 'Python',
    relativeExecutables: ['bin/python3', 'bin/python', 'python.exe'], executablePattern: /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/iu,
  },
  r: {
    packageName: 'r-base', displayName: 'R',
    relativeExecutables: ['bin/R', 'bin/Rscript', 'Scripts/R.exe', 'Lib/R/bin/x64/R.exe'], executablePattern: /^(?:R|Rscript)(?:\.exe)?$/u,
  },
  pandoc: {
    packageName: 'pandoc', displayName: 'Pandoc',
    relativeExecutables: ['bin/pandoc', 'Library/bin/pandoc.exe'], executablePattern: /^pandoc(?:\.exe)?$/iu,
  },
  compiler: {
    packageName: 'clangxx', displayName: 'LLVM Clang C/C++',
    relativeExecutables: ['bin/clang++', 'bin/clang', 'Library/bin/clang++.exe', 'Library/bin/clang.exe'],
    executablePattern: /(?:^|-)(?:clang(?:\+\+)?)(?:\.exe)?$/iu,
  },
  julia: {
    packageName: 'julia', displayName: 'Julia',
    relativeExecutables: ['bin/julia', 'Library/bin/julia.exe'], executablePattern: /^julia(?:\.exe)?$/iu,
  },
};

const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_MANAGER_BYTES = 160 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 2 * 1024 * 1024;
const MANAGER_TIMEOUT_MS = 45 * 60_000;
const METADATA_TIMEOUT_MS = 60_000;
const MANAGER_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const PROCESS_TERMINATION_GRACE_MS = 2_000;
const PROCESS_TERMINATION_LIMIT_MS = 8_000;
const REMOTE_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'api.anaconda.org',
]);

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validatedVersion(value: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(value)) throw new AppError('INVALID_TOOLCHAIN_VERSION', 'Managed toolchain version is invalid');
  return value;
}

function currentSubdir(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'linux' && arch === 'x64') return 'linux-64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-aarch64';
  if (platform === 'darwin' && arch === 'x64') return 'osx-64';
  if (platform === 'darwin' && arch === 'arm64') return 'osx-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-64';
  throw new AppError('MANAGED_PLATFORM_UNSUPPORTED', `Managed toolchains are not available for ${platform}-${arch}`);
}

function pixiAssetName(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'linux' && arch === 'x64') return 'pixi-x86_64-unknown-linux-musl';
  if (platform === 'linux' && arch === 'arm64') return 'pixi-aarch64-unknown-linux-musl';
  if (platform === 'darwin' && arch === 'x64') return 'pixi-x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'pixi-aarch64-apple-darwin';
  if (platform === 'win32' && arch === 'x64') return 'pixi-x86_64-pc-windows-msvc.exe';
  throw new AppError('MANAGED_PLATFORM_UNSUPPORTED', `Pixi is not available for ${platform}-${arch}`);
}

function assertRemoteUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError('MANAGED_DOWNLOAD_URL_INVALID', 'Managed download URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || !REMOTE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AppError('MANAGED_DOWNLOAD_URL_BLOCKED', `Managed downloads cannot use ${url.hostname || 'this URL'}`);
  }
  return url;
}

function cancelledError(): AppError {
  return new AppError('MANAGED_OPERATION_CANCELLED', 'Managed toolchain operation was cancelled');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
  });
}

async function withRemoteResponse<T>(
  raw: string,
  maxBytes: number,
  totalTimeoutMs: number,
  signal: AbortSignal | undefined,
  consume: (response: Response, controller: AbortController, declared: number) => Promise<T>,
): Promise<T> {
  let url = assertRemoteUrl(raw);
  const controller = new AbortController();
  let totalTimedOut = false;
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    totalTimedOut = true;
    controller.abort();
  }, totalTimeoutMs);
  try {
    throwIfAborted(signal);
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const response = await fetch(url, {
        redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json, application/json;q=0.9, */*;q=0.1', 'User-Agent': 'Research-IDE/0.1' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirect === 5) throw new AppError('MANAGED_DOWNLOAD_REDIRECT', 'Managed download returned an invalid redirect');
        url = assertRemoteUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok || !response.body) throw new AppError('MANAGED_DOWNLOAD_FAILED', `Managed download failed with HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('MANAGED_DOWNLOAD_TOO_LARGE', 'Managed download exceeds its size limit');
      return await consume(response, controller, declared);
    }
    throw new AppError('MANAGED_DOWNLOAD_REDIRECT', 'Managed download exceeded its redirect limit');
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    if (totalTimedOut) throw new AppError('MANAGED_DOWNLOAD_TIMEOUT', 'Managed download exceeded its time limit');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readRemoteChunks(
  response: Response,
  controller: AbortController,
  maxBytes: number,
  declared: number,
  onChunk: (value: Uint8Array) => Promise<void> | void,
  progress?: (value: number) => void,
): Promise<number> {
  const reader = response.body!.getReader();
  let total = 0;
  while (true) {
    let idleTimeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        idleTimeout = setTimeout(() => {
          controller.abort();
          reject(new AppError('MANAGED_DOWNLOAD_TIMEOUT', 'Managed download stopped making progress'));
        }, DOWNLOAD_IDLE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(idleTimeout));
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new AppError('MANAGED_DOWNLOAD_TOO_LARGE', 'Managed download exceeds its size limit');
    }
    await onChunk(result.value);
    if (progress && Number.isFinite(declared) && declared > 0) progress(Math.min(1, total / declared));
  }
  progress?.(1);
  return total;
}

async function requestJson(raw: string, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const bytes = await withRemoteResponse(raw, maxBytes, METADATA_TIMEOUT_MS, signal, async (response, controller, declared) => {
    const chunks: Uint8Array[] = [];
    const size = await readRemoteChunks(response, controller, maxBytes, declared, (chunk) => { chunks.push(chunk); });
    const value = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
    return value;
  });
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; }
  catch { throw new AppError('MANAGED_CATALOG_INVALID', 'Managed package catalog returned invalid JSON'); }
}

async function downloadFile(raw: string, target: string, maxBytes: number, progress: (value: number) => void, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
  return withRemoteResponse(raw, maxBytes, MANAGER_DOWNLOAD_TIMEOUT_MS, signal, async (response, controller, declared) => {
    const handle = await open(target, 'wx', 0o600);
    const digest = createHash('sha256');
    try {
      const size = await readRemoteChunks(response, controller, maxBytes, declared, async (chunk) => {
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (result.bytesWritten <= 0) throw new AppError('MANAGED_DOWNLOAD_FAILED', 'Managed download could not be written to disk');
          offset += result.bytesWritten;
        }
      }, progress);
      await flushFileHandle(handle);
      return { sha256: digest.digest('hex'), size };
    } finally {
      await handle.close();
    }
  });
}

function parseCatalogVersions(payload: unknown, subdir: string): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AppError('MANAGED_CATALOG_INVALID', 'Managed package catalog has an invalid shape');
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files)) throw new AppError('MANAGED_CATALOG_INVALID', 'Managed package catalog does not contain package files');
  const versions = new Set<string>();
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) continue;
    const item = file as { version?: unknown; attrs?: { subdir?: unknown }; labels?: unknown };
    if (item.attrs?.subdir !== subdir || typeof item.version !== 'string') continue;
    if (Array.isArray(item.labels) && item.labels.length && !item.labels.includes('main')) continue;
    try { versions.add(validatedVersion(item.version)); } catch { /* Ignore malformed upstream entries. */ }
  }
  return [...versions].sort((left, right) => right.localeCompare(left, 'en', { numeric: true, sensitivity: 'base' })).slice(0, 30);
}

function selectPixiAsset(payload: unknown, platform: NodeJS.Platform, arch: string): { version: string; asset: PixiReleaseAsset } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AppError('MANAGED_MANAGER_INVALID', 'Pixi release metadata is invalid');
  const release = payload as { tag_name?: unknown; assets?: unknown };
  const expectedName = pixiAssetName(platform, arch);
  const asset = Array.isArray(release.assets)
    ? release.assets.find((value): value is PixiReleaseAsset => Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as PixiReleaseAsset).name === expectedName))
    : undefined;
  const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/u, '') : '';
  if (!asset || !validatedVersion(version) || typeof asset.browser_download_url !== 'string' || typeof asset.digest !== 'string' || typeof asset.size !== 'number') {
    throw new AppError('MANAGED_MANAGER_UNAVAILABLE', `The verified Pixi asset ${expectedName} was not found`);
  }
  if (!/^sha256:[a-f0-9]{64}$/iu.test(asset.digest) || asset.size <= 0 || asset.size > MAX_MANAGER_BYTES) {
    throw new AppError('MANAGED_MANAGER_UNVERIFIED', 'Pixi release metadata does not provide an acceptable SHA-256 digest');
  }
  assertRemoteUrl(asset.browser_download_url);
  return { version, asset };
}

async function replaceFileWithinVerifiedParent(
  temporary: string,
  target: string,
  assertParent: () => Promise<void>,
): Promise<void> {
  await assertParent();
  try {
    await rename(temporary, target);
    await assertParent();
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
  }

  // Windows does not consistently replace an existing file with rename(). Move
  // the verified regular target aside first, while keeping every path in the
  // already-verified parent. Never recursively remove a path in this fallback.
  const targetInfo = await lstat(target).catch(() => undefined);
  if (!targetInfo?.isFile() || targetInfo.isSymbolicLink()) {
    throw new AppError('UNSAFE_MANAGED_PATH', 'Managed metadata replacement target is unsafe');
  }
  const backup = `${target}.${randomUUID()}.old`;
  await assertParent();
  await rename(target, backup);
  try {
    const backupInfo = await lstat(backup);
    if (!backupInfo.isFile() || backupInfo.isSymbolicLink() || backupInfo.dev !== targetInfo.dev || backupInfo.ino !== targetInfo.ino) {
      throw new AppError('UNSAFE_MANAGED_PATH', 'Managed metadata changed during replacement');
    }
    await assertParent();
    await rename(temporary, target);
    await assertParent();
    await rm(backup, { force: true, recursive: false });
  } catch (error) {
    if (!await lstat(target).catch(() => undefined)) await rename(backup, target).catch(() => undefined);
    throw error;
  }
}

async function atomicJson(target: string, value: unknown, assertParent: () => Promise<void>): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await assertParent();
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
      await flushFileHandle(handle);
    } finally {
      await handle.close();
    }
    await assertParent();
    await replaceFileWithinVerifiedParent(temporary, target, assertParent);
    await assertParent();
    await syncParentDirectory(target);
    await assertParent();
  } finally { await rm(temporary, { force: true }); }
}

async function sha256File(target: string): Promise<string> {
  const lexicalBefore = await lstat(target);
  if (!lexicalBefore.isFile() || lexicalBefore.isSymbolicLink()) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed executable file is unsafe');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(target, constants.O_RDONLY | noFollow);
  const digest = createHash('sha256');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== lexicalBefore.dev || before.ino !== lexicalBefore.ino) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed executable changed before hashing');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const lexicalAfter = await lstat(target);
    if (position !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || lexicalAfter.isSymbolicLink() || lexicalAfter.dev !== before.dev || lexicalAfter.ino !== before.ino) {
      throw new AppError('UNSAFE_MANAGED_PATH', 'Managed executable changed while hashing');
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

async function readRegularFile(target: string, maxBytes: number): Promise<Buffer> {
  const lexicalBefore = await lstat(target);
  if (!lexicalBefore.isFile() || lexicalBefore.isSymbolicLink() || lexicalBefore.size > maxBytes) {
    throw new AppError('UNSAFE_MANAGED_PATH', 'Managed metadata file is unsafe');
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(target, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes || before.dev !== lexicalBefore.dev || before.ino !== lexicalBefore.ino) {
      throw new AppError('UNSAFE_MANAGED_PATH', 'Managed metadata file changed before it was opened');
    }
    const value = await handle.readFile();
    const after = await handle.stat();
    const lexicalAfter = await lstat(target);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || lexicalAfter.isSymbolicLink() || lexicalAfter.dev !== before.dev || lexicalAfter.ino !== before.ino) {
      throw new AppError('UNSAFE_MANAGED_PATH', 'Managed metadata changed while it was read');
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function safeExecutable(target: string, root: string): Promise<string | undefined> {
  try {
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(target);
    if (!isInside(canonicalRoot, canonical) || !(await stat(canonical)).isFile()) return undefined;
    await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return canonical;
  } catch { return undefined; }
}

async function findExecutable(environmentRoot: string, managedRoot: string, definition: ManagedDefinition): Promise<string> {
  for (const relative of definition.relativeExecutables) {
    const found = await safeExecutable(path.join(environmentRoot, ...relative.split('/')), managedRoot);
    if (found) return found;
  }
  const queue: Array<{ directory: string; depth: number }> = [{ directory: environmentRoot, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const current = queue.shift()!;
    for (const entry of await readdir(current.directory, { withFileTypes: true }).catch(() => [])) {
      if (++visited > 50_000) throw new AppError('MANAGED_INSTALL_INVALID', 'Managed environment contains too many files');
      const candidate = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < 5) queue.push({ directory: candidate, depth: current.depth + 1 });
      else if ((entry.isFile() || entry.isSymbolicLink()) && definition.executablePattern.test(entry.name)) {
        const found = await safeExecutable(candidate, managedRoot);
        if (found) return found;
      }
    }
  }
  throw new AppError('MANAGED_EXECUTABLE_MISSING', `${definition.displayName} installed without a usable executable`);
}

export class ManagedToolchainService {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly subdir: string;
  private readonly options: ManagedToolchainOptions;
  private readonly operations = new Map<string, { kind: 'install' | 'remove'; promise: Promise<unknown> }>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly controllers = new Map<string, AbortController>();
  private pixiBootstrap?: Promise<{ path: string; version: string }>;
  private pixiBootstrapController?: AbortController;
  private readonly pixiProgressListeners = new Set<(value: number) => void>();
  private rootIdentity?: SafeDirectory;

  constructor(
    private readonly root: string,
    private readonly emit: (event: ManagedToolchainEvent) => void,
    options: ManagedToolchainOptions = {},
  ) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.subdir = currentSubdir(this.platform, this.arch);
  }

  async catalog(toolId: ProjectToolchainId, selectedExecutable?: string, signal?: AbortSignal): Promise<ManagedToolchainCatalog> {
    const definition = DEFINITIONS[toolId];
    if (!definition) throw new AppError('UNKNOWN_TOOL', 'Unknown managed toolchain');
    const root = await this.safeRoot();
    const catalogDirectory = (await this.safeChild(root, '.catalog', true))!;
    const installed = await this.installed(toolId);
    let versions: string[] = [];
    let warning: string | undefined;
    const cachePath = path.join(catalogDirectory.path, `${toolId}-${this.subdir}.json`);
    try {
      throwIfAborted(signal);
      const payload = await (this.options.requestJson ?? requestJson)(`https://api.anaconda.org/package/conda-forge/${definition.packageName}`, MAX_JSON_BYTES, signal);
      versions = parseCatalogVersions(payload, this.subdir);
      await this.assertDirectoryIdentity(catalogDirectory);
      await atomicJson(cachePath, { schemaVersion: 1, fetchedAt: this.now().toISOString(), payload }, () => this.assertDirectoryIdentity(catalogDirectory));
      await this.assertDirectoryIdentity(catalogDirectory);
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      try {
        await this.assertDirectoryIdentity(catalogDirectory);
        const cached = JSON.parse((await readRegularFile(cachePath, MAX_JSON_BYTES)).toString('utf8')) as { payload?: unknown };
        await this.assertDirectoryIdentity(catalogDirectory);
        versions = parseCatalogVersions(cached.payload, this.subdir);
        warning = '当前无法刷新 conda-forge 目录，正在显示缓存版本。';
      } catch {
        if (!installed.length) throw error;
        warning = '当前无法连接 conda-forge，仅显示已安装版本。';
      }
    }
    const allVersions = [...new Set([...versions, ...installed.map((item) => item.version)])];
    const values: ManagedToolchainVersion[] = allVersions.map((version) => {
      const local = installed.find((item) => item.version === version);
      return {
        version,
        installed: Boolean(local),
        selected: Boolean(local?.executablePath && selectedExecutable && path.resolve(local.executablePath) === path.resolve(selectedExecutable)),
        executablePath: local?.executablePath,
        installedAt: local?.installedAt,
      };
    });
    return {
      toolId, packageName: definition.packageName, source: 'conda-forge',
      sourceUrl: `https://anaconda.org/conda-forge/${definition.packageName}`,
      platform: this.subdir, versions: values, warning,
    };
  }

  install(toolId: ProjectToolchainId, versionValue: string): Promise<InstallRecord> {
    const version = validatedVersion(versionValue);
    const key = `${toolId}\0${version}`;
    const existing = this.operations.get(key);
    if (existing?.kind === 'install') return existing.promise as Promise<InstallRecord>;
    if (existing) return Promise.reject(new AppError('MANAGED_OPERATION_IN_PROGRESS', 'This managed toolchain version is being removed'));
    const operation = this.installOnce(toolId, version).finally(() => {
      if (this.operations.get(key)?.promise === operation) this.operations.delete(key);
    });
    this.operations.set(key, { kind: 'install', promise: operation });
    return operation;
  }

  async remove(toolId: ProjectToolchainId, versionValue: string): Promise<void> {
    const version = validatedVersion(versionValue);
    if (!DEFINITIONS[toolId]) throw new AppError('UNKNOWN_TOOL', 'Unknown managed toolchain');
    const key = `${toolId}\0${version}`;
    if (this.operations.has(key)) throw new AppError('MANAGED_OPERATION_IN_PROGRESS', 'This managed toolchain version is currently in use by another operation');
    const operation = this.removeOnce(toolId, version).finally(() => {
      if (this.operations.get(key)?.promise === operation) this.operations.delete(key);
    });
    this.operations.set(key, { kind: 'remove', promise: operation });
    return operation;
  }

  private async removeOnce(toolId: ProjectToolchainId, version: string): Promise<void> {
    const record = await this.readInstallRecord(toolId, version);
    if (!record) throw new AppError('MANAGED_VERSION_NOT_INSTALLED', 'Managed toolchain version is not installed');
    const root = await this.safeRoot();
    const toolDirectory = await this.safeChild(root, toolId, false);
    const versionDirectory = toolDirectory ? await this.safeChild(toolDirectory, version, false) : undefined;
    if (!toolDirectory || !versionDirectory) throw new AppError('MANAGED_VERSION_NOT_INSTALLED', 'Managed toolchain version is not installed');
    await this.removeDirectory(versionDirectory, toolDirectory);
  }

  async installed(toolId: ProjectToolchainId): Promise<ManagedToolchainVersion[]> {
    const root = await this.safeRoot();
    const directory = await this.safeChild(root, toolId, false);
    if (!directory) return [];
    const entries = await readdir(directory.path, { withFileTypes: true });
    const result: ManagedToolchainVersion[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let version: string;
      try { version = validatedVersion(entry.name); } catch { continue; }
      if (!await this.safeChild(directory, version, false)) continue;
      const record = await this.readInstallRecord(toolId, version);
      if (!record) continue;
      const executablePath = await this.recordExecutable(record);
      if (!executablePath) continue;
      result.push({ version, installed: true, selected: false, executablePath, installedAt: record.installedAt });
    }
    return result.sort((left, right) => right.version.localeCompare(left.version, 'en', { numeric: true }));
  }

  async verifyExecutable(relativePath: string): Promise<{ executable: string; sha256: string }> {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed executable path is invalid');
    const portable = relativePath.replaceAll('\\', '/');
    const [toolValue, version] = portable.split('/');
    if (!Object.hasOwn(DEFINITIONS, toolValue) || !version) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed executable is not registered');
    const toolId = toolValue as ProjectToolchainId;
    const record = await this.readInstallRecord(toolId, validatedVersion(version));
    if (!record || record.executable !== portable) throw new AppError('MANAGED_INSTALL_INVALID', 'Managed executable does not match its install record');
    const executable = await this.recordExecutable(record);
    if (!executable) throw new AppError('MANAGED_INSTALL_CHANGED', 'Managed executable changed after installation; reinstall this version');
    return { executable, sha256: record.executableSha256 };
  }

  async activationEnvironment(relativeExecutable: string): Promise<NodeJS.ProcessEnv> {
    if (!relativeExecutable || path.isAbsolute(relativeExecutable) || relativeExecutable.includes('\0')) {
      throw new AppError('UNSAFE_MANAGED_PATH', 'Managed executable path is invalid');
    }
    const portable = relativeExecutable.replaceAll('\\', '/');
    const segments = portable.split('/');
    const toolValue = segments[0];
    const version = segments[1];
    if (!Object.hasOwn(DEFINITIONS, toolValue) || !version) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed executable is not registered');
    const toolId = toolValue as ProjectToolchainId;
    const record = await this.readInstallRecord(toolId, validatedVersion(version));
    if (!record || record.executable !== portable) throw new AppError('MANAGED_INSTALL_INVALID', 'Managed executable does not match its install record');
    const executable = await this.recordExecutable(record);
    if (!executable) throw new AppError('MANAGED_INSTALL_CHANGED', 'Managed executable changed after installation; reinstall this version');

    const root = await this.safeRoot();
    const toolDirectory = await this.safeChild(root, toolId, false);
    const versionDirectory = toolDirectory ? await this.safeChild(toolDirectory, version, false) : undefined;
    const pixiDirectory = versionDirectory ? await this.safeChild(versionDirectory, '.pixi', false) : undefined;
    const envsDirectory = pixiDirectory ? await this.safeChild(pixiDirectory, 'envs', false) : undefined;
    const environmentDirectory = envsDirectory ? await this.safeChild(envsDirectory, 'default', false) : undefined;
    if (!toolDirectory || !versionDirectory || !pixiDirectory || !envsDirectory || !environmentDirectory || !isInside(environmentDirectory.canonical, executable)) {
      throw new AppError('MANAGED_INSTALL_INVALID', 'Managed environment directory is missing or unsafe');
    }

    const pathDirectories: SafeDirectory[] = [];
    const addPath = (directory: SafeDirectory | undefined): void => {
      if (directory && !pathDirectories.some((value) => value.canonical === directory.canonical)) pathDirectories.push(directory);
    };
    const executableDirectory = await this.inspectContainedDirectory(path.dirname(executable), environmentDirectory);
    addPath(executableDirectory);
    if (this.platform === 'win32') {
      addPath(environmentDirectory);
      addPath(await this.safeNestedDirectory(environmentDirectory, ['Scripts']));
      addPath(await this.safeNestedDirectory(environmentDirectory, ['Library', 'bin']));
      addPath(await this.safeNestedDirectory(environmentDirectory, ['Library', 'usr', 'bin']));
      addPath(await this.safeNestedDirectory(environmentDirectory, ['Library', 'mingw-w64', 'bin']));
      addPath(await this.safeNestedDirectory(environmentDirectory, ['bin']));
    } else {
      addPath(await this.safeNestedDirectory(environmentDirectory, ['bin']));
    }
    if (!pathDirectories.length) throw new AppError('MANAGED_INSTALL_INVALID', 'Managed environment has no verified executable directory');
    for (const directory of [root, toolDirectory, versionDirectory, pixiDirectory, envsDirectory, environmentDirectory, ...pathDirectories]) {
      await this.assertDirectoryIdentity(directory);
    }
    return {
      PATH: pathDirectories.map((directory) => directory.canonical).join(path.delimiter),
      CONDA_PREFIX: environmentDirectory.canonical,
      CONDA_DEFAULT_ENV: `research-ide-${toolId}-${version}`,
      CONDA_SHLVL: '1',
    };
  }

  async stopAll(): Promise<void> {
    this.pixiBootstrapController?.abort();
    for (const controller of this.controllers.values()) controller.abort();
    for (const child of this.children.values()) signalProcessTree(child, 'SIGTERM');
    const operations = [...this.operations.values()].map((value) => value.promise);
    if (this.pixiBootstrap) operations.push(this.pixiBootstrap);
    await Promise.allSettled(operations);
    for (const child of this.children.values()) if (processTreeAlive(child)) signalProcessTree(child, 'SIGKILL', true);
  }

  private async installOnce(toolId: ProjectToolchainId, version: string): Promise<InstallRecord> {
    const definition = DEFINITIONS[toolId];
    const operationId = randomUUID();
    const controller = new AbortController();
    this.controllers.set(operationId, controller);
    const send = (phase: ManagedToolchainEvent['phase'], message: string, progress?: number): void => this.emit({ operationId, toolId, version, phase, message, progress });
    let toolDirectory: SafeDirectory | undefined;
    let versionDirectory: SafeDirectory | undefined;
    send('preparing', `准备 ${definition?.displayName ?? toolId} ${version}`);
    try {
      if (!definition) throw new AppError('UNKNOWN_TOOL', 'Unknown managed toolchain');
      throwIfAborted(controller.signal);
      const catalog = await this.catalog(toolId, undefined, controller.signal);
      if (!catalog.versions.some((item) => item.version === version)) throw new AppError('MANAGED_VERSION_UNAVAILABLE', 'The selected managed version is not present in the verified catalog');
      const existing = await this.readInstallRecord(toolId, version);
      if (existing && await this.recordExecutable(existing)) {
        send('validating', '已验证本地受管工具');
        send('completed', `${definition.displayName} ${version} 已安装`);
        return existing;
      }
      const root = await this.safeRoot();
      const createdToolDirectory = (await this.safeChild(root, toolId, true))!;
      toolDirectory = createdToolDirectory;
      const incomplete = await this.safeChild(createdToolDirectory, version, false);
      if (incomplete) await this.removeDirectory(incomplete, createdToolDirectory);
      const createdVersionDirectory = (await this.safeChild(createdToolDirectory, version, true))!;
      versionDirectory = createdVersionDirectory;
      const directory = createdVersionDirectory.path;
      const pixiStateDirectory = (await this.safeChild(createdVersionDirectory, '.pixi', true))!;
      const envsDirectory = (await this.safeChild(pixiStateDirectory, 'envs', true))!;
      const pixiHome = (await this.safeChild(root, '.pixi-home', true))!;
      const cache = (await this.safeChild(root, '.cache', true))!;
      const pixi = await this.getPixiShared((progress) => send('downloading-manager', '正在下载并校验 Pixi 管理器', progress), controller.signal);
      throwIfAborted(controller.signal);
      const manifestPath = path.join(directory, 'pixi.toml');
      const workspaceName = `research-ide-${toolId}-${version}`.replace(/[^0-9A-Za-z_-]/gu, '-');
      const manifest = `[workspace]\nname = ${JSON.stringify(workspaceName)}\nchannels = ["conda-forge"]\nplatforms = [${JSON.stringify(this.subdir)}]\n\n[dependencies]\n${definition.packageName} = ${JSON.stringify(`==${version}`)}\n`;
      await this.assertDirectoryIdentity(createdVersionDirectory);
      await writeFile(manifestPath, manifest, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.assertDirectoryIdentity(createdVersionDirectory);
      send('resolving', `正在解析 ${definition.packageName} ${version}`);
      const env = this.managerEnvironment(directory);
      send('installing', `正在下载并安装 ${definition.displayName} ${version}`);
      const result = await this.run(operationId, pixi.path, ['install', '--manifest-path', manifestPath, '--no-config'], directory, env, MANAGER_TIMEOUT_MS, controller.signal);
      if (result.code !== 0) throw new AppError('MANAGED_INSTALL_FAILED', (result.stderr || result.stdout || 'Pixi installation failed').slice(-4_000));
      throwIfAborted(controller.signal);
      await this.assertDirectoryIdentity(root);
      await this.assertDirectoryIdentity(createdToolDirectory);
      await this.assertDirectoryIdentity(createdVersionDirectory);
      await this.assertDirectoryIdentity(pixiStateDirectory);
      await this.assertDirectoryIdentity(envsDirectory);
      await this.assertDirectoryIdentity(pixiHome);
      await this.assertDirectoryIdentity(cache);
      send('validating', '正在验证受管工具可执行文件');
      const environmentDirectory = await this.safeChild(envsDirectory, 'default', false);
      if (!environmentDirectory) throw new AppError('MANAGED_INSTALL_INVALID', 'Pixi did not create a verified default environment');
      const executable = await findExecutable(environmentDirectory.path, environmentDirectory.path, definition);
      const digest = await sha256File(executable);
      const record: InstallRecord = {
        schemaVersion: 1, toolId, packageName: definition.packageName, version, platform: this.subdir,
        executable: path.relative(root.canonical, executable).split(path.sep).join('/'), executableSha256: digest,
        installedAt: this.now().toISOString(), manager: { name: 'pixi', version: pixi.version },
      };
      if (!record.executable.startsWith(`${toolId}/${version}/`)) throw new AppError('MANAGED_INSTALL_INVALID', 'Managed executable resolved outside its version directory');
      await atomicJson(path.join(directory, 'install.json'), record, () => this.assertDirectoryIdentity(createdVersionDirectory));
      await this.assertDirectoryIdentity(createdVersionDirectory);
      await this.assertDirectoryIdentity(environmentDirectory);
      send('completed', `${definition.displayName} ${version} 已安装`);
      return record;
    } catch (error) {
      if (versionDirectory && toolDirectory) await this.removeDirectory(versionDirectory, toolDirectory).catch(() => undefined);
      send('failed', error instanceof Error ? error.message : '安装失败');
      throw error;
    } finally {
      if (this.controllers.get(operationId) === controller) this.controllers.delete(operationId);
    }
  }

  private async getPixiShared(progress: (value: number) => void, signal: AbortSignal): Promise<{ path: string; version: string }> {
    throwIfAborted(signal);
    this.pixiProgressListeners.add(progress);
    if (!this.pixiBootstrap) {
      const controller = new AbortController();
      this.pixiBootstrapController = controller;
      const operation = this.getPixi((value) => {
        for (const listener of this.pixiProgressListeners) listener(value);
      }, controller.signal).finally(() => {
        if (this.pixiBootstrap === operation) {
          this.pixiBootstrap = undefined;
          this.pixiBootstrapController = undefined;
        }
      });
      this.pixiBootstrap = operation;
    }
    const bootstrap = this.pixiBootstrap;
    if (!bootstrap) throw new AppError('MANAGED_MANAGER_UNAVAILABLE', 'Pixi bootstrap did not start');
    try {
      return await waitWithAbort(bootstrap, signal);
    } finally {
      this.pixiProgressListeners.delete(progress);
      if (!this.pixiProgressListeners.size) this.pixiBootstrapController?.abort();
    }
  }

  private async getPixi(progress: (value: number) => void, signal: AbortSignal): Promise<{ path: string; version: string }> {
    throwIfAborted(signal);
    if (this.options.pixiExecutable) {
      const pixi = await this.options.pixiExecutable(signal);
      return { path: pixi.path, version: validatedVersion(pixi.version) };
    }
    const root = await this.safeRoot();
    const managerDirectory = (await this.safeChild(root, '.manager', true))!;
    const managerRoot = managerDirectory.path;
    const recordPath = path.join(managerRoot, 'current.json');
    try {
      await this.assertDirectoryIdentity(managerDirectory);
      const record = JSON.parse((await readRegularFile(recordPath, 64 * 1024)).toString('utf8')) as PixiRecord;
      const recordVersion = validatedVersion(record.version);
      const executableName = this.platform === 'win32' ? 'pixi.exe' : 'pixi';
      const expectedRelative = `${recordVersion}/${executableName}`;
      if (record.schemaVersion === 1 && record.executable === expectedRelative && /^[a-f0-9]{64}$/u.test(record.sha256)) {
        const versionDirectory = await this.safeChild(managerDirectory, recordVersion, false);
        const executable = versionDirectory ? await safeExecutable(path.join(managerRoot, ...record.executable.split('/')), versionDirectory.path) : undefined;
        if (executable && await sha256File(executable) === record.sha256) {
          await this.assertDirectoryIdentity(managerDirectory);
          await this.assertDirectoryIdentity(versionDirectory!);
          return { path: executable, version: recordVersion };
        }
      }
    } catch { /* Download a verified manager below. */ }
    throwIfAborted(signal);
    const payload = await (this.options.requestJson ?? requestJson)('https://api.github.com/repos/prefix-dev/pixi/releases/latest', MAX_JSON_BYTES, signal);
    const { version, asset } = selectPixiAsset(payload, this.platform, this.arch);
    const versionDirectory = (await this.safeChild(managerDirectory, version, true))!;
    const versionRoot = versionDirectory.path;
    const executableName = this.platform === 'win32' ? 'pixi.exe' : 'pixi';
    const temporary = path.join(versionRoot, `${executableName}.${randomUUID()}.tmp`);
    try {
      const downloaded = await (this.options.download ?? downloadFile)(asset.browser_download_url, temporary, MAX_MANAGER_BYTES, progress, signal);
      throwIfAborted(signal);
      const expected = asset.digest.slice('sha256:'.length).toLowerCase();
      if (downloaded.sha256.toLowerCase() !== expected || downloaded.size !== asset.size) throw new AppError('MANAGED_MANAGER_DIGEST_MISMATCH', 'Pixi download did not match its GitHub release digest');
      if (this.platform !== 'win32') await chmod(temporary, 0o700);
      const executable = path.join(versionRoot, executableName);
      const current = await lstat(executable).catch(() => undefined);
      if (current?.isSymbolicLink() || (current && !current.isFile())) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed Pixi executable path is unsafe');
      await this.assertDirectoryIdentity(managerDirectory);
      await this.assertDirectoryIdentity(versionDirectory);
      if (current) await rm(executable, { force: true });
      await rename(temporary, executable);
      await syncParentDirectory(executable);
      const record: PixiRecord = { schemaVersion: 1, version, executable: path.relative(managerRoot, executable).split(path.sep).join('/'), sha256: expected };
      await atomicJson(recordPath, record, () => this.assertDirectoryIdentity(managerDirectory));
      await this.assertDirectoryIdentity(managerDirectory);
      await this.assertDirectoryIdentity(versionDirectory);
      return { path: executable, version };
    } finally { await rm(temporary, { force: true }); }
  }

  private async run(operationId: string, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<ProcessResult> {
    throwIfAborted(signal);
    if (this.options.runCommand) {
      const result = await this.options.runCommand(executable, args, cwd, env, timeoutMs, signal);
      throwIfAborted(signal);
      return result;
    }
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env, shell: false, detached: detachedProcessGroup(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.set(operationId, child);
      let stdout = '';
      let stderr = '';
      const append = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-MAX_PROCESS_OUTPUT);
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      let settled = false;
      let failure: Error | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let terminationTimer: NodeJS.Timeout | undefined;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceTimer);
        clearTimeout(terminationTimer);
        signal.removeEventListener('abort', onAbort);
        this.children.delete(operationId);
        callback();
      };
      const terminate = (error: Error): void => {
        if (settled || failure) return;
        failure = error;
        signalProcessTree(child, 'SIGTERM');
        forceTimer = setTimeout(() => {
          if (processTreeAlive(child)) signalProcessTree(child, 'SIGKILL', true);
        }, PROCESS_TERMINATION_GRACE_MS);
        terminationTimer = setTimeout(() => {
          if (processTreeAlive(child)) signalProcessTree(child, 'SIGKILL', true);
          finish(() => reject(failure!));
        }, PROCESS_TERMINATION_LIMIT_MS);
      };
      const onAbort = (): void => terminate(cancelledError());
      const timeout = setTimeout(() => {
        terminate(new AppError('MANAGED_INSTALL_TIMEOUT', 'Managed toolchain installation timed out'));
      }, timeoutMs);
      child.once('error', (error) => finish(() => reject(error)));
      child.once('exit', (code) => finish(() => {
        if (failure) reject(failure);
        else resolve({ code, stdout, stderr });
      }));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private managerEnvironment(installRoot: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PATHEXT', 'COMSPEC', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return {
      ...env,
      PIXI_HOME: path.join(this.root, '.pixi-home'),
      PIXI_CACHE_DIR: path.join(this.root, '.cache'),
      // Pixi exposes these environment settings as typed booleans. Current
      // releases pass their values through clap, where "1"/"0" are rejected.
      PIXI_NO_PROGRESS: 'true',
      PIXI_NO_CONFIG: 'true',
      // Do not set PIXI_NO_SYMBOLIC_LINKS. Pixi 0.72.x defines that option as
      // "disallow symbolic links", but conda packages such as ICU legitimately
      // contain directory links. Pixi validates package links while extracting;
      // our own executable and activation checks additionally require every
      // resolved path to remain inside the verified managed environment.
      PIXI_TLS_ROOT_CERTS: 'system',
      RESEARCH_IDE_MANAGED_PREFIX: installRoot,
    };
  }

  private async readInstallRecord(toolId: ProjectToolchainId, version: string): Promise<InstallRecord | undefined> {
    const root = await this.safeRoot();
    const toolDirectory = await this.safeChild(root, toolId, false);
    const versionDirectory = toolDirectory ? await this.safeChild(toolDirectory, validatedVersion(version), false) : undefined;
    if (!toolDirectory || !versionDirectory) return undefined;
    const target = path.join(versionDirectory.path, 'install.json');
    try {
      await this.assertDirectoryIdentity(versionDirectory);
      const value = JSON.parse((await readRegularFile(target, 64 * 1024)).toString('utf8')) as InstallRecord;
      if (value.schemaVersion !== 1 || value.toolId !== toolId || value.version !== version || value.packageName !== DEFINITIONS[toolId].packageName || value.platform !== this.subdir) return undefined;
      if (!/^[a-f0-9]{64}$/u.test(value.executableSha256) || typeof value.executable !== 'string' || !value.executable.startsWith(`${toolId}/${version}/`)
        || path.posix.isAbsolute(value.executable) || value.executable.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return undefined;
      if (value.manager?.name !== 'pixi' || validatedVersion(value.manager.version) !== value.manager.version || typeof value.installedAt !== 'string' || !Number.isFinite(Date.parse(value.installedAt))) return undefined;
      await this.assertDirectoryIdentity(root);
      await this.assertDirectoryIdentity(toolDirectory);
      await this.assertDirectoryIdentity(versionDirectory);
      return value;
    } catch { return undefined; }
  }

  private async recordExecutable(record: InstallRecord): Promise<string | undefined> {
    const root = await this.safeRoot();
    const toolDirectory = await this.safeChild(root, record.toolId, false);
    const versionDirectory = toolDirectory ? await this.safeChild(toolDirectory, validatedVersion(record.version), false) : undefined;
    if (!toolDirectory || !versionDirectory) return undefined;
    const target = path.join(this.root, ...record.executable.split('/'));
    const executable = await safeExecutable(target, versionDirectory.path);
    if (!executable || await sha256File(executable) !== record.executableSha256) return undefined;
    await this.assertDirectoryIdentity(root);
    await this.assertDirectoryIdentity(toolDirectory);
    await this.assertDirectoryIdentity(versionDirectory);
    return executable;
  }

  private async inspectContainedDirectory(target: string, root: SafeDirectory): Promise<SafeDirectory> {
    await this.assertDirectoryIdentity(root);
    const directory = await this.inspectDirectory(target);
    if (!isInside(root.canonical, directory.canonical)) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed environment directory resolves outside its verified root');
    await this.assertDirectoryIdentity(root);
    return directory;
  }

  private async safeNestedDirectory(root: SafeDirectory, segments: string[]): Promise<SafeDirectory | undefined> {
    let current: SafeDirectory | undefined = root;
    for (const segment of segments) {
      current = current ? await this.safeChild(current, segment, false) : undefined;
      if (!current) return undefined;
    }
    await this.assertDirectoryIdentity(root);
    return current;
  }

  private async safeRoot(): Promise<SafeDirectory> {
    if (this.rootIdentity) {
      await this.assertDirectoryIdentity(this.rootIdentity);
      return this.rootIdentity;
    }
    const target = path.resolve(this.root);
    const parent = await realpath(path.dirname(target)).catch(() => {
      throw new AppError('UNSAFE_MANAGED_PATH', 'The Research IDE user-data directory is unavailable');
    });
    try { await mkdir(target, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const identity = await this.inspectDirectory(target);
    if (path.dirname(identity.canonical) !== parent) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed toolchain root resolves outside the application data directory');
    if (this.platform !== 'win32') await chmod(identity.path, 0o700);
    await this.assertDirectoryIdentity(identity);
    this.rootIdentity = identity;
    return identity;
  }

  private async safeChild(parent: SafeDirectory, name: string, create: boolean): Promise<SafeDirectory | undefined> {
    if (!/^[0-9A-Za-z._+-]{1,128}$/u.test(name) || name === '.' || name === '..') throw new AppError('UNSAFE_MANAGED_PATH', 'Managed directory name is invalid');
    await this.assertDirectoryIdentity(parent);
    const target = path.join(parent.path, name);
    if (create) {
      try { await mkdir(target, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    let identity: SafeDirectory;
    try { identity = await this.inspectDirectory(target); }
    catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (path.dirname(identity.canonical) !== parent.canonical) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed directory resolves outside its verified parent');
    if (create && this.platform !== 'win32') await chmod(identity.path, 0o700);
    await this.assertDirectoryIdentity(identity);
    await this.assertDirectoryIdentity(parent);
    return identity;
  }

  private async inspectDirectory(target: string): Promise<SafeDirectory> {
    const lexical = await lstat(target);
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed toolchain directories must be real directories');
    const canonical = await realpath(target);
    const resolved = await stat(canonical);
    if (!resolved.isDirectory() || resolved.dev !== lexical.dev || resolved.ino !== lexical.ino) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed toolchain directory identity changed during validation');
    return { path: path.resolve(target), canonical, device: lexical.dev, inode: lexical.ino };
  }

  private async assertDirectoryIdentity(identity: SafeDirectory): Promise<void> {
    const current = await lstat(identity.path).catch(() => undefined);
    if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== identity.device || current.ino !== identity.inode) {
      throw new AppError('UNSAFE_MANAGED_PATH', 'Managed toolchain directory changed during the operation');
    }
    if (await realpath(identity.path) !== identity.canonical) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed toolchain directory now resolves elsewhere');
  }

  private async removeDirectory(identity: SafeDirectory, parent: SafeDirectory): Promise<void> {
    await this.assertDirectoryIdentity(parent);
    await this.assertDirectoryIdentity(identity);
    if (path.dirname(identity.canonical) !== parent.canonical) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed removal target is outside its verified parent');
    const tombstonePath = path.join(parent.path, `.delete-${randomUUID()}`);
    if (await lstat(tombstonePath).catch(() => undefined)) throw new AppError('UNSAFE_MANAGED_PATH', 'Managed removal staging path already exists');
    await rename(identity.path, tombstonePath);
    const tombstone = await this.inspectDirectory(tombstonePath);
    if (tombstone.device !== identity.device || tombstone.inode !== identity.inode || path.dirname(tombstone.canonical) !== parent.canonical) {
      throw new AppError('UNSAFE_MANAGED_PATH', 'Managed removal target changed before deletion');
    }
    await this.assertDirectoryIdentity(parent);
    await this.assertDirectoryIdentity(tombstone);
    await rm(tombstone.path, { recursive: true, force: true });
    await this.assertDirectoryIdentity(parent);
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
}

export const managedToolchainInternals = {
  definitions: DEFINITIONS,
  currentSubdir,
  parseCatalogVersions,
  pixiAssetName,
  selectPixiAsset,
  validatedVersion,
};
