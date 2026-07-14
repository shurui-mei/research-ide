import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibreOfficeExecutableStore } from './libreoffice-executable-store';

const temporaryRoots: string[] = [];

async function fixture(): Promise<{ base: string; userData: string; project: string; executable: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'research-ide-libreoffice-trust-'));
  temporaryRoots.push(base);
  const userData = path.join(base, 'user-data');
  const project = path.join(base, 'project');
  const portable = path.join(base, 'portable');
  await Promise.all([mkdir(userData), mkdir(project), mkdir(portable)]);
  const executable = path.join(portable, process.platform === 'win32' ? 'soffice.exe' : 'soffice');
  await writeFile(executable, Buffer.from('trusted-libreoffice-binary'));
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  return { base, userData, project, executable };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('trusted LibreOffice executable selection', () => {
  it('stores only a canonical path and fingerprint in userData and revalidates it', async () => {
    const { userData, project, executable } = await fixture();
    const store = new LibreOfficeExecutableStore(userData, () => project);
    const prepared = await store.prepareSelection(executable);
    const status = await store.confirmSelection(prepared);

    expect(status).toEqual({ state: 'ready', source: 'custom', path: executable, sha256: createHash('sha256').update('trusted-libreoffice-binary').digest('hex') });
    await expect(store.initialize()).resolves.toMatchObject({ state: 'ready', path: executable });
    await expect(store.resolveExecutable()).resolves.toBe(executable);
    const record = JSON.parse(await readFile(path.join(userData, 'legacy-doc', 'trusted-executable.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ schemaVersion: 1, path: executable, sha256: prepared.sha256 });
    expect(record).not.toHaveProperty('project');
    await expect(readFile(path.join(project, '.research_ide', 'trusted-executable.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks a trusted executable after its bytes are replaced', async () => {
    const { userData, project, executable } = await fixture();
    const store = new LibreOfficeExecutableStore(userData, () => project);
    await store.confirmSelection(await store.prepareSelection(executable));
    await writeFile(executable, Buffer.from('replaced-libreoffice-binary'));

    await expect(store.resolveExecutable()).rejects.toMatchObject({ code: 'LIBREOFFICE_EXECUTABLE_CHANGED' });
    await expect(store.initialize()).resolves.toMatchObject({ state: 'invalid', path: executable });
  });

  it('revalidates after the confirmation dialog before writing the record', async () => {
    const { userData, project, executable } = await fixture();
    const store = new LibreOfficeExecutableStore(userData, () => project);
    const prepared = await store.prepareSelection(executable);
    await writeFile(executable, Buffer.from('changed-before-confirmation'));

    await expect(store.confirmSelection(prepared)).rejects.toMatchObject({ code: 'LIBREOFFICE_EXECUTABLE_CHANGED' });
    await expect(store.status()).resolves.toEqual({ state: 'notConfigured' });
  });

  it('rejects executables inside the active project', async () => {
    const { userData, project } = await fixture();
    const executable = path.join(project, process.platform === 'win32' ? 'soffice.exe' : 'soffice');
    await writeFile(executable, Buffer.from('project-controlled-executable'));
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    const store = new LibreOfficeExecutableStore(userData, () => project);

    await expect(store.prepareSelection(executable)).rejects.toMatchObject({ code: 'PROJECT_EXECUTABLE_FORBIDDEN' });
  });

  it.skipIf(process.platform === 'win32')('rejects direct and parent-directory symbolic links', async () => {
    const { base, userData, project, executable } = await fixture();
    const directLink = path.join(base, 'soffice-link');
    const directoryLink = path.join(base, 'portable-link');
    await symlink(executable, directLink);
    await symlink(path.dirname(executable), directoryLink, 'dir');
    const store = new LibreOfficeExecutableStore(userData, () => project);

    await expect(store.prepareSelection(directLink)).rejects.toMatchObject({ code: 'UNSAFE_LIBREOFFICE_EXECUTABLE' });
    await expect(store.prepareSelection(path.join(directoryLink, path.basename(executable)))).rejects.toMatchObject({ code: 'UNSAFE_LIBREOFFICE_EXECUTABLE' });
  });

  it.skipIf(process.platform === 'win32')('rejects a regular file without execute permission', async () => {
    const { userData, project, executable } = await fixture();
    await chmod(executable, 0o600);
    const store = new LibreOfficeExecutableStore(userData, () => project);

    await expect(store.prepareSelection(executable)).rejects.toMatchObject({ code: 'LIBREOFFICE_NOT_EXECUTABLE' });
  });

  it('removes the app-level trust record without changing the executable', async () => {
    const { userData, project, executable } = await fixture();
    const store = new LibreOfficeExecutableStore(userData, () => project);
    await store.confirmSelection(await store.prepareSelection(executable));

    await expect(store.clear()).resolves.toEqual({ state: 'notConfigured' });
    await expect(store.resolveExecutable()).resolves.toBeUndefined();
    await expect(readFile(executable, 'utf8')).resolves.toBe('trusted-libreoffice-binary');
  });
});
