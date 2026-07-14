import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexRuntimeService,
  OfficialCodexGithubProvider,
  codexRuntimeInternals,
  type CodexRuntimeCatalogProvider,
} from './codex-runtime-service';

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function digest(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function tarGz(name: string, content: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000700\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0; for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

describe('official Codex runtime catalog', () => {
  it('maps every supported desktop target to the exact official release asset', () => {
    expect(codexRuntimeInternals.runtimeTarget('linux', 'x64')).toMatchObject({ assetName: 'codex-x86_64-unknown-linux-musl.tar.gz' });
    expect(codexRuntimeInternals.runtimeTarget('linux', 'arm64')).toMatchObject({ assetName: 'codex-aarch64-unknown-linux-musl.tar.gz' });
    expect(codexRuntimeInternals.runtimeTarget('darwin', 'arm64')).toMatchObject({ assetName: 'codex-aarch64-apple-darwin.tar.gz' });
    expect(codexRuntimeInternals.runtimeTarget('win32', 'x64')).toMatchObject({ assetName: 'codex-x86_64-pc-windows-msvc.exe', executableName: 'codex.exe' });
    expect(codexRuntimeInternals.runtimeTarget('freebsd', 'x64')).toBeUndefined();
  });

  it('accepts only the exact platform asset, official URL, and GitHub SHA-256 digest', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{
      tag_name: 'rust-v1.2.3', draft: false, prerelease: false,
      assets: [
        { name: 'codex-x86_64-unknown-linux-musl.tar.gz', size: 42, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: 'https://github.com/openai/codex/releases/download/rust-v1.2.3/codex-x86_64-unknown-linux-musl.tar.gz' },
        { name: 'codex-aarch64-unknown-linux-musl.tar.gz', size: 40, digest: `sha256:${'b'.repeat(64)}`, browser_download_url: 'https://github.com/openai/codex/releases/download/rust-v1.2.3/codex-aarch64-unknown-linux-musl.tar.gz' },
      ],
    }]), { status: 200 }));
    const provider = new OfficialCodexGithubProvider({ platform: 'linux', arch: 'x64', fetchImpl: fetchMock });

    await expect(provider.load()).resolves.toEqual([expect.objectContaining({
      version: '1.2.3', assetName: 'codex-x86_64-unknown-linux-musl.tar.gz', sha256: 'a'.repeat(64), size: 42,
    })]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/api\.github\.com\/repos\/openai\/codex\/releases/u), expect.objectContaining({ redirect: 'error' }));
  });

  it('fails closed when GitHub omits a digest or the asset comes from another host', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{
      tag_name: 'rust-v1.2.3', assets: [
        { name: 'codex-x86_64-unknown-linux-musl.tar.gz', size: 42, browser_download_url: 'https://example.com/codex.tar.gz' },
      ],
    }]), { status: 200 }));

    await expect(new OfficialCodexGithubProvider({ platform: 'linux', arch: 'x64', fetchImpl: fetchMock }).load())
      .rejects.toMatchObject({ code: 'CODEX_RUNTIME_NO_VERIFIED_RELEASE' });
  });
});

