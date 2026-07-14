import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mammoth from 'mammoth';
import type { DocxCompatibilityWarning, DocxOpenResult, DocxSaveRequest, DocxSaveResult } from '../shared/types';
import { createDocxBuffer, openDocxBuffer } from './docx-service';
import { AppError } from './errors';
import { flushFileHandle, syncParentDirectory } from './file-durability';
import { detachedProcessGroup, processTreeAlive, signalProcessTree } from './process-tree';
import type { ProjectService } from './project-service';
import type { SnapshotService } from './snapshot-service';

const MAX_LEGACY_DOC_BYTES = 100 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 45_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const OLE_COMPOUND_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

type WordFormat = 'doc' | 'docx';

interface ObservedLegacyDoc {
  hash: string;
  warnings: DocxCompatibilityWarning[];
  readOnly: boolean;
}

export interface LegacyDocConverter {
  convert(input: Buffer, from: WordFormat, to: WordFormat): Promise<Buffer>;
  dispose?(): void;
}

export interface LibreOfficeConverterOptions {
  /** A user-confirmed executable checked before the fixed trusted locations. */
  resolveExecutable?: () => Promise<string | undefined>;
  timeoutMs?: number;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeDiagnostic(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('')
    .trim()
    .slice(-2_000);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function executableFile(candidate: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path.resolve(candidate));
    const info = await stat(canonical);
    if (!info.isFile()) return undefined;
    await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return canonical;
  } catch {
    return undefined;
  }
}

function systemLibreOfficeCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/Applications/LibreOffice.app/Contents/MacOS/LibreOffice',
    ];
  }
  if (platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((value): value is string => Boolean(value));
    return roots.flatMap((root) => [
      path.join(root, 'LibreOffice', 'program', 'soffice.exe'),
      path.join(root, 'LibreOffice', 'program', 'soffice.com'),
    ]);
  }
  return [
    '/usr/bin/libreoffice',
    '/usr/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
    '/usr/lib64/libreoffice/program/soffice',
    '/usr/local/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/snap/bin/libreoffice',
    '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice',
    '/run/current-system/sw/bin/libreoffice',
  ];
}

