import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const POSIX_UNINSTALLER = fileURLToPath(new URL('../../resources/uninstall/uninstall-research-ide.sh', import.meta.url));
const GUI_UNINSTALLER = fileURLToPath(new URL('../../resources/uninstall/uninstall-research-ide-gui', import.meta.url));
const POWERSHELL_UNINSTALLER = fileURLToPath(new URL('../../resources/uninstall/uninstall-research-ide.ps1', import.meta.url));
const ROOT_GUI_UNINSTALLER = fileURLToPath(new URL('../../../../uninstall-research-ide-gui', import.meta.url));
const ROOT_UNINSTALL_DESKTOP = fileURLToPath(new URL('../../../../Uninstall Research IDE.desktop', import.meta.url));
const LINUX_DESKTOP_TEMPLATE = fileURLToPath(new URL('../../resources/linux/research-ide.desktop.ejs', import.meta.url));
const roots: string[] = [];

async function runUninstaller(args: string[], home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [POSIX_UNINSTALLER, ...args], {
      env: { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

async function runGuiUninstaller(args: string[], home: string, input: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [GUI_UNINSTALLER, '--terminal-ui', ...args], {
      env: {
        HOME: home,
        PATH: `${home}/untrusted-bin:/usr/local/bin:/usr/bin:/bin`,
        DISPLAY: '',
        WAYLAND_DISPLAY: '',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

async function fixture(): Promise<{
  base: string;
  install: string;
  executable: string;
  data: string;
  state: string;
  project: string;
}> {
  const base = await mkdtemp(path.join(tmpdir(), 'research-ide-uninstall-'));
  roots.push(base);
  const install = process.platform === 'darwin'
    ? path.join(base, 'Research IDE.app')
    : path.join(base, 'research-ide');
  const distribution = process.platform === 'darwin'
    ? path.join(install, 'Contents', 'Resources', 'distribution')
    : path.join(install, 'resources', 'distribution');
  const executable = process.platform === 'darwin'
    ? path.join(install, 'Contents', 'MacOS', 'research-ide')
    : path.join(install, 'research-ide');
  const data = path.join(base, 'Research IDE');
  const state = path.join(base, '.local', 'state', 'research-ide');
  const project = path.join(base, 'paper');
  await Promise.all([
    mkdir(distribution, { recursive: true }),
    mkdir(path.dirname(executable), { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
    mkdir(path.join(project, '.research_ide'), { recursive: true }),
  ]);
  const installMarker = { schemaVersion: 1, installId: 'org.researchide.desktop', kind: 'application-installation' };
  const dataMarker = { schemaVersion: 1, installId: 'org.researchide.desktop', kind: 'application-data' };
  const stateMarker = { schemaVersion: 1, installId: 'org.researchide.desktop', kind: 'launcher-state' };
  await Promise.all([
    writeFile(path.join(distribution, 'install-manifest.json'), `${JSON.stringify(installMarker, null, 2)}\n`, 'utf8'),
    writeFile(executable, '#!/bin/sh\n', 'utf8'),
    writeFile(path.join(data, '.research-ide-app-data.json'), `${JSON.stringify(dataMarker, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, '.research-ide-launcher-state.json'), `${JSON.stringify(stateMarker)}\n`, 'utf8'),
    writeFile(path.join(project, '.research_ide', 'project.toml'), 'schema_version = 1\n\n[project]\nid = "project-1"\nname = "paper"\n', 'utf8'),
    writeFile(path.join(project, '.research_ide', 'project.schema.json'), JSON.stringify({ $id: 'https://research-ide.local/schemas/project.schema.json' }), 'utf8'),
  ]);
  await chmod(executable, 0o700);
  return { base, install, executable, data, state, project };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('distribution uninstallers', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('uses a dry run by default and preserves projects without the deletion opt-in', async () => {
    const { base, install, data, project } = await fixture();
    const result = await runUninstaller([
      '--install-dir', install, '--data-dir', data, '--project', project,
    ], base);
    expect(result).toMatchObject({ code: 0 });
    expect(result.output).toContain('PLAN installation');
    expect(result.output).toContain('KEEP project');
    expect(result.output).toContain('Dry run only');
    await expect(readFile(path.join(project, '.research_ide', 'project.toml'), 'utf8')).resolves.toContain('project-1');
  });

  posixIt('removes a marked custom installation and app data while keeping projects by default', async () => {
    const { base, install, executable, data, state, project } = await fixture();
    const result = await runUninstaller([
      '--execute', '--install-dir', install, '--data-dir', data, '--state-dir', state, '--project', project,
    ], base);
    expect(result).toMatchObject({ code: 0 });
    await expect(readFile(executable, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(data, '.research-ide-app-data.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(state, '.research-ide-launcher-state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(project, '.research_ide', 'project.toml'), 'utf8')).resolves.toContain('project-1');
  });

  posixIt('deletes a doubly marked project only after opt-in and exact canonical confirmation', async () => {
    const { base, install, data, project } = await fixture();
    const refused = await runUninstaller([
      '--install-dir', install, '--data-dir', data, '--project', project,
      '--delete-projects', '--confirm-project', `${project}-wrong`,
    ], base);
    expect(refused.code).toBe(2);
    expect(refused.output).toContain('exact --confirm-project is required');
    await expect(readFile(path.join(project, '.research_ide', 'project.toml'), 'utf8')).resolves.toContain('project-1');

    const accepted = await runUninstaller([
      '--execute', '--install-dir', install, '--data-dir', data, '--project', project,
      '--delete-projects', '--confirm-project', project,
    ], base);
    expect(accepted).toMatchObject({ code: 0 });
    await expect(readFile(path.join(project, '.research_ide', 'project.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  posixIt('graphical terminal fallback previews, requires exact confirmation, and keeps data by default choice', async () => {
    const { base, install, executable, data, state } = await fixture();
    const cancelled = await runGuiUninstaller([
      '--install-dir', install, '--data-dir', data, '--state-dir', state,
    ], base, '1\n\n');
    expect(cancelled).toMatchObject({ code: 0 });
    expect(cancelled.output).toContain('PLAN installation');
    expect(cancelled.output).toContain('Cancelled; nothing was changed');
    await expect(readFile(executable, 'utf8')).resolves.toBeTruthy();

    const accepted = await runGuiUninstaller([
      '--install-dir', install, '--data-dir', data, '--state-dir', state,
    ], base, '1\nUNINSTALL\n');
    expect(accepted).toMatchObject({ code: 0 });
    expect(accepted.output).toContain('Uninstall completed');
    await expect(readFile(executable, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(data, '.research-ide-app-data.json'), 'utf8')).resolves.toBeTruthy();
    await expect(readFile(path.join(state, '.research-ide-launcher-state.json'), 'utf8')).resolves.toBeTruthy();
  });

  posixIt('refuses dangerous, symbolic-link, and mismatched installation targets', async () => {
    const { base, install, executable } = await fixture();
    expect((await runUninstaller(['--install-dir', '/', '--keep-data'], base)).code).toBe(2);
    expect((await runUninstaller(['--install-dir', base, '--keep-data'], base)).code).toBe(2);
    expect((await runUninstaller(['--install-dir', `${install}\nsecond-path`, '--keep-data'], base)).code).toBe(2);

    const link = path.join(base, 'research-ide-link');
    await symlink(install, link);
    expect((await runUninstaller(['--install-dir', link, '--keep-data'], base)).code).toBe(2);

    const marker = process.platform === 'darwin'
      ? path.join(install, 'Contents', 'Resources', 'distribution', 'install-manifest.json')
      : path.join(install, 'resources', 'distribution', 'install-manifest.json');
    await writeFile(marker, '{"installId":"another.app"}\n', 'utf8');
    const mismatch = await runUninstaller(['--install-dir', install, '--keep-data'], base);
    expect(mismatch.code).toBe(2);
    expect(mismatch.output).toContain('marker schema mismatch');
    await expect(readFile(executable, 'utf8')).resolves.toBeTruthy();
  });

  it('ships a PowerShell path with equivalent marker, reparse-point, dry-run, and project-confirmation guards', async () => {
    const source = await readFile(POWERSHELL_UNINSTALLER, 'utf8');
    expect(source).toContain("$InstallId = 'org.researchide.desktop'");
    expect(source).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(source).toContain("Assert-JsonMarker $marker 'application-installation'");
    expect(source).toContain("Assert-JsonMarker $marker 'application-data'");
    expect(source).toContain('Assert-Project');
    expect(source).toContain('$DeleteProjects');
    expect(source).toContain('$ConfirmProject');
    expect(source).toContain("if (-not $Execute)");
    expect(source).toContain("Start-Process -FilePath $update -ArgumentList '--uninstall'");
  });

  it('ships parseable-location desktop entry and trusted graphical elevation boundaries', async () => {
    const [desktop, rootGui, gui, posix, installedDesktop] = await Promise.all([
      readFile(ROOT_UNINSTALL_DESKTOP, 'utf8'),
      readFile(ROOT_GUI_UNINSTALLER, 'utf8'),
      readFile(GUI_UNINSTALLER, 'utf8'),
      readFile(POSIX_UNINSTALLER, 'utf8'),
      readFile(LINUX_DESKTOP_TEMPLATE, 'utf8'),
    ]);
    expect(desktop).toContain('Exec=/usr/bin/find %k -maxdepth 0 -execdir ./uninstall-research-ide-gui --desktop-file {} +');
    expect(desktop).not.toMatch(/^Exec=\.\//mu);
    expect(rootGui).toContain("[ \"$(basename -- \"$DESKTOP_FILE\")\" = 'Uninstall Research IDE.desktop' ]");
    expect(rootGui).toContain('[ "$DESKTOP_DIR" = "$ROOT" ]');
    expect(gui).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin');
    expect(gui).toContain("execute_plan '--graphical-auth'");
    expect(posix).toContain('trusted_system_command()');
    expect(posix).toContain('for directory in /usr/bin /bin /usr/sbin /sbin');
    expect(posix).not.toContain('APT_GET=$(command -v apt-get');
    expect(posix).not.toContain('PKEXEC=$(command -v pkexec');
    expect(installedDesktop).toContain('Actions=Uninstall;');
    expect(installedDesktop).toContain('Exec=/usr/lib/research-ide/uninstall-research-ide-gui');
  });
});
