import { _electron as electron, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function packagedExecutable(): Promise<string> {
  // pnpm runs this workspace script with apps/desktop as the working directory.
  const packageDirectory = path.resolve(
    process.cwd(),
    'out',
    `Research IDE-${process.platform}-${process.arch}`,
  );
  if (process.platform === 'darwin') {
    const executableDirectory = path.join(packageDirectory, 'Research IDE.app', 'Contents', 'MacOS');
    const entries = await readdir(executableDirectory, { withFileTypes: true });
    const executable = entries.find((entry) => entry.isFile());
    if (!executable) throw new Error(`No packaged macOS executable in ${executableDirectory}`);
    return path.join(executableDirectory, executable.name);
  }

  const executable = path.join(packageDirectory, process.platform === 'win32' ? 'research-ide.exe' : 'research-ide');
  const details = await stat(executable).catch(() => undefined);
  if (!details?.isFile()) throw new Error(`Packaged executable not found: ${executable}`);
  return executable;
}

test('packaged executable loads its native SQLite runtime', async () => {
  const executable = await packagedExecutable();
  const args = ['--research-ide-native-smoke'];
  // GitHub's Linux runner cannot preserve Electron's required root:4755
  // ownership for chrome-sandbox in an unpacked artifact. This opt-in affects
  // only this headless native-module smoke-test child; packaged applications
  // and the renderer-isolation E2E test continue to use Electron's sandbox.
  if (
    process.platform === 'linux'
    && process.env.CI === 'true'
    && process.env.RESEARCH_IDE_E2E_NO_SANDBOX === '1'
  ) {
    args.unshift('--no-sandbox');
  }
  const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Packaged native smoke test timed out. stderr: ${stderr}`));
    }, 25_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('RESEARCH_IDE_NATIVE_SMOKE_OK');
});

test('starts the desktop workbench with an isolated renderer bridge', async () => {
  const main = path.resolve(process.cwd(), '.vite/build/index.js');
  const application = await electron.launch({
    args: [main],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });

  try {
    const page = await application.firstWindow();
    await expect(page).toHaveTitle('Research IDE');
    await expect(page.getByRole('heading', { name: '把研究工作，放回一个清晰的上下文里。' })).toBeVisible();
    await expect(page.getByRole('button', { name: /新建项目/u })).toBeEnabled();
    await expect(page.getByRole('button', { name: '打开指令中心' })).toBeVisible();
    for (const redundantMenu of ['编辑', '视图', '运行', '帮助']) {
      await expect(page.getByRole('button', { name: redundantMenu, exact: true })).toHaveCount(0);
    }
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('14px');

    const boundary = await page.evaluate(() => ({
      hasBridge: typeof window.researchIDE === 'object',
      hasNodeRequire: typeof (window as Window & { require?: unknown }).require !== 'undefined',
      hasRendererProcess: typeof (window as Window & { process?: unknown }).process !== 'undefined',
    }));
    expect(boundary).toEqual({ hasBridge: true, hasNodeRequire: false, hasRendererProcess: false });

    const applicationUrl = page.url();
    await page.evaluate(() => window.location.assign('file:///tmp/research-ide-untrusted.html'));
    await page.waitForTimeout(100);
    expect(page.url()).toBe(applicationUrl);
  } finally {
    await application.close();
  }
});
