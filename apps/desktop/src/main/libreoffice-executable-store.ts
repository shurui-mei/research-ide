import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import type { LibreOfficeExecutableStatus } from '../shared/types';
import { AppError } from './errors';
import { flushFileHandle, syncParentDirectory } from './file-durability';

const RECORD_SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;

interface TrustedExecutableRecord {
  schemaVersion: 1;
  path: string;
  sha256: string;
  confirmedAt: string;
}

interface DirectoryIdentity {
  path: string;
  canonical: string;
  device: number;
  inode: number;
}

export interface PreparedLibreOfficeExecutable {
  path: string;
  sha256: string;
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

function appErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'The saved executable selection is invalid';
}

/**
 * Stores an explicit user trust decision for a non-standard LibreOffice
 * executable. The record lives exclusively below Electron's userData path;
 * projects never receive executable paths or fingerprints.
 */
export class LibreOfficeExecutableStore {
  private readonly userDataPath: string;

  constructor(
    userDataPath: string,
    private readonly currentProjectRoot: () => string | undefined,
  ) {
    this.userDataPath = path.resolve(userDataPath);
  }

  /** Called during application startup so a stale record is checked eagerly. */
  async initialize(): Promise<LibreOfficeExecutableStatus> {
    return this.status();
  }

  async prepareSelection(candidate: string): Promise<PreparedLibreOfficeExecutable> {
    return this.inspectExecutable(candidate);
  }

