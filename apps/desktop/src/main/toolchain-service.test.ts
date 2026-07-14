import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectService } from './project-service';
import type { ManagedToolchainOptions } from './managed-toolchain-service';
import { ToolchainService, toolchainInternals } from './toolchain-service';

interface Fixture {
  base: string;
  root: string;
  userData: string;
  projects: ProjectService;
  toolchains: ToolchainService;
}

const fixtures: Fixture[] = [];
const originalPath = process.env.PATH;

async function fixture(managedOptions?: ManagedToolchainOptions): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'research-ide-toolchains-'));
  const parent = path.join(base, 'projects');
  const userData = path.join(base, 'user-data');
  await mkdir(parent);
  const projects = new ProjectService(userData, () => undefined);
  const summary = await projects.create({ name: 'paper', parentPath: parent, template: 'blank', initializeGit: false });
  const toolchains = new ToolchainService(projects, () => undefined, async () => undefined, async () => true, userData, () => undefined, managedOptions);
  const result = { base, root: summary.path, userData, projects, toolchains };
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  process.env.PATH = originalPath;
  for (const item of fixtures.splice(0)) {
    item.toolchains.endProjectSession();
    await item.projects.close().catch(() => undefined);
    await rm(item.base, { force: true, recursive: true });
  }
});

