import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_DATA_MARKER_NAME,
  ensureApplicationDataMarker,
  recoverStaleLinuxSingleton,
  RESEARCH_IDE_INSTALL_ID,
  StartupLogger,
} from './startup-guard';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'research-ide-startup-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('desktop startup guard', () => {
  it('creates and validates an application-data ownership marker', async () => {
    const root = await temporaryRoot();
    expect(ensureApplicationDataMarker(root, path.join(root, 'not-home'))).toBe(root);
    expect(JSON.parse(await readFile(path.join(root, APP_DATA_MARKER_NAME), 'utf8'))).toEqual({
      schemaVersion: 1, installId: RESEARCH_IDE_INSTALL_ID, kind: 'application-data',
    });

    await writeFile(path.join(root, APP_DATA_MARKER_NAME), '{"installId":"another-app"}\n', 'utf8');
    expect(() => ensureApplicationDataMarker(root, path.join(root, 'not-home'))).toThrow(/does not match/i);
  });

  it('refuses application-data markers at a filesystem root or home directory', async () => {
    const root = await temporaryRoot();
    expect(() => ensureApplicationDataMarker(path.parse(root).root, root)).toThrow(/filesystem root/i);
    expect(() => ensureApplicationDataMarker(root, root)).toThrow(/home directory/i);
  });

  it('removes only unchanged symlink artifacts for a confirmed dead Linux singleton', async () => {
    const root = await temporaryRoot();
    await Promise.all([
      symlink('test-host-424242', path.join(root, 'SingletonLock')),
      symlink('cookie-value', path.join(root, 'SingletonCookie')),
      symlink('/tmp/research-ide-stale-socket', path.join(root, 'SingletonSocket')),
    ]);

    expect(recoverStaleLinuxSingleton(root, {
      platform: 'linux', hostname: 'test-host', pidAlive: () => false,
    })).toBe('recovered');
    await expect(readlink(path.join(root, 'SingletonLock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readlink(path.join(root, 'SingletonCookie'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readlink(path.join(root, 'SingletonSocket'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves singleton artifacts untouched for a live PID or unsafe marker', async () => {
    const root = await temporaryRoot();
    await symlink('test-host-321', path.join(root, 'SingletonLock'));
    expect(recoverStaleLinuxSingleton(root, {
      platform: 'linux', hostname: 'test-host', pidAlive: () => true,
    })).toBe('active');
    expect(await readlink(path.join(root, 'SingletonLock'))).toBe('test-host-321');

    await rm(path.join(root, 'SingletonLock'));
    await mkdir(path.join(root, 'SingletonLock'));
    expect(recoverStaleLinuxSingleton(root, {
      platform: 'linux', hostname: 'test-host', pidAlive: () => false,
    })).toBe('unsafe');
  });

  it('writes bounded startup diagnostics with credential-shaped values redacted', async () => {
    const root = await temporaryRoot();
    const logger = new StartupLogger(root);
    logger.write('startup-failed', { detail: 'api_key=sk-test-secret-value Bearer abcdefghijk' });
    const reopenedLogger = new StartupLogger(root);
    reopenedLogger.write('second-launch');
    const log = await readFile(path.join(root, 'logs', 'startup.log'), 'utf8');
    expect(log).toContain('startup-failed');
    expect(log).toContain('second-launch');
    expect(log).toContain('[REDACTED]');
    expect(log).not.toContain('sk-test-secret-value');
    expect(log).not.toContain('abcdefghijk');
  });
});