function managedLibreOfficeCandidates(userDataPath: string, platform: NodeJS.Platform = process.platform, installation = 'current'): string[] {
  const root = path.join(userDataPath, 'toolchains', 'libreoffice', installation);
  if (platform === 'darwin') {
    return [
      path.join(root, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
      path.join(root, 'program', 'soffice'),
    ];
  }
  if (platform === 'win32') return [path.join(root, 'program', 'soffice.exe'), path.join(root, 'program', 'soffice.com')];
  return [path.join(root, 'program', 'soffice'), path.join(root, 'soffice'), path.join(root, 'AppRun')];
}

const LOCKED_DOWN_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Common/Load">
    <prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop>
  </item>
</oor:items>
`;

/**
 * A deliberately narrow LibreOffice adapter for the old binary Word format.
 * It never opens the project file itself: callers provide bytes and receive
 * bytes, while all converter-visible paths live in an isolated userData job.
 */
export class LibreOfficeConverter implements LegacyDocConverter {
  private readonly active = new Set<ChildProcess>();
  private disposed = false;

  constructor(
    private readonly userDataPath: string,
    private readonly options: LibreOfficeConverterOptions = {},
  ) {}

  async convert(input: Buffer, from: WordFormat, to: WordFormat): Promise<Buffer> {
    if (this.disposed) throw new AppError('LIBREOFFICE_STOPPED', 'The document converter is shutting down');
    if (from === to) throw new AppError('INVALID_DOC_CONVERSION', 'Source and destination Word formats must differ');
    if (!Buffer.isBuffer(input) || !input.byteLength || input.byteLength > MAX_LEGACY_DOC_BYTES) {
      throw new AppError('FILE_TOO_LARGE', 'Legacy Word files must be non-empty and no larger than 100 MB');
    }
    // The optional resolver is the explicit user-trust seam. An absent custom
    // selection falls through to the fixed system/app-managed locations; a
    // rejected or changed selection throws and therefore never falls through.
    const executable = await this.availableExecutable();
    if (!executable) {
      throw new AppError(
        'LIBREOFFICE_NOT_FOUND',
        '无法打开 DOC：本机未找到 LibreOffice。请先安装 LibreOffice，或在“设置 → 工具链 → 旧版 Word 转换器”中选择可信的 soffice/libreoffice 可执行文件，然后重新打开文档。',
      );
    }
    const job = await this.createJobDirectory();
    try {
      const inputPath = path.join(job, `source.${from}`);
      const outputPath = path.join(job, `source.${to}`);
      const profile = path.join(job, 'profile');
      await mkdir(path.join(profile, 'user'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), LOCKED_DOWN_PROFILE, { mode: 0o600, flag: 'wx' });
      await writeFile(inputPath, input, { mode: 0o600, flag: 'wx' });
      const outputFilter = to === 'docx' ? 'docx:Office Open XML Text' : 'doc:MS Word 97';
      const args = [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless', '--invisible', '--nologo', '--nodefault', '--nofirststartwizard', '--nolockcheck', '--norestore',
        '--convert-to', outputFilter, '--outdir', job, inputPath,
      ];
      const diagnostics = await this.run(executable, args, job);
      const info = await lstat(outputPath).catch(() => undefined);
      if (!info || info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_LEGACY_DOC_BYTES) {
        throw new AppError(
          'LIBREOFFICE_CONVERSION_FAILED',
          `LibreOffice 未生成有效的 .${to} 文件。${diagnostics ? `转换器信息：${diagnostics}` : '请确认所选文件确实是 LibreOffice 的 soffice 可执行程序。'}`,
        );
      }
      const canonicalOutput = await realpath(outputPath);
      const canonicalJob = await realpath(job);
      if (!isInside(canonicalJob, canonicalOutput)) throw new AppError('UNSAFE_CONVERSION_OUTPUT', 'LibreOffice conversion output escaped its isolated directory');
      return await readFile(canonicalOutput);
    } finally {
      await rm(job, { recursive: true, force: true });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.active) {
      signalProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        if (processTreeAlive(child)) signalProcessTree(child, 'SIGKILL', true);
      }, 1_500).unref();
    }
  }

  /** Resolve the exact executable that a conversion would use. */
  async availableExecutable(): Promise<string | undefined> {
    // A saved custom selection is fully revalidated by its resolver. Invalid
    // or replaced selections deliberately throw instead of silently changing
    // converter underneath the user.
    const selectedExecutable = await this.options.resolveExecutable?.();
    if (selectedExecutable) return executableFile(selectedExecutable);
    return this.resolveSystemOrManagedExecutable();
  }

  private async resolveSystemOrManagedExecutable(): Promise<string | undefined> {
    // Fixed OS locations are checked before the app-managed installation.  We
    // intentionally do not execute an arbitrary same-name program inherited
    // from PATH or from the active project.
    for (const candidate of systemLibreOfficeCandidates()) {
      const executable = await executableFile(candidate);
      if (executable) return executable;
    }
    const managedRootLexical = path.join(this.userDataPath, 'toolchains', 'libreoffice');
    const managedRoot = await realpath(managedRootLexical).catch(() => undefined);
    if (!managedRoot) return undefined;
    const entries = await readdir(managedRootLexical, { withFileTypes: true }).catch(() => []);
    const installations = [
      'current',
      ...entries
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== 'current' && /^[a-z0-9._-]{1,128}$/iu.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, 'en-US', { numeric: true })),
    ];
    for (const installation of installations) {
      for (const candidate of managedLibreOfficeCandidates(this.userDataPath, process.platform, installation)) {
        const executable = await executableFile(candidate);
        if (executable && isInside(managedRoot, executable)) return executable;
      }
    }
    return undefined;
  }

  private async createJobDirectory(): Promise<string> {
    await mkdir(this.userDataPath, { recursive: true, mode: 0o700 });
    const canonicalUserData = await realpath(this.userDataPath);
    const workRootLexical = path.join(canonicalUserData, 'legacy-doc-work');
    const existing = await lstat(workRootLexical).catch(() => undefined);
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
      throw new AppError('UNSAFE_CONVERSION_DIRECTORY', 'The legacy document work directory is not a safe directory');
    }
    await mkdir(workRootLexical, { recursive: true, mode: 0o700 });
    const workRoot = await realpath(workRootLexical);
    if (!isInside(canonicalUserData, workRoot)) throw new AppError('UNSAFE_CONVERSION_DIRECTORY', 'The legacy document work directory escapes application data');
    const job = await mkdtemp(path.join(workRoot, 'job-'));
    const info = await lstat(job);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError('UNSAFE_CONVERSION_DIRECTORY', 'Could not create an isolated conversion directory');
    const canonicalJob = await realpath(job);
    if (!isInside(workRoot, canonicalJob)) throw new AppError('UNSAFE_CONVERSION_DIRECTORY', 'The isolated conversion directory escaped application data');
    return canonicalJob;
  }

  private async run(executable: string, args: string[], cwd: string): Promise<string> {
    const executableDirectory = path.dirname(executable);
    const systemPath = process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32')
      : '/usr/bin:/bin';
    const env: NodeJS.ProcessEnv = {
      PATH: [executableDirectory, systemPath].join(path.delimiter),
      HOME: cwd,
      USERPROFILE: cwd,
      TMPDIR: cwd,
      TMP: cwd,
      TEMP: cwd,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION: '1',
      OOO_DISABLE_RECOVERY: '1',
      http_proxy: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      ftp_proxy: 'http://127.0.0.1:9',
      all_proxy: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      FTP_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '',
    };
    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        detached: detachedProcessGroup(),
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.active.add(child);
      let outputBytes = 0;
      let diagnosticTail = '';
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;
      const timers: { timeout?: NodeJS.Timeout; terminate?: NodeJS.Timeout; failure?: NodeJS.Timeout } = {};
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timers.timeout) clearTimeout(timers.timeout);
        if (timers.terminate) clearTimeout(timers.terminate);
        if (timers.failure) clearTimeout(timers.failure);
        this.active.delete(child);
        callback();
      };
      const capture = (chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        diagnosticTail = `${diagnosticTail}${chunk.toString('utf8')}`.slice(-4_000);
        if (outputBytes <= MAX_PROCESS_OUTPUT_BYTES || outputLimitExceeded || timedOut) return;
        outputLimitExceeded = true;
        if (timers.timeout) clearTimeout(timers.timeout);
        timers.timeout = undefined;
        signalProcessTree(child, 'SIGTERM');
        timers.terminate = setTimeout(() => signalProcessTree(child, 'SIGKILL', true), 1_500);
        timers.failure = setTimeout(() => finish(() => reject(new AppError('LIBREOFFICE_OUTPUT_LIMIT', 'LibreOffice did not exit after exceeding its diagnostic output limit'))), 4_000);
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      timers.timeout = setTimeout(() => {
        if (outputLimitExceeded) return;
        timedOut = true;
        signalProcessTree(child, 'SIGTERM');
        timers.terminate = setTimeout(() => signalProcessTree(child, 'SIGKILL', true), 1_500);
        timers.failure = setTimeout(() => finish(() => reject(new AppError('LIBREOFFICE_TIMEOUT', 'LibreOffice did not exit after its conversion timeout'))), 4_000);
      }, this.options.timeoutMs ?? CONVERSION_TIMEOUT_MS);
      child.once('error', (error) => finish(() => reject(new AppError('LIBREOFFICE_START_FAILED', `LibreOffice could not start: ${error.message}`))));
      child.once('exit', (code) => finish(() => {
        const diagnostic = sanitizeDiagnostic(diagnosticTail);
        if (processTreeAlive(child)) signalProcessTree(child, 'SIGKILL', true);
        if (timedOut) reject(new AppError('LIBREOFFICE_TIMEOUT', 'LibreOffice document conversion timed out'));
        else if (outputLimitExceeded) reject(new AppError('LIBREOFFICE_OUTPUT_LIMIT', 'LibreOffice produced excessive diagnostic output'));
        else if (code !== 0) reject(new AppError(
          'LIBREOFFICE_CONVERSION_FAILED',
          `LibreOffice 转换失败（退出码 ${code ?? 'unknown'}）${diagnostic ? `：${diagnostic}` : ''}`,
        ));
        else resolve(diagnostic);
      }));
    });
  }
}

function legacyWarning(): DocxCompatibilityWarning {
  return {
    code: 'legacy-doc-round-trip',
    title: 'Legacy Word conversion is lossy',
    detail: 'This .doc is converted with LibreOffice using an isolated profile. Saving regenerates the Word 97 file and cannot preserve macros, signatures, revision history, live fields, or exact pagination.',
    severity: 'warning',
    requiresAcknowledgement: true,
  };
}

function normalizeExtractedText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function supportedStructureCounts(html: string): Record<'images' | 'tables' | 'rows' | 'cells' | 'links', number> {
  const count = (tag: string): number => html.match(new RegExp(`<${tag}\\b`, 'giu'))?.length ?? 0;
  return {
    images: count('img'),
    tables: count('table'),
    rows: count('tr'),
    cells: count('td') + count('th'),
    links: count('a'),
  };
}

export class LegacyDocService {
  private readonly observed = new Map<string, ObservedLegacyDoc>();
  private readonly converter: LegacyDocConverter;

  constructor(
    private readonly projects: ProjectService,
    private readonly snapshots: SnapshotService,
    userDataPath: string,
    converter?: LegacyDocConverter,
  ) {
    this.converter = converter ?? new LibreOfficeConverter(userDataPath);
  }

  async open(relativePath: string): Promise<DocxOpenResult> {
    const { key, target } = await this.resolveExistingDoc(relativePath);
    const info = await stat(target);
    if (!info.isFile()) throw new AppError('NOT_A_FILE', 'The DOC path is not a file');
    if (info.size <= 0 || info.size > MAX_LEGACY_DOC_BYTES) throw new AppError('FILE_TOO_LARGE', 'DOC files must be non-empty and no larger than 100 MB');
    const source = await readFile(target);
    const converted = await this.converter.convert(source, 'doc', 'docx');
    const imported = await openDocxBuffer(converted);
    const warnings = [legacyWarning(), ...imported.warnings];
    const sourceHash = sha256(source);
    this.observed.set(key, { hash: sourceHash, warnings, readOnly: imported.readOnly });
    return { content: imported.content, sourceHash, warnings, readOnly: imported.readOnly };
  }

  async save(request: DocxSaveRequest): Promise<DocxSaveResult> {
    if (!request || typeof request !== 'object' || typeof request.path !== 'string' || typeof request.expectedSourceHash !== 'string' || typeof request.acknowledgeCompatibilityWarnings !== 'boolean' || !request.content || typeof request.content !== 'object' || Array.isArray(request.content)) {
      throw new AppError('INVALID_DOC_SAVE', 'DOC save details are invalid');
    }
    if (!/^[a-f0-9]{64}$/iu.test(request.expectedSourceHash)) throw new AppError('INVALID_DOC_SAVE', 'The expected DOC checksum is invalid');
    const { key, normalized, target } = await this.resolveExistingDoc(request.path);
    const observed = this.observed.get(key);
    if (!observed || observed.hash !== request.expectedSourceHash) throw new AppError('DOC_RELOAD_REQUIRED', 'Reload the DOC before saving it');
    if (observed.readOnly || observed.warnings.some((item) => item.severity === 'blocking')) throw new AppError('DOC_READ_ONLY', 'This DOC contains converted features that Research IDE cannot preserve safely and is read-only');
    if (observed.warnings.some((item) => item.requiresAcknowledgement) && !request.acknowledgeCompatibilityWarnings) {
      throw new AppError('DOC_CONFIRM_COMPATIBILITY', 'Review and acknowledge the legacy Word compatibility warning before saving');
    }

    const current = await readFile(target);
    if (sha256(current) !== observed.hash) throw new AppError('FILE_CHANGED_ON_DISK', `${normalized} changed outside Research IDE; reload before saving`);

    const generatedDocx = await createDocxBuffer(request.content);
    const expectedImport = await openDocxBuffer(generatedDocx);
    const replacement = await this.converter.convert(generatedDocx, 'docx', 'doc');
    if (replacement.byteLength < OLE_COMPOUND_SIGNATURE.byteLength || !replacement.subarray(0, OLE_COMPOUND_SIGNATURE.byteLength).equals(OLE_COMPOUND_SIGNATURE)) {
      throw new AppError('INVALID_DOC_OUTPUT', 'LibreOffice did not generate a Word 97 compound document');
    }
    // A second, independent conversion verifies that LibreOffice can parse the
    // exact bytes that will replace the source and that their text survived.
    const verifiedDocx = await this.converter.convert(replacement, 'doc', 'docx');
    const verifiedImport = await openDocxBuffer(verifiedDocx);
    const [expectedText, verifiedText] = await Promise.all([
      mammoth.extractRawText({ buffer: generatedDocx }),
      mammoth.extractRawText({ buffer: verifiedDocx }),
    ]);
    if (
      normalizeExtractedText(expectedText.value) !== normalizeExtractedText(verifiedText.value)
      || JSON.stringify(supportedStructureCounts(expectedImport.content)) !== JSON.stringify(supportedStructureCounts(verifiedImport.content))
    ) {
      throw new AppError('DOC_ROUND_TRIP_FAILED', 'The legacy Word round-trip changed supported document content, so the source file was not replaced');
    }

    const beforeSnapshot = await readFile(target);
    if (sha256(beforeSnapshot) !== observed.hash) throw new AppError('FILE_CHANGED_ON_DISK', `${normalized} changed outside Research IDE while it was being converted; reload before saving`);
    const snapshot = await this.snapshots.create([normalized], `DOC before save · ${path.basename(normalized)}`);
    const temporary = `${target}.research-ide-${randomUUID()}.tmp`;
    let committed = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(replacement);
        await flushFileHandle(handle);
      } finally {
        await handle.close();
      }
      const latest = await readFile(target);
      if (sha256(latest) !== observed.hash) throw new AppError('FILE_CHANGED_ON_DISK', `${normalized} changed outside Research IDE while it was being saved; reload before saving`);
      await rename(temporary, target);
      committed = true;
      await syncParentDirectory(target);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (committed) throw new AppError('DOC_SAVE_DURABILITY_FAILED', `The DOC was replaced, but its directory could not be synchronized; reload it before continuing: ${error instanceof Error ? error.message : 'unknown file error'}`);
      throw new AppError('DOC_SAVE_FAILED', `The DOC was not changed because the replacement could not be committed: ${error instanceof Error ? error.message : 'unknown file error'}`);
    } finally {
      await rm(temporary, { force: true });
    }
    const sourceHash = sha256(replacement);
    this.observed.set(key, { hash: sourceHash, warnings: [legacyWarning()], readOnly: false });
    return { sourceHash, backupId: snapshot.id };
  }

  clearSession(): void {
    this.observed.clear();
  }

  dispose(): void {
    this.converter.dispose?.();
    this.observed.clear();
  }

  private async resolveExistingDoc(relativePath: string): Promise<{ key: string; normalized: string; target: string }> {
    if (path.extname(relativePath).toLowerCase() !== '.doc') throw new AppError('INVALID_DOC_PATH', 'Only .doc files can use the legacy Word editor');
    const lexical = this.projects.guard.lexical(relativePath);
    const normalized = this.projects.guard.relative(lexical);
    const target = await this.projects.guard.existing(normalized);
    const root = this.projects.current?.path;
    if (!root) throw new AppError('NO_PROJECT', 'Open a project first');
    return { key: `${root}\0${normalized}`, normalized, target };
  }
}

export const legacyDocInternals = {
  systemLibreOfficeCandidates,
  managedLibreOfficeCandidates,
  normalizeExtractedText,
  supportedStructureCounts,
  lockedDownProfile: LOCKED_DOWN_PROFILE,
};