describe('automatic project toolchain detection', () => {
  it('includes common macOS GUI tool locations without relying on a shell profile', () => {
    const directories = toolchainInternals.systemToolSearchDirectories('darwin', '/usr/bin');
    expect(directories).toEqual(expect.arrayContaining(['/Library/TeX/texbin', '/opt/homebrew/bin', '/Library/Frameworks/R.framework/Resources/bin']));
  });

  it('uses the deduplicated macOS search directories for child PATH without project directories', async () => {
    const projectRoot = '/Users/researcher/paper';
    const projectBin = path.posix.join(projectRoot, 'bin');
    const directories = await toolchainInternals.childToolSearchDirectories(
      'darwin',
      [projectBin, '/usr/bin', '/Library/TeX/texbin', '/usr/bin'].join(path.posix.delimiter),
      '/Library/TeX/texbin/latexmk',
      projectRoot,
    );

    expect(directories).toEqual(expect.arrayContaining(['/Library/TeX/texbin', '/opt/homebrew/bin', '/Library/Frameworks/R.framework/Resources/bin']));
    expect(directories.filter((directory) => directory === '/Library/TeX/texbin')).toHaveLength(1);
    expect(directories).not.toContain(projectBin);
  });

  it('uses Windows path syntax and case-insensitive deduplication when win32 is simulated', async () => {
    const projectRoot = 'C:\\Users\\researcher\\paper';
    const projectBin = path.win32.join(projectRoot, 'bin');
    const toolDirectory = 'C:\\Research Tools\\bin';
    const directories = await toolchainInternals.childToolSearchDirectories(
      'win32',
      [projectBin, toolDirectory.toLowerCase(), 'D:\\Python\\Scripts'].join(path.win32.delimiter),
      path.win32.join(toolDirectory, 'python.exe'),
      projectRoot,
    );

    expect(directories).toContain(toolDirectory);
    expect(directories.filter((directory) => directory.toLowerCase() === toolDirectory.toLowerCase())).toHaveLength(1);
    expect(directories).toContain('D:\\Python\\Scripts');
    expect(directories).not.toContain(projectBin);
    expect(directories.every((directory) => path.win32.isAbsolute(directory))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('lets a selected executable resolve a helper from its own directory', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'research-ide-helper-path-'));
    try {
      const bin = path.join(base, 'selected-bin');
      const executable = path.join(bin, 'selected-python');
      const helper = path.join(bin, 'research-ide-version-helper');
      await mkdir(bin);
      await writeFile(helper, '#!/bin/sh\nprintf "helper-version 9.9\\n"\n', 'utf8');
      await writeFile(executable, '#!/bin/sh\nresearch-ide-version-helper\n', 'utf8');
      await chmod(helper, 0o700);
      await chmod(executable, 0o700);
      process.env.PATH = '';

      const result = await toolchainInternals.capture(executable, ['--version'], undefined, 7_000, path.join(base, 'project'));

      expect(result).toMatchObject({ code: 0, stdout: 'helper-version 9.9\n' });
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === 'win32')('joins one cached scan for project open and first panel access', async () => {
    const { base, toolchains } = await fixture();
    const bin = path.join(base, 'bin');
    const probes = path.join(base, 'probes.log');
    await mkdir(bin);
    for (const command of ['latexmk', 'python3', 'R', 'pandoc', 'cc', 'julia']) {
      const executable = path.join(bin, command);
      await writeFile(executable, `#!/bin/sh\nprintf 'probe\\n' >> '${probes}'\nprintf 'test-tool 1.0\\n'\n`, 'utf8');
      await chmod(executable, 0o700);
    }
    process.env.PATH = bin;
    toolchains.beginProjectSession();

    const background = toolchains.ensureDetected();
    const panel = toolchains.ensureDetected();
    expect(panel).toBe(background);
    await Promise.all([background, panel]);
    await toolchains.ensureDetected();

    expect((await readFile(probes, 'utf8')).trim().split('\n')).toHaveLength(6);
  });

  it.skipIf(process.platform === 'win32')('does not execute an unconfirmed custom path from project.toml', async () => {
    const { base, root, projects, toolchains } = await fixture();
    const sentinel = path.join(base, 'untrusted-ran');
    const executable = path.join(base, 'untrusted-python');
    await writeFile(executable, `#!/bin/sh\nprintf 'ran' > '${sentinel}'\nprintf 'untrusted 1.0\\n'\n`, 'utf8');
    await chmod(executable, 0o700);
    const configPath = path.join(root, '.research_ide', 'project.toml');
    const config = TOML.parse(await readFile(configPath, 'utf8'));
    config.toolchains = { python: { source: 'custom', path: executable } };
    await writeFile(configPath, TOML.stringify(config), 'utf8');
    await projects.close();
    await projects.open(root);
    process.env.PATH = '';
    toolchains.beginProjectSession();

    const tools = await toolchains.ensureDetected();

    expect(tools.find((tool) => tool.id === 'python')).toMatchObject({ status: 'error', selected: false });
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists a picker-confirmed executable as a safe structured project binding', async () => {
    const { root, userData, projects, toolchains } = await fixture();
    process.env.PATH = '';
    toolchains.beginProjectSession();

    const selected = await toolchains.selectExecutable('python', process.execPath);
    const canonicalNode = await realpath(process.execPath);
    expect(selected).toMatchObject({ status: 'ready', selected: true, path: canonicalNode });
    const config = TOML.parse(await readFile(path.join(root, '.research_ide', 'project.toml'), 'utf8'));
    expect(config.toolchains).toEqual({ python: { source: 'custom', path: canonicalNode } });

    toolchains.endProjectSession();
    await projects.close();
    await projects.open(root);
    const reopened = new ToolchainService(projects, () => undefined, async () => undefined, async () => true, userData);
    reopened.beginProjectSession();
    const tools = await reopened.ensureDetected();
    expect(tools.find((tool) => tool.id === 'python')).toMatchObject({ status: 'ready', selected: true, path: canonicalNode });
    reopened.endProjectSession();
  });

  it.skipIf(process.platform === 'win32')('invalidates a confirmed custom executable when its bytes are replaced', async () => {
    const { base, root, projects, toolchains } = await fixture();
    const executable = path.join(base, 'selected-python');
    const sentinel = path.join(base, 'replacement-ran');
    await writeFile(executable, '#!/bin/sh\nprintf "selected 1.0\\n"\n', 'utf8');
    await chmod(executable, 0o700);
    process.env.PATH = '';
    toolchains.beginProjectSession();
    await toolchains.selectExecutable('python', executable);

    await writeFile(executable, `#!/bin/sh\nprintf 'ran' > '${sentinel}'\nprintf 'replacement 2.0\\n'\n`, 'utf8');
    toolchains.endProjectSession();
    await projects.close();
    await projects.open(root);
    toolchains.beginProjectSession();

    const tools = await toolchains.ensureDetected();
    expect(tools.find((tool) => tool.id === 'python')).toMatchObject({ status: 'error', selected: false });
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('persists an explicitly selected system PATH tool', async () => {
    const { base, root, toolchains } = await fixture();
    const bin = path.join(base, 'bin');
    await mkdir(bin);
    const executable = path.join(bin, 'python3');
    await writeFile(executable, '#!/bin/sh\nprintf "system-python 3.13\\n"\n', 'utf8');
    await chmod(executable, 0o700);
    process.env.PATH = bin;
    toolchains.beginProjectSession();

    const selected = await toolchains.selectSystem('python');

    expect(selected).toMatchObject({ status: 'ready', selected: true, path: await realpath(executable) });
    const config = TOML.parse(await readFile(path.join(root, '.research_ide', 'project.toml'), 'utf8'));
    expect(config.toolchains).toEqual({ python: { source: 'system' } });
  });

  it.skipIf(process.platform === 'win32')('can replace a blocked custom binding with a detected system tool', async () => {
    const { base, root, projects, toolchains } = await fixture();
    const bin = path.join(base, 'bin');
    await mkdir(bin);
    const systemPython = path.join(bin, 'python3');
    await writeFile(systemPython, '#!/bin/sh\nprintf "system-python 3.13\\n"\n', 'utf8');
    await chmod(systemPython, 0o700);
    const configPath = path.join(root, '.research_ide', 'project.toml');
    const config = TOML.parse(await readFile(configPath, 'utf8'));
    config.toolchains = { python: { source: 'custom', path: path.join(base, 'never-confirmed-python') } };
    await writeFile(configPath, TOML.stringify(config), 'utf8');
    await projects.close();
    await projects.open(root);
    process.env.PATH = bin;
    toolchains.beginProjectSession();

    const before = await toolchains.ensureDetected();
    expect(before.find((tool) => tool.id === 'python')).toMatchObject({ status: 'error', systemPath: await realpath(systemPython) });
    const selected = await toolchains.selectSystem('python');

    expect(selected).toMatchObject({ status: 'ready', selected: true, path: await realpath(systemPython) });
    const saved = TOML.parse(await readFile(configPath, 'utf8'));
    expect(saved.toolchains).toEqual({ python: { source: 'system' } });
  });

  it.skipIf(process.platform === 'win32')('installs and restores a project-scoped managed version without changing PATH', async () => {
    const managedOptions: ManagedToolchainOptions = {
      platform: 'linux', arch: 'x64',
      requestJson: async () => ({ files: [{ version: '3.13.7', attrs: { subdir: 'linux-64' }, labels: ['main'] }] }),
      pixiExecutable: async () => ({ path: '/verified-test-pixi', version: '0.55.0' }),
      runCommand: async (_executable, _args, cwd) => {
        const executable = path.join(cwd, '.pixi', 'envs', 'default', 'bin', 'python3');
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, '#!/bin/sh\ntest -n "$CONDA_PREFIX" || exit 9\nprintf "Python 3.13.7\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const { root, toolchains } = await fixture(managedOptions);
    process.env.PATH = '';
    toolchains.beginProjectSession();

    const prepared = await toolchains.prepareManagedInstallation('python', '3.13.7');
    const selected = await toolchains.selectPreparedManaged(prepared);

    expect(selected).toMatchObject({ status: 'ready', selected: true, managed: true, version: 'Python 3.13.7' });
    const config = TOML.parse(await readFile(path.join(root, '.research_ide', 'project.toml'), 'utf8'));
    expect(config.toolchains).toMatchObject({ python: { source: 'managed' } });
    expect(String((config.toolchains as { python: { path: string } }).python.path)).toMatch(/^python\/3\.13\.7\//u);

    toolchains.endProjectSession();
    toolchains.beginProjectSession();
    const restored = await toolchains.ensureDetected();
    expect(restored.find((tool) => tool.id === 'python')).toMatchObject({ status: 'ready', selected: true, managed: true, version: 'Python 3.13.7' });
  });

  it('validates managed tool and version identifiers before starting an installation', async () => {
    const { toolchains } = await fixture();

    expect(() => toolchains.validateManagedRequest('python\nspoofed', '3.13.7')).toThrow(/Unknown toolchain/u);
    expect(() => toolchains.validateManagedRequest('python', ' 3.13.7')).toThrow(/version is invalid/u);
    expect(() => toolchains.validateManagedRequest('python', '3.13.7\nInjected')).toThrow(/version is invalid/u);
    expect(toolchains.validateManagedRequest('python', '3.13.7')).toEqual({ toolId: 'python', version: '3.13.7' });
  });

  it.skipIf(process.platform === 'win32')('does not bind a prepared managed install after the active project changes', async () => {
    const managedOptions: ManagedToolchainOptions = {
      platform: 'linux', arch: 'x64',
      requestJson: async () => ({ files: [{ version: '3.13.7', attrs: { subdir: 'linux-64' }, labels: ['main'] }] }),
      pixiExecutable: async () => ({ path: '/verified-test-pixi', version: '0.55.0' }),
      runCommand: async (_executable, _args, cwd) => {
        const executable = path.join(cwd, '.pixi', 'envs', 'default', 'bin', 'python3');
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, '#!/bin/sh\nprintf "Python 3.13.7\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const { base, root, projects, toolchains } = await fixture(managedOptions);
    process.env.PATH = '';
    toolchains.beginProjectSession();
    const prepared = await toolchains.prepareManagedInstallation('python', '3.13.7');

    const next = await projects.create({ name: 'other-paper', parentPath: path.join(base, 'projects'), template: 'blank', initializeGit: false });
    toolchains.beginProjectSession();

    await expect(toolchains.selectPreparedManaged(prepared)).rejects.toThrow(/project changed/u);
    const firstConfig = TOML.parse(await readFile(path.join(root, '.research_ide', 'project.toml'), 'utf8'));
    const nextConfig = TOML.parse(await readFile(path.join(next.path, '.research_ide', 'project.toml'), 'utf8'));
    expect(firstConfig.toolchains).toBeUndefined();
    expect(nextConfig.toolchains).toBeUndefined();
  });
});
