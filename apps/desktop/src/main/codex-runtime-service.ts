import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import type {
  CodexRuntimeCatalog,
  CodexRuntimeDescriptor,
  CodexRuntimeEvent,
  CodexRuntimeManagedVersion,
  CodexRuntimeRelease,
  CodexRuntimeStatus,
} from '../shared/types';
import { DISTRIBUTION_IDENTITY } from '../shared/distribution';
import { AppError } from './errors';
import { flushFileHandle, syncParentDirectory } from './file-durability';

const OFFICIAL_RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases?per_page=10';
const MAX_CATALOG_BYTES = 12 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 480 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 480 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const CATALOG_TIMEOUT_MS = 20_000;
const RECORD_SCHEMA_VERSION = 1;
const RUNTIME_MARKER_NAME = '.research-ide-codex-runtime.json';
const RUNTIME_MARKER_KIND = 'research-ide-codex-runtime';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

interface ReleaseAsset {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

interface SelectionRecord {
  schemaVersion: 1;
  source: 'imported' | 'managed';
  path?: string;
  version: string;
  sha256: string;
  selectedAt: string;
}

interface ManagedManifest {
  schemaVersion: 1;
  version: string;
  platform: string;
  arch: string;
  assetName: string;
  assetSha256: string;
  executable: string;
  executableSha256: string;
  installedAt: string;
}

interface DirectoryIdentity {
  path: string;
  canonical: string;
  device: number;
  inode: number;
}

interface RuntimeDirectories {
  userData: DirectoryIdentity;
  root: DirectoryIdentity;
  versions: DirectoryIdentity;
}

export interface PreparedCodexRuntimeExecutable {
  path: string;
  version: string;
  sha256: string;
}

export interface CodexRuntimeResolution extends CodexRuntimeDescriptor {
  prefixArgs: string[];
  /** Only the existing CODEX_HOME value is returned; the manager never creates or relocates it. */
  environment: NodeJS.ProcessEnv;
}

export interface CodexRuntimeCatalogProvider {
  load(): Promise<Array<Omit<CodexRuntimeRelease, 'installed'>>>;
}

export interface CodexRuntimeServiceOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  environment?: NodeJS.ProcessEnv;
  provider?: CodexRuntimeCatalogProvider;
  fetchImpl?: typeof fetch;
  currentProjectRoot?: () => string | undefined;
  readVersion?: (executable: string, prefixArgs: string[], environment: NodeJS.ProcessEnv) => Promise<string>;
  now?: () => Date;
}

function runtimeTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): { assetName: string; executableName: string; platformLabel: string } | undefined {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
  if (!cpu) return undefined;
  if (platform === 'darwin') return { assetName: `codex-${cpu}-apple-darwin.tar.gz`, executableName: `codex-${cpu}-apple-darwin`, platformLabel: `${platform}-${arch}` };
  if (platform === 'linux') return { assetName: `codex-${cpu}-unknown-linux-musl.tar.gz`, executableName: `codex-${cpu}-unknown-linux-musl`, platformLabel: `${platform}-${arch}` };
  if (platform === 'win32') return { assetName: `codex-${cpu}-pc-windows-msvc.exe`, executableName: 'codex.exe', platformLabel: `${platform}-${arch}` };
  return undefined;
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(/[.-]/u).slice(0, 3).map((item) => Number(item));
  const a = parts(left); const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return left.localeCompare(right, 'en');
}

function versionFromRelease(value: unknown, fallback: unknown): string | undefined {
  for (const candidate of [value, fallback]) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.replace(/^rust-v/u, '').replace(/^v/u, '');
    if (VERSION_PATTERN.test(normalized)) return normalized;
  }
  return undefined;
}

function isOfficialReleaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'github.com' && /^\/openai\/codex\/releases\/download\//u.test(url.pathname) && !url.username && !url.password;
  } catch { return false; }
}

function isAllowedDownloadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('CODEX_RUNTIME_RESPONSE_TOO_LARGE', 'The Codex runtime provider response exceeds the safety limit');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new AppError('CODEX_RUNTIME_RESPONSE_TOO_LARGE', 'The Codex runtime provider response exceeds the safety limit'); }
    chunks.push(Buffer.from(result.value));
  }
  return Buffer.concat(chunks, total);
}

