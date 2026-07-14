import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedToolchainService, managedToolchainInternals } from './managed-toolchain-service';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'research-ide-managed-tools-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('managed toolchain catalog verification', () => {
  it('uses a versioned LLVM/Clang package instead of the generic compiler metapackage', () => {
    expect(managedToolchainInternals.definitions.compiler).toMatchObject({
      packageName: 'clangxx',
      displayName: 'LLVM Clang C/C++',
    });
  });

  it('keeps only main-channel versions for the current platform and sorts newest first', () => {
    const versions = managedToolchainInternals.parseCatalogVersions({ files: [
      { version: '3.12.9', attrs: { subdir: 'linux-64' }, labels: ['main'] },
      { version: '3.13.2', attrs: { subdir: 'linux-64' }, labels: ['main'] },
      { version: '3.14.0rc1', attrs: { subdir: 'linux-64' }, labels: ['dev'] },
      { version: '9.9.9', attrs: { subdir: 'win-64' }, labels: ['main'] },
      { version: '../escape', attrs: { subdir: 'linux-64' }, labels: ['main'] },
    ] }, 'linux-64');

    expect(versions).toEqual(['3.13.2', '3.12.9']);
  });

  it('requires the exact Pixi platform asset and a GitHub SHA-256 digest', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(managedToolchainInternals.selectPixiAsset({
      tag_name: 'v0.55.0',
      assets: [{
        name: 'pixi-x86_64-unknown-linux-musl',
        browser_download_url: 'https://github.com/prefix-dev/pixi/releases/download/v0.55.0/pixi-x86_64-unknown-linux-musl',
        digest,
        size: 42,
      }],
    }, 'linux', 'x64')).toMatchObject({ version: '0.55.0', asset: { digest } });

    expect(() => managedToolchainInternals.selectPixiAsset({
      tag_name: 'v0.55.0',
      assets: [{
        name: 'pixi-x86_64-unknown-linux-musl',
        browser_download_url: 'https://github.com/prefix-dev/pixi/releases/download/v0.55.0/pixi',
        digest: null,
        size: 42,
      }],
    }, 'linux', 'x64')).toThrow(/digest|verified/iu);
  });
});

