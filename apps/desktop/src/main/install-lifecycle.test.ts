import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyApplicationVersion,
  compareApplicationVersions,
  installLifecycleInternals,
  recordApplicationVersion,
  recordWindowsInstallerEvent,
  windowsSquirrelAction,
} from './install-lifecycle';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'research-ide-install-lifecycle-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('application installation lifecycle', () => {
  it('orders stable and prerelease SemVer transitions', () => {
    expect(compareApplicationVersions('0.2.0-beta.2', '0.2.0-beta.11')).toBe(-1);
    expect(compareApplicationVersions('0.2.0-rc.1', '0.2.0')).toBe(-1);
    expect(compareApplicationVersions('0.2.0+build.1', '0.2.0+build.2')).toBe(0);
    expect(classifyApplicationVersion('0.1.9', '0.2.0')).toMatchObject({ kind: 'upgrade' });
    expect(classifyApplicationVersion('0.3.0', '0.2.0')).toMatchObject({ kind: 'downgrade' });
    expect(() => classifyApplicationVersion(undefined, '01.2.3')).toThrow(/SemVer/u);
  });

  it('records only an app-owned version marker and detects upgrade and downgrade once', async () => {
    const base = await temporaryRoot();
    const userData = path.join(base, 'Research IDE');
    const project = path.join(base, 'paper');
    await mkdir(project);
    const manuscript = path.join(project, 'paper.md');
    await writeFile(manuscript, 'research content', 'utf8');

    expect(
      recordApplicationVersion(userData, '0.1.0', new Date('2026-01-01T00:00:00.000Z')),
    ).toEqual({
      kind: 'first-run',
      currentVersion: '0.1.0',
    });
    expect(recordApplicationVersion(userData, '0.2.0')).toMatchObject({
      kind: 'upgrade',
      previousVersion: '0.1.0',
      currentVersion: '0.2.0',
    });
    expect(recordApplicationVersion(userData, '0.2.0')).toMatchObject({ kind: 'same-version' });
    expect(recordApplicationVersion(userData, '0.1.5')).toMatchObject({
      kind: 'downgrade',
      previousVersion: '0.2.0',
      currentVersion: '0.1.5',
    });

    await expect(readFile(manuscript, 'utf8')).resolves.toBe('research content');
    const state = JSON.parse(
      await readFile(path.join(userData, installLifecycleInternals.VERSION_STATE_NAME), 'utf8'),
    ) as Record<string, unknown>;
    expect(state).toMatchObject({
      schemaVersion: 1,
      installId: 'org.researchide.desktop',
      kind: 'application-version-state',
      version: '0.1.5',
    });
  });

  it('refuses to replace an unsafe version-state path', async () => {
    const base = await temporaryRoot();
    const userData = path.join(base, 'Research IDE');
    recordApplicationVersion(userData, '0.1.0');
    const statePath = path.join(userData, installLifecycleInternals.VERSION_STATE_NAME);
    await rm(statePath);
    await mkdir(statePath);

    expect(() => recordApplicationVersion(userData, '0.2.0')).toThrow(/unsafe/u);
  });

  it('distinguishes exact Windows Squirrel lifecycle commands only on Windows', () => {
    expect(windowsSquirrelAction('win32', ['research-ide.exe', '--squirrel-install'])).toBe(
      'install',
    );
    expect(windowsSquirrelAction('win32', ['research-ide.exe', '--squirrel-updated'])).toBe(
      'update',
    );
    expect(windowsSquirrelAction('win32', ['research-ide.exe', '--squirrel-uninstall'])).toBe(
      'uninstall',
    );
    expect(windowsSquirrelAction('win32', ['research-ide.exe', '--squirrel-obsolete'])).toBe(
      'obsolete',
    );
    expect(
      windowsSquirrelAction('win32', ['research-ide.exe', '--squirrel-updated-extra']),
    ).toBeUndefined();
    expect(windowsSquirrelAction('linux', ['research-ide', '--squirrel-updated'])).toBeUndefined();
  });

  it('records install and update separately without creating data for uninstall', async () => {
    const base = await temporaryRoot();
    const userData = path.join(base, 'Research IDE');
    expect(recordWindowsInstallerEvent(userData, 'install', '0.1.0')).toBe(true);
    expect(recordWindowsInstallerEvent(userData, 'update', '0.2.0')).toBe(true);
    const events = (await readFile(path.join(userData, 'logs', 'startup.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; details: Record<string, string> });
    expect(
      events.map((event) => [event.event, event.details.action, event.details.version]),
    ).toEqual([
      ['windows-installer-event', 'install', '0.1.0'],
      ['windows-installer-event', 'update', '0.2.0'],
    ]);

    const removedUserData = path.join(base, 'removed-user-data');
    expect(recordWindowsInstallerEvent(removedUserData, 'uninstall', '0.2.0')).toBe(false);
    await expect(stat(removedUserData)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
