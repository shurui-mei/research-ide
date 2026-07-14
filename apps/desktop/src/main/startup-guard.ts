import { hostname, homedir } from 'node:os';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DISTRIBUTION_IDENTITY } from '../shared/distribution';

export const RESEARCH_IDE_INSTALL_ID = DISTRIBUTION_IDENTITY.installId;
export const APP_DATA_MARKER_NAME = '.research-ide-app-data.json';

interface FileIdentity {
  dev: number;
  ino: number;
  target: string;
}

export type SingletonRecovery = 'not-applicable' | 'none' | 'active' | 'recovered' | 'unsafe';

function boundedDiagnostic(value: unknown): string {
  return String(value ?? '')
    .replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{6,}\b/gu, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/(?:api[_ -]?key|token|secret)\s*[:=]\s*[^\s,"']+/giu, '$1=[REDACTED]')
    .slice(0, 500);
}

function safeApplicationDataRoot(userDataPath: string, homePath = homedir()): string {
  const root = path.resolve(userDataPath);
  const filesystemRoot = path.parse(root).root;
  if (root === filesystemRoot || root === path.resolve(homePath)) {
    throw new Error('Refusing to use a filesystem root or home directory as Research IDE application data');
  }
  return root;
}

export function ensureApplicationDataMarker(userDataPath: string, homePath = homedir()): string {
  const root = safeApplicationDataRoot(userDataPath, homePath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Research IDE application data must be a real directory');
  }

  const markerPath = path.join(root, APP_DATA_MARKER_NAME);
  try {
    const info = lstatSync(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Research IDE application-data marker is unsafe');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    if (marker.schemaVersion !== 1 || marker.installId !== RESEARCH_IDE_INSTALL_ID || marker.kind !== 'application-data') {
      throw new Error('Research IDE application-data marker does not match this application');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      installId: RESEARCH_IDE_INSTALL_ID,
      kind: 'application-data',
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  return root;
}

export class StartupLogger {
  private readonly logPath: string;

  constructor(userDataPath: string) {
    const root = ensureApplicationDataMarker(userDataPath);
    const logs = path.join(root, 'logs');
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const info = lstatSync(logs);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Research IDE startup log directory is unsafe');
    this.logPath = path.join(logs, 'startup.log');
    try {
      const logInfo = lstatSync(this.logPath);
      if (!logInfo.isFile() || logInfo.isSymbolicLink()) throw new Error('Research IDE startup log is unsafe');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  write(event: string, details: Record<string, unknown> = {}): void {
    const safeDetails = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, boundedDiagnostic(value)]));
    appendFileSync(this.logPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: boundedDiagnostic(event),
      details: safeDetails,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function singletonIdentity(filePath: string): FileIdentity | undefined {
  try {
    const info = lstatSync(filePath);
    if (!info.isSymbolicLink()) return undefined;
    return { dev: info.dev, ino: info.ino, target: readlinkSync(filePath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function unlinkUnchangedSymlink(filePath: string, expected: FileIdentity): boolean {
  const current = singletonIdentity(filePath);
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino || current.target !== expected.target) return false;
  unlinkSync(filePath);
  return true;
}

export function recoverStaleLinuxSingleton(
  userDataPath: string,
  options: {
    platform?: NodeJS.Platform;
    hostname?: string;
    pidAlive?: (pid: number) => boolean;
  } = {},
): SingletonRecovery {
  if ((options.platform ?? process.platform) !== 'linux') return 'not-applicable';
  const root = safeApplicationDataRoot(userDataPath);
  const lockPath = path.join(root, 'SingletonLock');
  let lock: FileIdentity | undefined;
  try {
    const info = lstatSync(lockPath);
    if (!info.isSymbolicLink()) return 'unsafe';
    lock = { dev: info.dev, ino: info.ino, target: readlinkSync(lockPath) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unsafe';
  }

  const match = /^(.*)-(\d+)$/u.exec(lock.target);
  const expectedHostname = options.hostname ?? hostname();
  if (!match || match[1] !== expectedHostname) return 'unsafe';
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unsafe';
  if ((options.pidAlive ?? processIsAlive)(pid)) return 'active';

  const names = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'] as const;
  const identities = new Map<string, FileIdentity>();
  try {
    for (const name of names) {
      const identity = singletonIdentity(path.join(root, name));
      if (identity) identities.set(name, identity);
    }
    const currentLock = singletonIdentity(lockPath);
    if (!currentLock || currentLock.dev !== lock.dev || currentLock.ino !== lock.ino || currentLock.target !== lock.target) return 'unsafe';
    if ((options.pidAlive ?? processIsAlive)(pid)) return 'active';
    for (const name of names) {
      const identity = identities.get(name);
      if (identity && !unlinkUnchangedSymlink(path.join(root, name), identity)) return 'unsafe';
    }
    return 'recovered';
  } catch {
    return 'unsafe';
  }
}

export const startupGuardInternals = { boundedDiagnostic, safeApplicationDataRoot };