describe('managed toolchain installation records', () => {
  it.skipIf(process.platform === 'win32')('installs into an isolated version directory and detects later tampering', async () => {
    const root = await temporaryRoot();
    const events: string[] = [];
    const service = new ManagedToolchainService(root, (event) => events.push(event.phase), {
      platform: 'linux',
      arch: 'x64',
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      requestJson: async () => ({
        files: [{ version: '3.13.7', attrs: { subdir: 'linux-64' }, labels: ['main'] }],
      }),
      pixiExecutable: async () => ({ path: '/verified-test-pixi', version: '0.55.0' }),
      runCommand: async (_executable, args, cwd, env) => {
        expect(args).toEqual(['install', '--manifest-path', path.join(cwd, 'pixi.toml'), '--no-config']);
        expect(env).toMatchObject({
          PIXI_NO_CONFIG: 'true',
          PIXI_NO_PROGRESS: 'true',
        });
        for (const key of ['PIXI_NO_CONFIG', 'PIXI_NO_PROGRESS']) {
          expect(env[key]).toBe('true');
          expect(env[key]).not.toBe('1');
          expect(env[key]).not.toBe('0');
        }
        expect(env.PIXI_NO_SYMBOLIC_LINKS).toBeUndefined();
        const executable = path.join(cwd, '.pixi', 'envs', 'default', 'bin', 'python3');
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, '#!/bin/sh\nprintf "Python 3.13.7\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const record = await service.install('python', '3.13.7');
    const verified = await service.verifyExecutable(record.executable);
    expect(verified.executable).toContain(path.join('python', '3.13.7', '.pixi', 'envs', 'default', 'bin', 'python3'));
    expect(events).toEqual(expect.arrayContaining(['preparing', 'resolving', 'installing', 'validating', 'completed']));
    expect(JSON.parse(await readFile(path.join(root, 'python', '3.13.7', 'install.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      toolId: 'python',
      version: '3.13.7',
      manager: { name: 'pixi', version: '0.55.0' },
    });

    const activation = await service.activationEnvironment(record.executable);
    expect(Object.keys(activation).sort()).toEqual(['CONDA_DEFAULT_ENV', 'CONDA_PREFIX', 'CONDA_SHLVL', 'PATH']);
    expect(activation).toMatchObject({
      CONDA_DEFAULT_ENV: 'research-ide-python-3.13.7',
      CONDA_SHLVL: '1',
    });
    expect(activation.CONDA_PREFIX).toBe(path.join(root, 'python', '3.13.7', '.pixi', 'envs', 'default'));
    expect(activation.PATH?.split(path.delimiter)).toContain(path.join(root, 'python', '3.13.7', '.pixi', 'envs', 'default', 'bin'));

    const catalog = await service.catalog('python', verified.executable);
    expect(catalog.versions.find((item) => item.version === '3.13.7')).toMatchObject({ installed: true, selected: true });

    await expect(service.install('python', '3.13.7')).resolves.toMatchObject({ version: '3.13.7' });
    expect(events.filter((phase) => phase === 'completed')).toHaveLength(2);

    await writeFile(verified.executable, '#!/bin/sh\nprintf "tampered\\n"\n', 'utf8');
    await expect(service.verifyExecutable(record.executable)).rejects.toThrow(/changed/iu);
    expect(await service.installed('python')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('allows package symlinks and removes a failed R environment before retrying', async () => {
    const root = await temporaryRoot();
    let attempts = 0;
    const service = new ManagedToolchainService(root, () => undefined, {
      platform: 'linux',
      arch: 'x64',
      requestJson: async () => ({
        files: [{ version: '4.5.2', attrs: { subdir: 'linux-64' }, labels: ['main'] }],
      }),
      pixiExecutable: async () => ({ path: '/verified-test-pixi', version: '0.72.2' }),
      runCommand: async (_executable, _args, cwd, env) => {
        attempts += 1;
        expect(env).toMatchObject({ PIXI_NO_CONFIG: 'true', PIXI_NO_PROGRESS: 'true' });
        expect(env.PIXI_NO_SYMBOLIC_LINKS).toBeUndefined();
        const environment = path.join(cwd, '.pixi', 'envs', 'default');
        const icu = path.join(environment, 'lib', 'icu-75');
        await mkdir(icu, { recursive: true });
        await symlink('icu-75', path.join(environment, 'lib', 'icu-current'), 'dir');
        if (attempts === 1) {
          await writeFile(path.join(environment, 'partial-install'), 'incomplete', 'utf8');
          return { code: 1, stdout: '', stderr: 'simulated package installation failure' };
        }
        const executable = path.join(environment, 'bin', 'R');
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(executable, 0o700);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    await expect(service.install('r', '4.5.2')).rejects.toThrow(/simulated package installation failure/iu);
    await expect(lstat(path.join(root, 'r', '4.5.2'))).rejects.toMatchObject({ code: 'ENOENT' });

    const record = await service.install('r', '4.5.2');
    expect(record).toMatchObject({ toolId: 'r', version: '4.5.2', manager: { version: '0.72.2' } });
    expect((await lstat(path.join(root, 'r', '4.5.2', '.pixi', 'envs', 'default', 'lib', 'icu-current'))).isSymbolicLink()).toBe(true);
    expect(attempts).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('rejects a managed root that is a symbolic link', async () => {
    const parent = await temporaryRoot();
    const realRoot = path.join(parent, 'real');
    const linkedRoot = path.join(parent, 'linked');
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, 'dir');
    const service = new ManagedToolchainService(linkedRoot, () => undefined, { platform: 'linux', arch: 'x64' });

    await expect(service.installed('python')).rejects.toThrow(/real directories|outside|unsafe/iu);
  });

  it.skipIf(process.platform === 'win32')('rejects an unsafe version-directory link and emits a terminal failure', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(path.join(root, 'python'));
    await symlink(outside, path.join(root, 'python', '1.0.0'), 'dir');
    const events: string[] = [];
    const service = new ManagedToolchainService(root, (event) => events.push(event.phase), {
      platform: 'linux', arch: 'x64',
      requestJson: async () => ({ files: [{ version: '1.0.0', attrs: { subdir: 'linux-64' }, labels: ['main'] }] }),
    });

    await expect(service.install('python', '1.0.0')).rejects.toThrow(/real directories|unsafe/iu);
    expect(events.at(-1)).toBe('failed');
  });

  it('serializes Pixi bootstrap across tools and emits completion for each operation', async () => {
    const root = await temporaryRoot();
    let bootstrapCount = 0;
    let releaseBootstrap!: () => void;
    const bootstrapRelease = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    const terminal: string[] = [];
    const service = new ManagedToolchainService(root, (event) => {
      if (event.phase === 'completed' || event.phase === 'failed') terminal.push(`${event.toolId}:${event.phase}`);
    }, {
      platform: 'linux', arch: 'x64',
      requestJson: async () => ({ files: [{ version: '1.0.0', attrs: { subdir: 'linux-64' }, labels: ['main'] }] }),
      pixiExecutable: async () => {
        bootstrapCount += 1;
        await bootstrapRelease;
        return { path: '/verified-test-pixi', version: '0.55.0' };
      },
      runCommand: async (_executable, _args, cwd) => {
        const isPython = cwd.includes(`${path.sep}python${path.sep}`);
        const executable = path.join(cwd, '.pixi', 'envs', 'default', 'bin', isPython ? 'python3' : 'pandoc');
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(executable, 0o700);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const installations = [service.install('python', '1.0.0'), service.install('pandoc', '1.0.0')];
    while (!bootstrapCount) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseBootstrap();
    await Promise.all(installations);
    expect(bootstrapCount).toBe(1);
    expect(terminal.sort()).toEqual(['pandoc:completed', 'python:completed']);
  });

  it('blocks removal during installation and stopAll waits for cancellation and a terminal event', async () => {
    const root = await temporaryRoot();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const events: string[] = [];
    const service = new ManagedToolchainService(root, (event) => events.push(event.phase), {
      platform: 'linux', arch: 'x64',
      requestJson: async () => ({ files: [{ version: '1.0.0', attrs: { subdir: 'linux-64' }, labels: ['main'] }] }),
      pixiExecutable: async () => ({ path: '/verified-test-pixi', version: '0.55.0' }),
      runCommand: async (_executable, _args, _cwd, _env, _timeout, signal) => new Promise((_resolve, reject) => {
        started();
        const cancel = (): void => reject(new Error('cancelled by test'));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      }),
    });

    const installation = service.install('python', '1.0.0');
    const rejectedInstallation = expect(installation).rejects.toThrow(/cancelled/iu);
    await running;
    await expect(service.remove('python', '1.0.0')).rejects.toThrow(/in progress|another operation/iu);
    await service.stopAll();
    await rejectedInstallation;
    expect(events.at(-1)).toBe('failed');
    await expect(service.remove('python', '1.0.0')).rejects.toThrow(/not installed/iu);
  });

  it('safely replaces an existing catalog cache record', async () => {
    const root = await temporaryRoot();
    let version = '1.0.0';
    const service = new ManagedToolchainService(root, () => undefined, {
      platform: process.platform === 'win32' ? 'win32' : 'linux', arch: 'x64',
      requestJson: async () => ({ files: [{ version, attrs: { subdir: process.platform === 'win32' ? 'win-64' : 'linux-64' }, labels: ['main'] }] }),
    });

    expect((await service.catalog('python')).versions.map((item) => item.version)).toContain('1.0.0');
    version = '2.0.0';
    expect((await service.catalog('python')).versions.map((item) => item.version)).toContain('2.0.0');
    const cache = JSON.parse(await readFile(path.join(root, '.catalog', `python-${process.platform === 'win32' ? 'win-64' : 'linux-64'}.json`), 'utf8')) as { payload: { files: Array<{ version: string }> } };
    expect(cache.payload.files[0]?.version).toBe('2.0.0');
  });

  it('rejects versions that are absent from the verified package catalog', async () => {
    const root = await temporaryRoot();
    let executed = false;
    const service = new ManagedToolchainService(root, () => undefined, {
      platform: 'linux', arch: 'x64',
      requestJson: async () => ({ files: [{ version: '1.0.0', attrs: { subdir: 'linux-64' }, labels: ['main'] }] }),
      pixiExecutable: async () => ({ path: '/unused', version: '0.55.0' }),
      runCommand: async () => { executed = true; return { code: 0, stdout: '', stderr: '' }; },
    });

    await expect(service.install('python', '2.0.0')).rejects.toThrow(/verified catalog/iu);
    expect(executed).toBe(false);
  });
});