export class OfficialCodexGithubProvider implements CodexRuntimeCatalogProvider {
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture; fetchImpl?: typeof fetch } = {}) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async load(): Promise<Array<Omit<CodexRuntimeRelease, 'installed'>>> {
    const target = runtimeTarget(this.platform, this.arch);
    if (!target) throw new AppError('CODEX_RUNTIME_UNSUPPORTED_PLATFORM', `Managed Codex is not available for ${this.platform}-${this.arch}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(OFFICIAL_RELEASES_URL, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!response.ok) throw new AppError('CODEX_RUNTIME_CATALOG_FAILED', `Official Codex release catalog returned HTTP ${response.status}`);
      let payload: unknown;
      try { payload = JSON.parse((await boundedBody(response, MAX_CATALOG_BYTES)).toString('utf8')); }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError('CODEX_RUNTIME_CATALOG_INVALID', 'Official Codex release catalog is not valid JSON'); }
      if (!Array.isArray(payload)) throw new AppError('CODEX_RUNTIME_CATALOG_INVALID', 'Official Codex release catalog has an invalid format');
      const releases: Array<Omit<CodexRuntimeRelease, 'installed'>> = [];
      for (const raw of payload.slice(0, 10) as GithubRelease[]) {
        if (!raw || raw.draft === true || raw.prerelease === true || !Array.isArray(raw.assets)) continue;
        const version = versionFromRelease(raw.tag_name, raw.name);
        if (!version) continue;
        const asset = (raw.assets as ReleaseAsset[]).find((item) => item?.name === target.assetName);
        if (!asset || typeof asset.size !== 'number' || asset.size <= 0 || asset.size > MAX_DOWNLOAD_BYTES) continue;
        if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)) continue;
        if (typeof asset.browser_download_url !== 'string' || !isOfficialReleaseUrl(asset.browser_download_url)) continue;
        releases.push({ version, assetName: target.assetName, downloadUrl: asset.browser_download_url, sha256: asset.digest.slice(7), size: asset.size });
      }
      if (!releases.length) throw new AppError('CODEX_RUNTIME_NO_VERIFIED_RELEASE', `No official Codex release for ${target.platformLabel} supplied the required GitHub SHA-256 digest`);
      return releases.sort((left, right) => compareVersions(right.version, left.version));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new AppError('CODEX_RUNTIME_CATALOG_TIMEOUT', 'Official Codex release catalog timed out');
      throw error;
    } finally { clearTimeout(timer); }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function parseVersion(output: string): string | undefined {
  const match = /(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(output.trim());
  return match?.[1];
}

async function defaultReadVersion(executable: string, prefixArgs: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...prefixArgs, '--version'], { env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new AppError('CODEX_RUNTIME_VERSION_TIMEOUT', 'Codex version check timed out')); }, 12_000);
    const append = (chunk: Buffer) => { if (output.length < 16_384) output += chunk.toString('utf8').slice(0, 16_384 - output.length); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', (error) => { clearTimeout(timer); reject(new AppError('CODEX_RUNTIME_NOT_EXECUTABLE', error.message)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new AppError('CODEX_RUNTIME_VERSION_FAILED', `Codex version check exited with code ${code ?? -1}`)); return; }
      resolve(output.trim());
    });
  });
}

async function sha256File(target: string): Promise<string> {
  const lexical = await lstat(target).catch(() => undefined);
  if (!lexical?.isFile() || lexical.isSymbolicLink() || lexical.size <= 0 || lexical.size > MAX_EXECUTABLE_BYTES) {
    throw new AppError('CODEX_RUNTIME_INVALID_EXECUTABLE', 'Codex executable has an invalid size or file type');
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(target, constants.O_RDONLY | noFollow);
  const digest = createHash('sha256');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== lexical.size) {
      throw new AppError('CODEX_RUNTIME_EXECUTABLE_CHANGED', 'Codex executable changed before it could be verified');
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== before.size) throw new AppError('CODEX_RUNTIME_EXECUTABLE_CHANGED', 'Codex executable changed while it was being verified');
    const after = await handle.stat();
    const current = await lstat(target).catch(() => undefined);
    if (
      !current?.isFile()
      || current.isSymbolicLink()
      || current.dev !== before.dev
      || current.ino !== before.ino
      || current.size !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) throw new AppError('CODEX_RUNTIME_EXECUTABLE_CHANGED', 'Codex executable changed while it was being verified');
    return digest.digest('hex');
  } finally { await handle.close(); }
}

async function readStableRegularFile(target: string, maxBytes: number, code: string, message: string): Promise<string> {
  try {
    const lexical = await lstat(target);
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size <= 0 || lexical.size > maxBytes) throw new AppError(code, message);
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await open(target, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== lexical.dev || opened.ino !== lexical.ino || opened.size !== lexical.size) throw new AppError(code, message);
      const source = await handle.readFile('utf8');
      const after = await handle.stat();
      const current = await lstat(target).catch(() => undefined);
      if (
        !current?.isFile()
        || current.isSymbolicLink()
        || current.dev !== opened.dev
        || current.ino !== opened.ino
        || current.size !== opened.size
        || current.mtimeMs !== opened.mtimeMs
        || current.ctimeMs !== opened.ctimeMs
        || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs
      ) throw new AppError(code, message);
      return source;
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(code, message);
  }
}

function parseTarOctal(header: Buffer, offset: number, length: number): number {
  const raw = header.subarray(offset, offset + length).toString('ascii').replaceAll('\0', '').trim();
  if (!/^[0-7]+$/u.test(raw)) throw new AppError('CODEX_RUNTIME_ARCHIVE_INVALID', 'Codex archive contains an invalid tar size');
  return Number.parseInt(raw, 8);
}

function validateTarHeader(header: Buffer): void {
  const expected = parseTarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index]!;
  if (actual !== expected) throw new AppError('CODEX_RUNTIME_ARCHIVE_INVALID', 'Codex archive tar header checksum is invalid');
}

async function extractSingleTarGz(archive: string, destination: string, expectedName: string): Promise<void> {
  let pending = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let writing = false;
  let found = false;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    for await (const rawChunk of createReadStream(archive).pipe(createGunzip())) {
      pending = pending.length ? Buffer.concat([pending, rawChunk as Buffer]) : Buffer.from(rawChunk as Buffer);
      while (pending.length) {
        if (remaining > 0) {
          const count = Math.min(remaining, pending.length);
          if (writing) await output!.write(pending.subarray(0, count));
          pending = pending.subarray(count); remaining -= count;
          if (remaining === 0) { if (writing) { await flushFileHandle(output!); await output!.close(); output = undefined; found = true; writing = false; } }
          continue;
        }
        if (padding > 0) {
          const count = Math.min(padding, pending.length); pending = pending.subarray(count); padding -= count; continue;
        }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512); pending = pending.subarray(512);
        if (header.every((value) => value === 0)) { pending = Buffer.alloc(0); break; }
        validateTarHeader(header);
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
        const type = String.fromCharCode(header[156] ?? 0);
        const size = parseTarOctal(header, 124, 12);
        if (size < 0 || size > MAX_EXECUTABLE_BYTES) throw new AppError('CODEX_RUNTIME_ARCHIVE_INVALID', 'Codex archive entry exceeds the safety limit');
        remaining = size; padding = (512 - (size % 512)) % 512;
        if (type === '5') continue;
        if (type !== '\0' && type !== '0') throw new AppError('CODEX_RUNTIME_ARCHIVE_INVALID', 'Codex archive contains a link or unsupported entry');
        const normalized = name.replace(/^\.\//u, '');
        if (normalized !== expectedName || normalized.includes('/') || found || writing) throw new AppError('CODEX_RUNTIME_ARCHIVE_INVALID', 'Codex archive does not contain exactly the expected platform executable');
        output = await open(destination, 'wx', 0o700); writing = true;
        if (size === 0) throw new AppError('CODEX_RUNTIME_ARCHIVE_INVALID', 'Codex archive executable is empty');
      }
    }
    if (remaining || padding || !found || output) throw new AppError('CODEX_RUNTIME_ARCHIVE_INVALID', 'Codex archive is truncated or missing its executable');
  } finally { await output?.close().catch(() => undefined); }
}

export class CodexRuntimeService {
  private readonly userDataPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly provider: CodexRuntimeCatalogProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly currentProjectRoot: () => string | undefined;
  private readonly readVersionImpl: NonNullable<CodexRuntimeServiceOptions['readVersion']>;
  private readonly now: () => Date;
  private catalogCache?: CodexRuntimeCatalog;
  private operation?: Promise<CodexRuntimeStatus>;
  private downloadController?: AbortController;

  constructor(userDataPath: string, private readonly emit: (event: CodexRuntimeEvent) => void = () => undefined, options: CodexRuntimeServiceOptions = {}) {
    this.userDataPath = path.resolve(userDataPath);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.environment = { ...(options.environment ?? process.env) };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.provider = options.provider ?? new OfficialCodexGithubProvider({ platform: this.platform, arch: this.arch, fetchImpl: this.fetchImpl });
    this.currentProjectRoot = options.currentProjectRoot ?? (() => undefined);
    this.readVersionImpl = options.readVersion ?? defaultReadVersion;
    this.now = options.now ?? (() => new Date());
  }

  async status(): Promise<CodexRuntimeStatus> {
    const [system, managedVersions] = await Promise.all([this.detectSystem(), this.listManaged()]);
    let selection: SelectionRecord | undefined;
    try { selection = await this.readSelection(); }
    catch (error) { return { state: 'invalid', system, managedVersions, detail: error instanceof Error ? error.message : 'Codex runtime selection is invalid' }; }
    if (!selection) return system ? { state: 'ready', active: system, system, managedVersions, updateAvailable: this.availableUpdate(system.version) } : { state: 'missing', system, managedVersions, detail: 'Codex was not found on PATH and no trusted or managed runtime is selected.' };
    try {
      const active = selection.source === 'imported' ? await this.resolveImported(selection) : await this.resolveManaged(selection);
      return { state: 'ready', active, system, managedVersions: managedVersions.map((item) => ({ ...item, selected: item.version === selection!.version && selection!.source === 'managed' })), updateAvailable: this.availableUpdate(active.version) };
    } catch (error) {
      return { state: 'invalid', system, managedVersions, detail: error instanceof Error ? error.message : 'The selected Codex runtime failed verification' };
    }
  }

  async catalog(refresh = true): Promise<CodexRuntimeCatalog> {
    if (!refresh && this.catalogCache) return this.catalogCache;
    const target = runtimeTarget(this.platform, this.arch);
    if (!target) return { provider: 'openai-github-releases', sourceUrl: OFFICIAL_RELEASES_URL, platform: `${this.platform}-${this.arch}`, releases: [], warning: 'This platform is not supported by the official Codex runtime provider.' };
    const installed = new Set((await this.listManaged()).map((item) => item.version));
    const releases = (await this.provider.load()).map((release) => ({ ...release, installed: installed.has(release.version) }));
    this.catalogCache = { provider: 'openai-github-releases', sourceUrl: OFFICIAL_RELEASES_URL, platform: target.platformLabel, releases };
    return this.catalogCache;
  }

  async prepareSelection(candidate: string): Promise<PreparedCodexRuntimeExecutable> {
    const inspected = await this.inspectExecutable(candidate, []);
    return { path: inspected.path, version: inspected.version, sha256: inspected.sha256 };
  }

  async confirmSelection(prepared: PreparedCodexRuntimeExecutable): Promise<CodexRuntimeStatus> {
    if (!prepared || typeof prepared.path !== 'string' || !VERSION_PATTERN.test(prepared.version) || !/^[a-f0-9]{64}$/u.test(prepared.sha256)) throw new AppError('CODEX_RUNTIME_INVALID_SELECTION', 'Codex runtime confirmation is invalid');
    const inspected = await this.inspectExecutable(prepared.path, []);
    if (inspected.sha256 !== prepared.sha256 || inspected.version !== prepared.version) throw new AppError('CODEX_RUNTIME_EXECUTABLE_CHANGED', 'The selected Codex executable changed before it could be trusted');
    await this.writeSelection({ schemaVersion: 1, source: 'imported', path: inspected.path, version: inspected.version, sha256: inspected.sha256, selectedAt: this.now().toISOString() });
    return this.status();
  }

  async clearSelection(): Promise<CodexRuntimeStatus> {
    const directories = await this.ensureRoot();
    await this.assertDirectoryIdentity(directories.root);
    const selectionPath = path.join(directories.root.canonical, 'selection.json');
    const selection = await lstat(selectionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (selection?.isSymbolicLink() || (selection && !selection.isFile())) {
      throw new AppError('CODEX_RUNTIME_SELECTION_INVALID', 'Codex runtime selection record is unsafe');
    }
    await rm(selectionPath, { force: true, recursive: false });
    await this.assertDirectoryIdentity(directories.root);
    return this.status();
  }

  install(version: string): Promise<CodexRuntimeStatus> {
    if (!VERSION_PATTERN.test(version)) return Promise.reject(new AppError('CODEX_RUNTIME_INVALID_VERSION', 'Codex runtime version is invalid'));
    if (this.operation) return Promise.reject(new AppError('CODEX_RUNTIME_BUSY', 'Another Codex runtime operation is already running'));
    const operation = this.installVersion(version);
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
  }

  async update(): Promise<CodexRuntimeStatus> {
    if (this.operation) throw new AppError('CODEX_RUNTIME_BUSY', 'Another Codex runtime operation is already running');
    const selection = await this.readSelection();
    if (!selection || selection.source !== 'managed') throw new AppError('CODEX_RUNTIME_NOT_MANAGED', 'Install a managed Codex runtime before using managed update');
    const catalog = await this.catalog(true);
    const latest = catalog.releases[0];
    if (!latest || compareVersions(latest.version, selection.version) <= 0) return this.status();
    return this.install(latest.version);
  }

  async resolveCommand(projectRoot?: string): Promise<CodexRuntimeResolution> {
    const current = await this.status();
    if (current.state !== 'ready' || !current.active) throw new AppError('CODEX_NOT_FOUND', current.detail ?? 'No verified Codex runtime is available');
    if (projectRoot) {
      const protectedPaths = [current.active.path, ...(current.active.prefixArgs ?? []).filter((value) => path.isAbsolute(value))];
      for (const candidate of protectedPaths) {
        if (await this.isProjectPath(candidate, projectRoot)) {
          throw new AppError('PROJECT_EXECUTABLE_FORBIDDEN', 'Codex cannot run an executable or entry point from inside the active project');
        }
      }
    }
    return { ...current.active, prefixArgs: [...(current.active.prefixArgs ?? [])], environment: this.environment.CODEX_HOME === undefined ? {} : { CODEX_HOME: this.environment.CODEX_HOME } };
  }

  async dispose(): Promise<void> {
    this.downloadController?.abort();
    await this.operation?.catch(() => undefined);
  }

  private async installVersion(version: string): Promise<CodexRuntimeStatus> {
    const operationId = randomUUID();
    const event = (phase: CodexRuntimeEvent['phase'], message: string, progress?: number) => this.emit({ operationId, version, phase, message, ...(progress === undefined ? {} : { progress }) });
    let staging: string | undefined;
    try {
      event('catalog', 'Reading the verified official Codex release catalog');
      const catalog = await this.catalog(true);
      const release = catalog.releases.find((item) => item.version === version);
      if (!release) throw new AppError('CODEX_RUNTIME_RELEASE_NOT_FOUND', 'The requested version is absent from the verified official catalog');
      const directories = await this.ensureRoot();
      await this.assertRuntimeDirectories(directories);
      staging = path.join(directories.root.canonical, `.install-${operationId}`);
      await mkdir(staging, { mode: 0o700 });
      const stagingIdentity = await this.directoryIdentity(staging, 'Codex runtime staging directory');
      if (!samePath(path.dirname(stagingIdentity.canonical), directories.root.canonical)) {
        throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime staging directory resolves outside its application-data root');
      }
      const target = runtimeTarget(this.platform, this.arch)!;
      const archive = path.join(staging, 'download');
      event('downloading', `Downloading ${release.assetName}`, 0);
      await this.download(release, archive, (progress) => event('downloading', `Downloading ${release.assetName}`, progress));
      event('verifying', 'Official GitHub SHA-256 digest verified', 1);
      const executable = path.join(staging, target.executableName === 'codex.exe' ? 'codex.exe' : 'codex');
      event('installing', 'Preparing an isolated managed version');
      if (release.assetName.endsWith('.tar.gz')) await extractSingleTarGz(archive, executable, target.executableName);
      else { await rename(archive, executable); }
      if (this.platform !== 'win32') await chmod(executable, 0o700);
      const inspected = await this.inspectExecutable(executable, [], false);
      if (inspected.version !== version) throw new AppError('CODEX_RUNTIME_VERSION_MISMATCH', `Downloaded Codex reported ${inspected.version}, expected ${version}`);
      event('validating', `Validated Codex ${inspected.version}`);
      const installedAt = this.now().toISOString();
      const manifest: ManagedManifest = { schemaVersion: 1, version, platform: this.platform, arch: this.arch, assetName: release.assetName, assetSha256: release.sha256, executable: path.basename(executable), executableSha256: inspected.sha256, installedAt };
      await this.atomicJson(path.join(staging, 'install.json'), manifest, stagingIdentity);
      await rm(archive, { force: true });
      await this.assertRuntimeDirectories(directories);
      const destination = path.join(directories.versions.canonical, version);
      const existing = await lstat(destination).catch(() => undefined);
      if (existing) {
        await this.validateManagedVersion(version);
        await this.removeOwnedStaging(staging);
      } else {
        await rename(staging, destination);
        staging = undefined;
        await syncParentDirectory(destination);
      }
      const installed = await this.validateManagedVersion(version);
      await this.writeSelection({ schemaVersion: 1, source: 'managed', version, sha256: installed.sha256, selectedAt: installedAt });
      this.catalogCache = undefined;
      event('completed', `Codex ${version} is installed and selected`, 1);
      return this.status();
    } catch (error) {
      event('failed', error instanceof Error ? error.message : 'Codex runtime installation failed');
      throw error;
    } finally {
      if (staging) await this.removeOwnedStaging(staging).catch(() => undefined);
    }
  }

  private async download(release: CodexRuntimeRelease, destination: string, progress: (value: number) => void): Promise<void> {
    if (!isOfficialReleaseUrl(release.downloadUrl) || !/^[a-f0-9]{64}$/u.test(release.sha256) || release.size <= 0 || release.size > MAX_DOWNLOAD_BYTES) throw new AppError('CODEX_RUNTIME_UNVERIFIED_RELEASE', 'Codex release metadata did not pass source and digest validation');
    const controller = new AbortController(); this.downloadController = controller;
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let response: Response | undefined;
    let url = release.downloadUrl;
    try {
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        if (!isAllowedDownloadUrl(url)) throw new AppError('CODEX_RUNTIME_UNSAFE_REDIRECT', 'Codex download redirected outside the approved GitHub release hosts');
        response = await this.fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) throw new AppError('CODEX_RUNTIME_UNSAFE_REDIRECT', 'Codex download returned an invalid redirect');
          url = new URL(location, url).toString(); continue;
        }
        break;
      }
      if (!response?.ok || !response.body) throw new AppError('CODEX_RUNTIME_DOWNLOAD_FAILED', `Codex download returned HTTP ${response?.status ?? 0}`);
      const declaredHeader = response.headers.get('content-length');
      if (declaredHeader !== null) {
        const declared = Number(declaredHeader);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared !== release.size) {
          throw new AppError('CODEX_RUNTIME_SIZE_MISMATCH', 'Codex download size differs from official release metadata');
        }
      }
      const handle = await open(destination, 'wx', 0o600);
      const digest = createHash('sha256'); let total = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const result = await reader.read(); if (result.done) break;
          total += result.value.byteLength;
          if (total > release.size || total > MAX_DOWNLOAD_BYTES) { await reader.cancel().catch(() => undefined); throw new AppError('CODEX_RUNTIME_SIZE_MISMATCH', 'Codex download exceeded the verified size'); }
          const chunk = Buffer.from(result.value); digest.update(chunk); await handle.write(chunk); progress(total / release.size);
        }
        await flushFileHandle(handle);
      } finally { await handle.close(); }
      if (total !== release.size) throw new AppError('CODEX_RUNTIME_SIZE_MISMATCH', 'Codex download was truncated');
      if (digest.digest('hex') !== release.sha256) throw new AppError('CODEX_RUNTIME_DIGEST_MISMATCH', 'Codex download failed its official GitHub SHA-256 check');
    } catch (error) {
      await rm(destination, { force: true });
      if (error instanceof Error && error.name === 'AbortError') throw new AppError('CODEX_RUNTIME_DOWNLOAD_TIMEOUT', 'Codex download timed out or was cancelled');
      throw error;
    } finally { clearTimeout(timer); if (this.downloadController === controller) this.downloadController = undefined; }
  }

  private async detectSystem(): Promise<CodexRuntimeDescriptor | undefined> {
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    const fixed = this.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin'] : [];
    const directories = [...(this.environment.PATH ?? '').split(paths.delimiter), ...fixed];
    const seen = new Set<string>();
    const trustedDirectories: string[] = [];
    for (const directory of directories) {
      if (!directory || !paths.isAbsolute(directory)) continue;
      const key = this.platform === 'win32' ? paths.normalize(directory).toLocaleLowerCase('en-US') : paths.normalize(directory);
      if (seen.has(key)) continue;
      seen.add(key);
      trustedDirectories.push(directory);
    }
    const nativeName = this.platform === 'win32' ? 'codex.exe' : 'codex';
    for (const directory of trustedDirectories) {
      try {
        const canonical = await this.trustedSystemFile(paths.join(directory, nativeName), true);
        if (!canonical) continue;
        const output = await this.readVersionImpl(canonical, [], this.environment);
        const version = parseVersion(output);
        if (version && /codex/iu.test(output)) return { source: 'system', path: canonical, version, prefixArgs: [] };
      } catch { /* Try the next PATH candidate. */ }
    }
    if (this.platform === 'win32') {
      // The standard npm installation exposes codex.cmd, which cannot be
      // passed to spawn(shell:false). Resolve its adjacent package entry and
      // invoke it with an independently trusted node.exe from system PATH.
      let node: string | undefined;
      for (const directory of trustedDirectories) {
        node = await this.trustedSystemFile(paths.join(directory, 'node.exe'), true).catch(() => undefined);
        if (node) break;
      }
      if (!node) return undefined;
      for (const directory of trustedDirectories) {
        try {
          const shimPath = paths.join(directory, 'codex.cmd');
          const shimInfo = await lstat(shimPath);
          if (!shimInfo.isFile() || shimInfo.isSymbolicLink()) continue;
          const shim = await realpath(shimPath);
          if (await this.isProjectPath(shim)) continue;
          const entryPath = paths.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
          const entryInfo = await lstat(entryPath);
          if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) continue;
          const entry = await realpath(entryPath);
          if (await this.isProjectPath(entry)) continue;
          const output = await this.readVersionImpl(node, [entry], this.environment);
          const version = parseVersion(output);
          if (version && /codex/iu.test(output)) return { source: 'system', path: node, version, prefixArgs: [entry] };
        } catch { /* Try another standard npm global bin directory. */ }
      }
    }
    return undefined;
  }

  private async trustedSystemFile(candidate: string, executable: boolean): Promise<string | undefined> {
    const info = await lstat(candidate).catch(() => undefined);
    if (!info || (!info.isFile() && !info.isSymbolicLink())) return undefined;
    const canonical = await realpath(candidate);
    const canonicalInfo = await lstat(canonical);
    if (!canonicalInfo.isFile() || await this.isProjectPath(canonical)) return undefined;
    await access(canonical, executable && this.platform !== 'win32' ? constants.X_OK : constants.F_OK);
    return canonical;
  }

  private async inspectExecutable(candidate: string, prefixArgs: string[], rejectProject = true): Promise<PreparedCodexRuntimeExecutable> {
    if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate) || candidate.length > 8_192 || candidate.includes('\0')) throw new AppError('CODEX_RUNTIME_INVALID_EXECUTABLE', 'Choose an absolute Codex executable path');
    const lexicalPath = path.resolve(candidate); const lexical = await lstat(lexicalPath).catch(() => undefined);
    if (!lexical?.isFile() || lexical.isSymbolicLink()) throw new AppError('CODEX_RUNTIME_INVALID_EXECUTABLE', 'Codex executable must be a real regular file, not a symbolic link');
    const canonical = await realpath(lexicalPath);
    if (!samePath(canonical, lexicalPath)) throw new AppError('CODEX_RUNTIME_INVALID_EXECUTABLE', 'Codex executable path traverses a symbolic link');
    const canonicalInfo = await lstat(canonical);
    if (!canonicalInfo.isFile() || canonicalInfo.isSymbolicLink() || canonicalInfo.dev !== lexical.dev || canonicalInfo.ino !== lexical.ino) {
      throw new AppError('CODEX_RUNTIME_EXECUTABLE_CHANGED', 'Codex executable changed while it was being inspected');
    }
    if (rejectProject && await this.isProjectPath(canonical)) throw new AppError('PROJECT_EXECUTABLE_FORBIDDEN', 'Codex cannot be trusted from inside the active project');
    await access(canonical, this.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const output = await this.readVersionImpl(canonical, prefixArgs, this.environment);
    const version = parseVersion(output);
    if (!version || !/codex/iu.test(output)) throw new AppError('CODEX_RUNTIME_VERSION_INVALID', 'The selected executable did not identify itself as a versioned Codex CLI');
    return { path: canonical, version, sha256: await sha256File(canonical) };
  }

  private async isProjectPath(candidate: string, explicitRoot?: string): Promise<boolean> {
    const root = explicitRoot ?? this.currentProjectRoot(); if (!root) return false;
    const canonicalRoot = await realpath(path.resolve(root)).catch(() => undefined);
    const canonicalCandidate = await realpath(path.resolve(candidate)).catch(() => undefined);
    return Boolean(canonicalRoot && canonicalCandidate && isInside(canonicalRoot, canonicalCandidate));
  }

  private async resolveImported(record: SelectionRecord): Promise<CodexRuntimeDescriptor> {
    if (!record.path) throw new AppError('CODEX_RUNTIME_SELECTION_INVALID', 'Trusted Codex selection has no executable path');
    const inspected = await this.inspectExecutable(record.path, []);
    if (inspected.sha256 !== record.sha256 || inspected.version !== record.version) throw new AppError('CODEX_RUNTIME_EXECUTABLE_CHANGED', 'The trusted Codex executable was replaced or updated; review it again');
    return { source: 'imported', ...inspected, prefixArgs: [] };
  }

  private async resolveManaged(record: SelectionRecord): Promise<CodexRuntimeDescriptor> {
    const inspected = await this.validateManagedVersion(record.version);
    if (inspected.sha256 !== record.sha256) throw new AppError('CODEX_RUNTIME_EXECUTABLE_CHANGED', 'The managed Codex executable failed its installation fingerprint check');
    return { source: 'managed', ...inspected, prefixArgs: [] };
  }

  private async validateManagedVersion(version: string): Promise<PreparedCodexRuntimeExecutable & { installedAt: string }> {
    if (!VERSION_PATTERN.test(version)) throw new AppError('CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex version is invalid');
    const directories = await this.runtimeDirectories(false);
    if (!directories) throw new AppError('CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex storage is missing');
    await this.assertRuntimeDirectories(directories);
    const directory = path.join(directories.versions.canonical, version);
    const versionDirectory = await this.directoryIdentity(directory, 'Managed Codex version directory');
    if (!samePath(path.dirname(versionDirectory.canonical), directories.versions.canonical)) {
      throw new AppError('CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex version directory resolves outside managed storage');
    }
    const manifestPath = path.join(versionDirectory.canonical, 'install.json');
    const manifestInfo = await lstat(manifestPath).catch(() => undefined);
    if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size <= 0 || manifestInfo.size > 32 * 1024) {
      throw new AppError('CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex manifest is not a safe regular file');
    }
    const source = await readStableRegularFile(manifestPath, 32 * 1024, 'CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex manifest is not a safe regular file');
    let manifest: ManagedManifest; try { manifest = JSON.parse(source) as ManagedManifest; } catch { throw new AppError('CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex manifest is invalid JSON'); }
    const target = runtimeTarget(this.platform, this.arch);
    const expectedExecutable = target?.executableName === 'codex.exe' ? 'codex.exe' : 'codex';
    if (
      manifest.schemaVersion !== 1
      || manifest.version !== version
      || manifest.platform !== this.platform
      || manifest.arch !== this.arch
      || manifest.assetName !== target?.assetName
      || manifest.executable !== expectedExecutable
      || !/^[a-f0-9]{64}$/u.test(manifest.executableSha256)
      || !/^[a-f0-9]{64}$/u.test(manifest.assetSha256)
      || typeof manifest.installedAt !== 'string'
      || !Number.isFinite(Date.parse(manifest.installedAt))
    ) throw new AppError('CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex manifest failed validation');
    const executable = path.join(versionDirectory.canonical, manifest.executable);
    const executableInfo = await lstat(executable).catch(() => undefined);
    if (!executableInfo?.isFile() || executableInfo.isSymbolicLink()) throw new AppError('CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex executable is not a safe regular file');
    const canonical = await realpath(executable);
    if (!isInside(versionDirectory.canonical, canonical)) throw new AppError('CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex executable resolves outside its version directory');
    const digest = await sha256File(canonical); if (digest !== manifest.executableSha256) throw new AppError('CODEX_RUNTIME_EXECUTABLE_CHANGED', 'Managed Codex executable was modified after installation');
    await access(canonical, this.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const output = await this.readVersionImpl(canonical, [], this.environment); const reported = parseVersion(output);
    if (reported !== version || !/codex/iu.test(output)) throw new AppError('CODEX_RUNTIME_VERSION_MISMATCH', 'Managed Codex executable no longer reports its installed version');
    await this.assertDirectoryIdentity(versionDirectory);
    await this.assertRuntimeDirectories(directories);
    return { path: canonical, version, sha256: digest, installedAt: manifest.installedAt };
  }

  private async listManaged(): Promise<CodexRuntimeManagedVersion[]> {
    const storage = await this.runtimeDirectories(false);
    if (!storage) return [];
    await this.assertRuntimeDirectories(storage);
    const directories = await readdir(storage.versions.canonical, { withFileTypes: true });
    const results: CodexRuntimeManagedVersion[] = [];
    for (const entry of directories) {
      if (!entry.isDirectory() || !VERSION_PATTERN.test(entry.name)) continue;
      try {
        const versionPath = path.join(storage.versions.canonical, entry.name);
        const versionInfo = await lstat(versionPath);
        if (versionInfo.isSymbolicLink() || !versionInfo.isDirectory()) continue;
        const source = await readStableRegularFile(path.join(versionPath, 'install.json'), 32 * 1024, 'CODEX_RUNTIME_MANIFEST_INVALID', 'Managed Codex manifest is not a safe regular file');
        const manifest = JSON.parse(source) as ManagedManifest;
        if (manifest.schemaVersion !== 1 || manifest.version !== entry.name || typeof manifest.installedAt !== 'string' || !Number.isFinite(Date.parse(manifest.installedAt)) || path.basename(manifest.executable) !== manifest.executable) continue;
        results.push({ version: entry.name, installedAt: manifest.installedAt, selected: false, path: path.join(versionPath, manifest.executable) });
      } catch { /* Invalid versions are not offered for selection. */ }
    }
    await this.assertRuntimeDirectories(storage);
    return results.sort((left, right) => compareVersions(right.version, left.version));
  }

  private availableUpdate(version: string): string | undefined {
    const latest = this.catalogCache?.releases[0]?.version;
    return latest && compareVersions(latest, version) > 0 ? latest : undefined;
  }

  private async ensureRoot(): Promise<RuntimeDirectories> {
    const directories = await this.runtimeDirectories(true);
    if (!directories) throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Could not create Codex runtime storage');
    return directories;
  }

  private async runtimeDirectories(create: boolean): Promise<RuntimeDirectories | undefined> {
    let userDataInfo = await lstat(this.userDataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!userDataInfo && create) {
      await mkdir(this.userDataPath, { recursive: true, mode: 0o700 });
      userDataInfo = await lstat(this.userDataPath);
    }
    if (!userDataInfo) return undefined;
    const userData = await this.directoryIdentity(this.userDataPath, 'Research IDE application-data directory');

    const rootPath = path.join(userData.canonical, 'codex-runtime');
    let rootInfo = await lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!rootInfo && create) {
      await mkdir(rootPath, { mode: 0o700 });
      rootInfo = await lstat(rootPath);
    }
    if (!rootInfo) return undefined;
    const root = await this.directoryIdentity(rootPath, 'Codex runtime root');
    if (!samePath(path.dirname(root.canonical), userData.canonical)) {
      throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime root resolves outside Research IDE application data');
    }
    await this.ensureOwnerMarker(root, create);

    const versionsPath = path.join(root.canonical, 'versions');
    let versionsInfo = await lstat(versionsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!versionsInfo && create) {
      await mkdir(versionsPath, { mode: 0o700 });
      versionsInfo = await lstat(versionsPath);
    }
    if (!versionsInfo) throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime versions directory is missing');
    const versions = await this.directoryIdentity(versionsPath, 'Codex runtime versions directory');
    if (!samePath(path.dirname(versions.canonical), root.canonical)) {
      throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime versions directory resolves outside its application-data root');
    }
    const result = { userData, root, versions };
    await this.assertRuntimeDirectories(result);
    return result;
  }

  private async directoryIdentity(target: string, label: string): Promise<DirectoryIdentity> {
    const info = await lstat(target).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', `${label} must be a real directory, not a symbolic link`);
    }
    const canonical = await realpath(target);
    return { path: target, canonical, device: info.dev, inode: info.ino };
  }

  private async assertDirectoryIdentity(directory: DirectoryIdentity): Promise<void> {
    const current = await lstat(directory.path).catch(() => undefined);
    if (
      !current?.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== directory.device
      || current.ino !== directory.inode
      || !samePath(await realpath(directory.path), directory.canonical)
    ) throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime storage changed during the operation');
  }

  private async assertRuntimeDirectories(directories: RuntimeDirectories): Promise<void> {
    await this.assertDirectoryIdentity(directories.userData);
    await this.assertDirectoryIdentity(directories.root);
    await this.assertDirectoryIdentity(directories.versions);
    if (
      !samePath(path.dirname(directories.root.canonical), directories.userData.canonical)
      || !samePath(path.dirname(directories.versions.canonical), directories.root.canonical)
    ) throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime storage escaped Research IDE application data');
  }

  private async ensureOwnerMarker(root: DirectoryIdentity, create: boolean): Promise<void> {
    const markerPath = path.join(root.canonical, RUNTIME_MARKER_NAME);
    let info = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info && create) {
      await this.assertDirectoryIdentity(root);
      const handle = await open(markerPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          schemaVersion: 1,
          installId: DISTRIBUTION_IDENTITY.installId,
          kind: RUNTIME_MARKER_KIND,
        }, null, 2)}\n`, 'utf8');
        await flushFileHandle(handle);
      } finally { await handle.close(); }
      await syncParentDirectory(markerPath);
      info = await lstat(markerPath);
    }
    if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 4_096) {
      throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime ownership marker is missing or unsafe');
    }
    let marker: { schemaVersion?: unknown; installId?: unknown; kind?: unknown };
    try { marker = JSON.parse(await readStableRegularFile(markerPath, 4_096, 'CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime ownership marker is unsafe')) as typeof marker; }
    catch { throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime ownership marker is invalid JSON'); }
    if (marker.schemaVersion !== 1 || marker.installId !== DISTRIBUTION_IDENTITY.installId || marker.kind !== RUNTIME_MARKER_KIND) {
      throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime ownership marker does not belong to Research IDE');
    }
    await this.assertDirectoryIdentity(root);
  }

  private async readSelection(): Promise<SelectionRecord | undefined> {
    const directories = await this.runtimeDirectories(false);
    if (!directories) return undefined;
    await this.assertRuntimeDirectories(directories);
    const recordPath = path.join(directories.root.canonical, 'selection.json');
    const info = await lstat(recordPath).catch(() => undefined); if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 32 * 1024) throw new AppError('CODEX_RUNTIME_SELECTION_INVALID', 'Codex runtime selection record is unsafe');
    let record: SelectionRecord;
    try { record = JSON.parse(await readStableRegularFile(recordPath, 32 * 1024, 'CODEX_RUNTIME_SELECTION_INVALID', 'Codex runtime selection record is unsafe')) as SelectionRecord; }
    catch (error) {
      if (error instanceof AppError && error.code === 'CODEX_RUNTIME_SELECTION_INVALID') throw error;
      throw new AppError('CODEX_RUNTIME_SELECTION_INVALID', 'Codex runtime selection record is invalid JSON');
    }
    if (
      record.schemaVersion !== RECORD_SCHEMA_VERSION
      || !['imported', 'managed'].includes(record.source)
      || !VERSION_PATTERN.test(record.version)
      || !/^[a-f0-9]{64}$/u.test(record.sha256)
      || typeof record.selectedAt !== 'string'
      || !Number.isFinite(Date.parse(record.selectedAt))
      || (record.source === 'imported' && (typeof record.path !== 'string' || !path.isAbsolute(record.path) || record.path.length > 8_192 || record.path.includes('\0')))
    ) throw new AppError('CODEX_RUNTIME_SELECTION_INVALID', 'Codex runtime selection record failed validation');
    await this.assertRuntimeDirectories(directories);
    return record;
  }

  private async writeSelection(record: SelectionRecord): Promise<void> {
    const directories = await this.ensureRoot();
    await this.atomicJson(path.join(directories.root.canonical, 'selection.json'), record, directories.root);
  }

  private async atomicJson(target: string, value: unknown, directory: DirectoryIdentity): Promise<void> {
    await this.assertDirectoryIdentity(directory);
    if (!samePath(path.dirname(target), directory.canonical)) throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime record target escaped its owned directory');
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime record target is unsafe');
    const temporary = `${target}.${randomUUID()}.tmp`; const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await flushFileHandle(handle); }
    finally { await handle.close(); }
    try {
      await this.assertDirectoryIdentity(directory);
      try { await rename(temporary, target); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !existing || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
        const backup = `${target}.${randomUUID()}.old`;
        await rename(target, backup);
        try {
          await rename(temporary, target);
          await rm(backup, { force: true, recursive: false });
        } catch (replacementError) {
          if (!await lstat(target).catch(() => undefined)) await rename(backup, target).catch(() => undefined);
          throw replacementError;
        }
      }
      await syncParentDirectory(target);
      await this.assertDirectoryIdentity(directory);
    }
    finally { await rm(temporary, { force: true }); }
  }

  private async removeOwnedStaging(staging: string): Promise<void> {
    if (!/^\.install-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(path.basename(staging))) return;
    const directories = await this.runtimeDirectories(false);
    if (!directories || !samePath(path.dirname(staging), directories.root.canonical)) return;
    await this.assertRuntimeDirectories(directories);
    const info = await lstat(staging).catch(() => undefined);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime staging target is unsafe');
    const canonical = await realpath(staging);
    if (!samePath(path.dirname(canonical), directories.root.canonical)) throw new AppError('CODEX_RUNTIME_UNSAFE_ROOT', 'Codex runtime staging target escaped its owned directory');
    await rm(canonical, { recursive: true, force: true });
    await this.assertRuntimeDirectories(directories);
  }
}

export const codexRuntimeInternals = { runtimeTarget, compareVersions, parseVersion, isOfficialReleaseUrl, extractSingleTarGz };
