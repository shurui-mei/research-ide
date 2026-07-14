import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DISTRIBUTION_IDENTITY, type InstallerTransitionKind } from '../shared/distribution';
import { ensureApplicationDataMarker, StartupLogger } from './startup-guard';

const VERSION_STATE_NAME = 'application-version.json';
const MAX_STATE_BYTES = 16 * 1024;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

interface VersionState {
  schemaVersion: 1;
  installId: typeof DISTRIBUTION_IDENTITY.installId;
  kind: 'application-version-state';
  version: string;
  updatedAt: string;
}

export interface ApplicationVersionTransition {
  kind: InstallerTransitionKind;
  currentVersion: string;
  previousVersion?: string;
}

export type WindowsSquirrelAction = 'install' | 'update' | 'uninstall' | 'obsolete';

function parseVersion(value: string): ParsedVersion | undefined {
  if (value.length > 128) return undefined;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return undefined;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0')))
    return undefined;
  return { core, prerelease };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0)
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) return leftPart.length < rightPart.length ? -1 : 1;
      return leftPart < rightPart ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareApplicationVersions(
  leftValue: string,
  rightValue: string,
): number | undefined {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return undefined;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index])
      return left.core[index] < right.core[index] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function classifyApplicationVersion(
  previousVersion: string | undefined,
  currentVersion: string,
): ApplicationVersionTransition {
  if (!parseVersion(currentVersion))
    throw new Error('Research IDE application version is not valid SemVer');
  if (!previousVersion) return { kind: 'first-run', currentVersion };
  const comparison = compareApplicationVersions(previousVersion, currentVersion);
  if (comparison === undefined) return { kind: 'unknown', previousVersion, currentVersion };
  if (comparison === 0) return { kind: 'same-version', previousVersion, currentVersion };
  return { kind: comparison < 0 ? 'upgrade' : 'downgrade', previousVersion, currentVersion };
}

export function windowsSquirrelAction(
  platform: NodeJS.Platform,
  argv: readonly string[],
): WindowsSquirrelAction | undefined {
  if (platform !== 'win32') return undefined;
  switch (argv[1]) {
    case '--squirrel-install':
      return 'install';
    case '--squirrel-updated':
      return 'update';
    case '--squirrel-uninstall':
      return 'uninstall';
    case '--squirrel-obsolete':
      return 'obsolete';
    default:
      return undefined;
  }
}

export function recordWindowsInstallerEvent(
  userDataPath: string,
  action: WindowsSquirrelAction | undefined,
  currentVersion: string,
): boolean {
  if (action !== 'install' && action !== 'update') return false;
  if (!parseVersion(currentVersion))
    throw new Error('Research IDE application version is not valid SemVer');
  new StartupLogger(userDataPath).write('windows-installer-event', {
    action,
    version: currentVersion,
    packageIdentity: DISTRIBUTION_IDENTITY.windows.squirrelPackageName,
  });
  return true;
}

function readPreviousVersion(statePath: string): {
  exists: boolean;
  version?: string;
  identity?: { dev: number; ino: number };
} {
  if (!existsSync(statePath)) return { exists: false };
  const info = lstatSync(statePath);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Research IDE application version state is unsafe');
  const identity = { dev: info.dev, ino: info.ino };
  if (info.size > MAX_STATE_BYTES) return { exists: true, identity };
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<VersionState>;
    if (
      value.schemaVersion !== 1 ||
      value.installId !== DISTRIBUTION_IDENTITY.installId ||
      value.kind !== 'application-version-state' ||
      typeof value.version !== 'string'
    )
      return { exists: true, identity };
    return { exists: true, version: value.version, identity };
  } catch {
    return { exists: true, identity };
  }
}

function writeStateAtomically(
  root: string,
  rootIdentity: { dev: number; ino: number },
  statePath: string,
  previous: ReturnType<typeof readPreviousVersion>,
  state: VersionState,
): void {
  const temporary = path.join(root, `.application-version-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    const currentRoot = lstatSync(root);
    if (
      currentRoot.dev !== rootIdentity.dev ||
      currentRoot.ino !== rootIdentity.ino ||
      !currentRoot.isDirectory() ||
      currentRoot.isSymbolicLink()
    ) {
      throw new Error(
        'Research IDE application data directory changed while recording its version',
      );
    }
    if (previous.exists) {
      const current = lstatSync(statePath);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== previous.identity?.dev ||
        current.ino !== previous.identity?.ino
      ) {
        throw new Error('Research IDE application version state changed while being updated');
      }
    } else if (existsSync(statePath)) {
      throw new Error('Research IDE application version state appeared while being created');
    }
    renameSync(temporary, statePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* A failed operation may leave only this random, app-owned temp file. */
    }
  }
}

export function recordApplicationVersion(
  userDataPath: string,
  currentVersion: string,
  now: Date = new Date(),
): ApplicationVersionTransition {
  const root = ensureApplicationDataMarker(userDataPath);
  if (!parseVersion(currentVersion))
    throw new Error('Research IDE application version is not valid SemVer');
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Research IDE application data directory is unsafe');
  const rootIdentity = { dev: rootInfo.dev, ino: rootInfo.ino };
  const statePath = path.join(root, VERSION_STATE_NAME);
  const previous = readPreviousVersion(statePath);
  const transition = classifyApplicationVersion(
    previous.exists ? (previous.version ?? 'unknown') : undefined,
    currentVersion,
  );
  if (transition.kind === 'same-version') return transition;
  writeStateAtomically(root, rootIdentity, statePath, previous, {
    schemaVersion: 1,
    installId: DISTRIBUTION_IDENTITY.installId,
    kind: 'application-version-state',
    version: currentVersion,
    updatedAt: now.toISOString(),
  });
  return transition;
}

export const installLifecycleInternals = { VERSION_STATE_NAME, parseVersion };