describe('Codex runtime resolution and trust', () => {
  it('discovers a system CLI and preserves the existing CODEX_HOME without writing runtime state', async () => {
    const root = await temporaryRoot('research-ide-codex-system-');
    const bin = path.join(root, 'bin'); await mkdir(bin);
    const executable = path.join(bin, 'codex'); await writeFile(executable, 'system codex', 'utf8'); await chmod(executable, 0o700);
    const codexHome = path.join(root, 'existing-codex-home');
    const service = new CodexRuntimeService(path.join(root, 'user-data'), () => undefined, {
      platform: 'linux', arch: 'x64', environment: { PATH: bin, CODEX_HOME: codexHome },
      readVersion: async () => 'codex-cli 1.0.0',
    });

    await expect(service.status()).resolves.toMatchObject({ state: 'ready', active: { source: 'system', path: executable, version: '1.0.0' } });
    await expect(service.resolveCommand()).resolves.toMatchObject({ environment: { CODEX_HOME: codexHome } });
    await expect(readdir(path.join(root, 'user-data'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires an explicit stable fingerprint and rejects project-local or replaced imports', async () => {
    const root = await temporaryRoot('research-ide-codex-import-');
    const project = path.join(root, 'project'); const external = path.join(root, 'external');
    await mkdir(project); await mkdir(external);
    const projectCli = path.join(project, 'codex'); const externalCli = path.join(external, 'codex');
    await writeFile(projectCli, 'codex-cli 1.2.3'); await writeFile(externalCli, 'codex-cli 1.2.3');
    await chmod(projectCli, 0o700); await chmod(externalCli, 0o700);
    const service = new CodexRuntimeService(path.join(root, 'user-data'), () => undefined, {
      platform: 'linux', arch: 'x64', environment: { PATH: '' }, currentProjectRoot: () => project,
      readVersion: async (candidate) => readFile(candidate, 'utf8'),
    });

    await expect(service.prepareSelection(projectCli)).rejects.toMatchObject({ code: 'PROJECT_EXECUTABLE_FORBIDDEN' });
    const prepared = await service.prepareSelection(externalCli);
    await expect(service.confirmSelection(prepared)).resolves.toMatchObject({ state: 'ready', active: { source: 'imported', version: '1.2.3' } });
    await expect(readFile(path.join(root, 'user-data', 'codex-runtime', '.research-ide-codex-runtime.json'), 'utf8'))
      .resolves.toMatch(/"kind": "research-ide-codex-runtime"/u);
    await writeFile(externalCli, 'codex-cli 1.2.4'); await chmod(externalCli, 0o700);
    await expect(service.status()).resolves.toMatchObject({ state: 'invalid', detail: expect.stringMatching(/replaced|updated|changed/iu) });
  });

  it.skipIf(process.platform !== 'win32')('supports the standard Windows npm codex.cmd layout without spawning cmd.exe', async () => {
    const root = await temporaryRoot('research-ide-codex-npm-');
    const bin = path.join(root, 'bin');
    const entry = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const node = path.join(bin, 'node.exe');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(path.join(bin, 'codex.cmd'), '@node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
    await writeFile(node, 'node');
    await writeFile(entry, 'codex entry');
    const service = new CodexRuntimeService(path.join(root, 'user-data'), () => undefined, {
      platform: 'win32', arch: 'x64', environment: { PATH: bin }, currentProjectRoot: () => path.join(root, 'project'),
      readVersion: async (executable, prefixArgs) => executable === await realpath(node) && prefixArgs[0] === await realpath(entry) ? 'codex-cli 1.4.0' : 'unknown',
    });

    await expect(service.resolveCommand(path.join(root, 'project'))).resolves.toMatchObject({
      source: 'system', path: await realpath(node), prefixArgs: [await realpath(entry)], version: '1.4.0',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects pre-existing runtime-root and versions-directory symlinks', async () => {
    const root = await temporaryRoot('research-ide-codex-root-guard-');
    const userData = path.join(root, 'user-data');
    const outside = path.join(root, 'outside');
    await mkdir(userData); await mkdir(outside);
    await symlink(outside, path.join(userData, 'codex-runtime'), 'dir');
    const linkedRoot = new CodexRuntimeService(userData, () => undefined, { platform: 'linux', arch: 'x64', environment: { PATH: '' } });
    await expect(linkedRoot.status()).rejects.toMatchObject({ code: 'CODEX_RUNTIME_UNSAFE_ROOT' });

    await rm(path.join(userData, 'codex-runtime'));
    const external = path.join(root, 'codex'); await writeFile(external, 'codex-cli 1.2.3'); await chmod(external, 0o700);
    const service = new CodexRuntimeService(userData, () => undefined, {
      platform: 'linux', arch: 'x64', environment: { PATH: '' }, readVersion: async (candidate) => readFile(candidate, 'utf8'),
    });
    await service.confirmSelection(await service.prepareSelection(external));
    const versions = path.join(userData, 'codex-runtime', 'versions');
    await rm(versions, { recursive: true });
    await symlink(outside, versions, 'dir');
    await expect(service.status()).rejects.toMatchObject({ code: 'CODEX_RUNTIME_UNSAFE_ROOT' });
  });
});

describe('managed Codex runtime installation', () => {
  it('installs and updates verified releases in isolated version directories without touching system Codex or CODEX_HOME', async () => {
    const root = await temporaryRoot('research-ide-codex-managed-');
    const bin = path.join(root, 'bin'); await mkdir(bin);
    const systemCli = path.join(bin, 'codex'); await writeFile(systemCli, 'codex-cli 0.9.0'); await chmod(systemCli, 0o700);
    const executables = new Map([
      ['1.2.3', Buffer.from('codex-cli 1.2.3')],
      ['1.3.0', Buffer.from('codex-cli 1.3.0')],
    ]);
    const assets = new Map([...executables].map(([version, bytes]) => [version, tarGz('codex-x86_64-unknown-linux-musl', bytes)]));
    const releases = [...assets.entries()].reverse().map(([version, bytes]) => ({
      version, assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
      downloadUrl: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-x86_64-unknown-linux-musl.tar.gz`,
      sha256: digest(bytes), size: bytes.length,
    }));
    const provider: CodexRuntimeCatalogProvider = { load: async () => releases };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const version = /rust-v([^/]+)/u.exec(String(input))?.[1]; const bytes = version && assets.get(version);
      return bytes ? new Response(Uint8Array.from(bytes).buffer as ArrayBuffer, {
        status: 200,
        headers: version === '1.2.3' ? { 'Content-Length': String(bytes.length) } : undefined,
      }) : new Response('', { status: 404 });
    });
    const codexHome = path.join(root, 'codex-home');
    const events: string[] = [];
    const service = new CodexRuntimeService(path.join(root, 'user-data'), (event) => events.push(event.phase), {
      platform: 'linux', arch: 'x64', environment: { PATH: bin, CODEX_HOME: codexHome }, provider, fetchImpl: fetchMock,
      readVersion: async (candidate) => readFile(candidate, 'utf8'),
    });

    await expect(service.install('1.2.3')).resolves.toMatchObject({ state: 'ready', active: { source: 'managed', version: '1.2.3' }, system: { version: '0.9.0' } });
    await expect(service.update()).resolves.toMatchObject({ state: 'ready', active: { source: 'managed', version: '1.3.0' } });
    expect(await readFile(systemCli, 'utf8')).toBe('codex-cli 0.9.0');
    expect(await readFile(path.join(root, 'user-data', 'codex-runtime', 'versions', '1.2.3', 'codex'), 'utf8')).toBe('codex-cli 1.2.3');
    expect(await readFile(path.join(root, 'user-data', 'codex-runtime', 'versions', '1.3.0', 'codex'), 'utf8')).toBe('codex-cli 1.3.0');
    expect(await readFile(path.join(root, 'user-data', 'codex-runtime', 'selection.json'), 'utf8')).not.toContain(codexHome);
    await expect(service.resolveCommand()).resolves.toMatchObject({ environment: { CODEX_HOME: codexHome } });
    expect(events).toContain('verifying'); expect(events).toContain('completed');
    expect((await readdir(path.join(root, 'user-data', 'codex-runtime'))).some((name) => name.startsWith('.install-'))).toBe(false);
  });

  it('extracts only the expected regular file from an official tar.gz payload', async () => {
    const root = await temporaryRoot('research-ide-codex-archive-');
    const archive = path.join(root, 'codex.tar.gz'); const output = path.join(root, 'codex');
    await writeFile(archive, tarGz('codex-x86_64-unknown-linux-musl', Buffer.from('codex-cli 1.2.3')));
    await codexRuntimeInternals.extractSingleTarGz(archive, output, 'codex-x86_64-unknown-linux-musl');
    await expect(readFile(output, 'utf8')).resolves.toBe('codex-cli 1.2.3');

    const unsafe = path.join(root, 'unsafe.tar.gz');
    await writeFile(unsafe, tarGz('codex-x86_64-unknown-linux-musl', Buffer.from('target'), '2'));
    await expect(codexRuntimeInternals.extractSingleTarGz(unsafe, path.join(root, 'unsafe-output'), 'codex-x86_64-unknown-linux-musl'))
      .rejects.toMatchObject({ code: 'CODEX_RUNTIME_ARCHIVE_INVALID' });
  });
});