  async confirmSelection(prepared: PreparedLibreOfficeExecutable): Promise<LibreOfficeExecutableStatus> {
    if (
      !prepared
      || typeof prepared.path !== 'string'
      || typeof prepared.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(prepared.sha256)
    ) {
      throw new AppError('INVALID_LIBREOFFICE_SELECTION', 'The LibreOffice selection confirmation is invalid');
    }
    // Revalidate after the confirmation dialog. This closes the window in
    // which the selected file could otherwise be replaced before persistence.
    const verified = await this.inspectExecutable(prepared.path);
    if (verified.sha256 !== prepared.sha256) {
      throw new AppError('LIBREOFFICE_EXECUTABLE_CHANGED', 'The selected LibreOffice executable changed before it could be trusted; select it again');
    }
    const record: TrustedExecutableRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      path: verified.path,
      sha256: verified.sha256,
      confirmedAt: new Date().toISOString(),
    };
    const directory = await this.configDirectory(true);
    if (!directory) throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'Could not create the LibreOffice application-data directory');
    await this.atomicWriteRecord(directory, record);
    return { state: 'ready', source: 'custom', path: record.path, sha256: record.sha256 };
  }

  async clear(): Promise<LibreOfficeExecutableStatus> {
    const directory = await this.configDirectory(false);
    if (!directory) return { state: 'notConfigured' };
    await this.assertDirectoryIdentity(directory);
    const recordPath = path.join(directory.canonical, 'trusted-executable.json');
    const info = await lstat(recordPath).catch(() => undefined);
    if (info?.isSymbolicLink() || (info && !info.isFile())) {
      throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The saved LibreOffice selection is not a regular application-data file');
    }
    await rm(recordPath, { force: true, recursive: false });
    await this.assertDirectoryIdentity(directory);
    return { state: 'notConfigured' };
  }

  /**
   * Resolver seam used by LibreOfficeConverter. It rereads and rehashes the
   * selected executable before every conversion. Invalid records deliberately
   * throw instead of falling through to another executable.
   */
  async resolveExecutable(): Promise<string | undefined> {
    const record = await this.readRecord();
    if (!record) return undefined;
    const verified = await this.inspectExecutable(record.path);
    if (verified.sha256 !== record.sha256) {
      throw new AppError('LIBREOFFICE_EXECUTABLE_CHANGED', 'The trusted LibreOffice executable was replaced or updated; review and select it again in Settings');
    }
    return verified.path;
  }

  async status(): Promise<LibreOfficeExecutableStatus> {
    let record: TrustedExecutableRecord | undefined;
    try {
      record = await this.readRecord();
      if (!record) return { state: 'notConfigured' };
      const executable = await this.resolveExecutable();
      return { state: 'ready', source: 'custom', path: executable, sha256: record.sha256 };
    } catch (error) {
      return {
        state: 'invalid',
        source: 'custom',
        path: record?.path,
        sha256: record?.sha256,
        detail: appErrorDetail(error),
      };
    }
  }

  private async inspectExecutable(candidate: string): Promise<PreparedLibreOfficeExecutable> {
    if (
      typeof candidate !== 'string'
      || !candidate
      || candidate.length > 8_192
      || candidate.includes('\0')
      || !path.isAbsolute(candidate)
    ) {
      throw new AppError('INVALID_LIBREOFFICE_SELECTION', 'Choose an absolute LibreOffice executable path');
    }
    const lexicalPath = path.resolve(candidate);
    const lexical = await lstat(lexicalPath).catch(() => undefined);
    if (!lexical || lexical.isSymbolicLink() || !lexical.isFile()) {
      throw new AppError('UNSAFE_LIBREOFFICE_EXECUTABLE', 'The selected LibreOffice path must be a real, regular file and cannot be a symbolic link');
    }
    const canonical = await realpath(lexicalPath);
    // This also rejects a lexical path that escaped through a symlink in one of
    // its parent directories. Only the canonical path is ever persisted.
    if (!samePath(lexicalPath, canonical)) {
      throw new AppError('UNSAFE_LIBREOFFICE_EXECUTABLE', 'The selected LibreOffice path traverses a symbolic link; choose the real executable path');
    }
    const canonicalInfo = await lstat(canonical);
    if (
      canonicalInfo.isSymbolicLink()
      || !canonicalInfo.isFile()
      || canonicalInfo.dev !== lexical.dev
      || canonicalInfo.ino !== lexical.ino
    ) {
      throw new AppError('UNSAFE_LIBREOFFICE_EXECUTABLE', 'The selected LibreOffice executable changed while it was being checked');
    }
    if (canonicalInfo.size <= 0 || canonicalInfo.size > MAX_EXECUTABLE_BYTES) {
      throw new AppError('UNSAFE_LIBREOFFICE_EXECUTABLE', 'The selected LibreOffice executable has an invalid size');
    }
    await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK).catch(() => {
      throw new AppError('LIBREOFFICE_NOT_EXECUTABLE', 'The selected LibreOffice file is not executable');
    });
    const projectRoot = this.currentProjectRoot();
    if (projectRoot) {
      const canonicalProject = await realpath(path.resolve(projectRoot)).catch(() => undefined);
      if (canonicalProject && isInside(canonicalProject, canonical)) {
        throw new AppError('PROJECT_EXECUTABLE_FORBIDDEN', 'LibreOffice cannot be trusted from inside the active project directory');
      }
    }
    return { path: canonical, sha256: await this.sha256StableFile(canonical, canonicalInfo) };
  }

  private async sha256StableFile(target: string, expected: Awaited<ReturnType<typeof lstat>>): Promise<string> {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await open(target, constants.O_RDONLY | noFollow);
    const digest = createHash('sha256');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size) {
        throw new AppError('LIBREOFFICE_EXECUTABLE_CHANGED', 'The selected LibreOffice executable changed before it could be hashed');
      }
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position);
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (position !== before.size) throw new AppError('LIBREOFFICE_EXECUTABLE_CHANGED', 'The selected LibreOffice executable changed while it was being hashed');
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
      ) {
        throw new AppError('LIBREOFFICE_EXECUTABLE_CHANGED', 'The selected LibreOffice executable changed while it was being hashed');
      }
      return digest.digest('hex');
    } finally {
      await handle.close();
    }
  }

  private async readRecord(): Promise<TrustedExecutableRecord | undefined> {
    const directory = await this.configDirectory(false);
    if (!directory) return undefined;
    await this.assertDirectoryIdentity(directory);
    const recordPath = path.join(directory.canonical, 'trusted-executable.json');
    const lexical = await lstat(recordPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!lexical) return undefined;
    if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.size <= 0 || lexical.size > MAX_RECORD_BYTES) {
      throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The saved LibreOffice selection is not a safe application-data file');
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await open(recordPath, constants.O_RDONLY | noFollow);
    let source: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== lexical.dev || opened.ino !== lexical.ino || opened.size !== lexical.size) {
        throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The saved LibreOffice selection changed while it was being read');
      }
      source = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    await this.assertDirectoryIdentity(directory);
    const current = await lstat(recordPath).catch(() => undefined);
    if (!current?.isFile() || current.isSymbolicLink() || current.dev !== lexical.dev || current.ino !== lexical.ino) {
      throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The saved LibreOffice selection changed while it was being read');
    }
    let value: unknown;
    try { value = JSON.parse(source); }
    catch { throw new AppError('INVALID_LIBREOFFICE_RECORD', 'The saved LibreOffice selection is not valid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AppError('INVALID_LIBREOFFICE_RECORD', 'The saved LibreOffice selection has an invalid format');
    }
    const record = value as Partial<TrustedExecutableRecord>;
    if (
      record.schemaVersion !== RECORD_SCHEMA_VERSION
      || typeof record.path !== 'string'
      || !path.isAbsolute(record.path)
      || record.path.length > 8_192
      || record.path.includes('\0')
      || typeof record.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(record.sha256)
      || typeof record.confirmedAt !== 'string'
      || !Number.isFinite(Date.parse(record.confirmedAt))
    ) {
      throw new AppError('INVALID_LIBREOFFICE_RECORD', 'The saved LibreOffice selection has an invalid format');
    }
    return record as TrustedExecutableRecord;
  }

  private async configDirectory(create: boolean): Promise<DirectoryIdentity | undefined> {
    const rootLexical = await lstat(this.userDataPath).catch(async (error: NodeJS.ErrnoException) => {
      if (!create || error.code !== 'ENOENT') throw error;
      await mkdir(this.userDataPath, { recursive: true, mode: 0o700 });
      return lstat(this.userDataPath);
    });
    if (rootLexical.isSymbolicLink() || !rootLexical.isDirectory()) {
      throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The application user-data path is not a safe directory');
    }
    const rootCanonical = await realpath(this.userDataPath);
    const directoryPath = path.join(rootCanonical, 'legacy-doc');
    let lexical = await lstat(directoryPath).catch(() => undefined);
    if (!lexical && create) {
      await mkdir(directoryPath, { mode: 0o700 });
      lexical = await lstat(directoryPath);
    }
    if (!lexical) return undefined;
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
      throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The LibreOffice application-data directory is unsafe');
    }
    const canonical = await realpath(directoryPath);
    if (path.dirname(canonical) !== rootCanonical) {
      throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The LibreOffice application-data directory escapes userData');
    }
    return { path: directoryPath, canonical, device: lexical.dev, inode: lexical.ino };
  }

  private async assertDirectoryIdentity(directory: DirectoryIdentity): Promise<void> {
    const current = await lstat(directory.path).catch(() => undefined);
    if (
      !current?.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== directory.device
      || current.ino !== directory.inode
      || await realpath(directory.path) !== directory.canonical
    ) {
      throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The LibreOffice application-data directory changed during the operation');
    }
  }

  private async atomicWriteRecord(directory: DirectoryIdentity, record: TrustedExecutableRecord): Promise<void> {
    const target = path.join(directory.canonical, 'trusted-executable.json');
    const temporary = path.join(directory.canonical, `.trusted-executable-${randomUUID()}.tmp`);
    try {
      await this.assertDirectoryIdentity(directory);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await flushFileHandle(handle);
      } finally {
        await handle.close();
      }
      await this.assertDirectoryIdentity(directory);
      const existing = await lstat(target).catch(() => undefined);
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new AppError('UNSAFE_LIBREOFFICE_RECORD', 'The saved LibreOffice selection target is unsafe');
      }
      try {
        await rename(temporary, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !existing || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
        const backup = path.join(directory.canonical, `.trusted-executable-${randomUUID()}.old`);
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
    } finally {
      await rm(temporary, { force: true, recursive: false });
    }
  }
}

export const libreOfficeExecutableStoreInternals = {
  isInside,
  samePath,
  recordSchemaVersion: RECORD_SCHEMA_VERSION,
};
