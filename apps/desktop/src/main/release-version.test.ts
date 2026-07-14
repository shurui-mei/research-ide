import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const verifier = fileURLToPath(
  new URL('../../../../scripts/verify-release-version.mjs', import.meta.url),
);
const roots: string[] = [];

function runVerifier(args: string[] = []): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [verifier, ...args], {
      env: { ...process.env, GITHUB_REF_TYPE: undefined, GITHUB_REF_NAME: undefined },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.once('close', (code) => resolve({ code, output }));
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release version verifier', () => {
  it('accepts the repository manifests and their exact release tag', async () => {
    await expect(runVerifier()).resolves.toMatchObject({ code: 0 });
    await expect(runVerifier(['--tag', 'v0.2.0'])).resolves.toMatchObject({ code: 0 });
  });

  it('rejects a release tag that does not equal the packaged version', async () => {
    const result = await runVerifier(['--tag', 'v0.1.1']);
    expect(result.code).toBe(1);
  });

  it('rejects inconsistent package and installation versions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'research-ide-release-version-'));
    roots.push(root);
    const rootPackage = path.join(root, 'root.json');
    const desktopPackage = path.join(root, 'desktop.json');
    const manifest = path.join(root, 'install.json');
    await Promise.all([
      writeFile(rootPackage, '{"version":"0.2.0"}\n', 'utf8'),
      writeFile(desktopPackage, '{"version":"0.1.0"}\n', 'utf8'),
      writeFile(
        manifest,
        JSON.stringify({
          schemaVersion: 1,
          installId: 'org.researchide.desktop',
          kind: 'application-installation',
          version: '0.2.0',
          upgradeIdentity: {
            windowsSquirrelPackage: 'research_ide',
            windowsAppUserModelId: 'com.squirrel.research_ide.research-ide',
            macOSBundleId: 'org.researchide.desktop',
            linuxPackage: 'research-ide',
          },
        }),
        'utf8',
      ),
    ]);

    const result = await runVerifier([
      '--root-package',
      rootPackage,
      '--desktop-package',
      desktopPackage,
      '--manifest',
      manifest,
    ]);
    expect(result.code).toBe(1);
  });
});
