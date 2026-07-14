import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexRuntimeCatalog, CodexRuntimeStatus } from '../../shared/types';
import type { ManagedToolchainCatalog, ToolchainInfo } from '../types';
import { ToolchainsPanel } from './ToolchainsPanel';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'researchIDE');
});

describe('managed toolchain version selection', () => {
  it('uses the selection API for an installed version instead of starting an installation', async () => {
    const tool: ToolchainInfo = {
      id: 'python', name: 'Python', kind: 'python', status: 'ready', path: '/usr/bin/python3',
      version: 'Python 3.13.7', selected: false, managed: false,
    };
    const selected: ToolchainInfo = { ...tool, path: '/managed/python3', selected: true, managed: true };
    const catalog: ManagedToolchainCatalog = {
      toolId: 'python', packageName: 'python', source: 'conda-forge', sourceUrl: 'https://anaconda.org/conda-forge/python',
      platform: 'linux-64', versions: [{ version: '3.13.7', installed: true, selected: false }],
    };
    const installManaged = vi.fn(async () => selected);
    const selectManaged = vi.fn(async () => selected);

    render(<ToolchainsPanel
      onDetect={async () => [tool]}
      onEnsure={async () => [tool]}
      onInstallManaged={installManaged}
      onManagedCatalog={async () => catalog}
      onManagedEvent={() => () => undefined}
      onRemoveManaged={async () => undefined}
      onRun={async () => undefined}
      onSelectExecutable={async () => tool}
      onSelectManaged={selectManaged}
      onSelectSystem={async () => tool}
    />);

    fireEvent.click(await screen.findByRole('button', { name: /Python/u }));
    fireEvent.click(await screen.findByRole('button', { name: '使用' }));

    await waitFor(() => expect(selectManaged).toHaveBeenCalledWith('python', '3.13.7'));
    expect(installManaged).not.toHaveBeenCalled();
  });
});

describe('Codex CLI in the toolbox', () => {
  const catalog: CodexRuntimeCatalog = {
    provider: 'openai-github-releases',
    sourceUrl: 'https://api.github.com/repos/openai/codex/releases',
    platform: 'linux-x64',
    releases: [
      {
        version: '1.3.0', assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
        downloadUrl: 'https://github.com/openai/codex/releases/download/rust-v1.3.0/codex-x86_64-unknown-linux-musl.tar.gz',
        sha256: 'b'.repeat(64), size: 10 * 1024 * 1024, installed: false,
      },
      {
        version: '1.2.0', assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
        downloadUrl: 'https://github.com/openai/codex/releases/download/rust-v1.2.0/codex-x86_64-unknown-linux-musl.tar.gz',
        sha256: 'a'.repeat(64), size: 9 * 1024 * 1024, installed: false,
      },
    ],
  };

  function renderToolbox() {
    render(<ToolchainsPanel
      onDetect={async () => []}
      onEnsure={async () => []}
      onInstallManaged={async () => { throw new Error('not used'); }}
      onManagedCatalog={async () => { throw new Error('not used'); }}
      onManagedEvent={() => () => undefined}
      onRemoveManaged={async () => undefined}
      onRun={async () => undefined}
      onSelectExecutable={async () => { throw new Error('not used'); }}
      onSelectManaged={async () => { throw new Error('not used'); }}
      onSelectSystem={async () => { throw new Error('not used'); }}
    />);
  }

  it('allows first-time import/install and updates a non-managed CLI without exposing release history', async () => {
    const missing: CodexRuntimeStatus = { state: 'missing', managedVersions: [], detail: '未找到 Codex CLI' };
    const imported: CodexRuntimeStatus = {
      state: 'ready',
      active: { source: 'imported', path: '/opt/codex', version: '1.2.2', sha256: 'a'.repeat(64), prefixArgs: [] },
      managedVersions: [], updateAvailable: '1.3.0',
    };
    const managed: CodexRuntimeStatus = {
      state: 'ready',
      active: { source: 'managed', path: '/app-data/codex-runtime/versions/1.3.0/codex', version: '1.3.0', sha256: 'b'.repeat(64), prefixArgs: [] },
      managedVersions: [{ version: '1.3.0', installedAt: '2026-07-14T00:00:00.000Z', selected: true, path: '/app-data/codex-runtime/versions/1.3.0/codex' }],
    };
    const status = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(missing);
    const selectExecutable = vi.fn(async () => imported);
    const install = vi.fn(async () => managed);
    const update = vi.fn(async () => managed);
    Object.defineProperty(window, 'researchIDE', {
      configurable: true,
      value: { codexRuntime: { status, catalog: vi.fn(async () => catalog), selectExecutable, install, update, clearSelection: vi.fn(), onEvent: vi.fn(() => () => undefined) } },
    });

    renderToolbox();
    fireEvent.click(await screen.findByRole('button', { name: /Codex CLI/u }));
    expect(screen.getByRole('button', { name: /导入可信可执行文件/u })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /检查更新/u }));
    expect(await screen.findByRole('button', { name: '安装最新版 1.3.0' })).toBeTruthy();
    expect(screen.queryByText('1.2.0')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /导入可信可执行文件/u }));
    await waitFor(() => expect(selectExecutable).toHaveBeenCalledOnce());
    expect((await screen.findAllByText('手动导入')).length).toBeGreaterThan(0);

    fireEvent.click(await screen.findByRole('button', { name: '更新到 1.3.0' }));
    await waitFor(() => expect(install).toHaveBeenCalledWith('1.3.0'));
    expect(update).not.toHaveBeenCalled();
    expect((await screen.findAllByText('Research IDE 管理')).length).toBeGreaterThan(0);
  });

  it('shows source, version, and path, and uses latest-only managed update', async () => {
    const managed: CodexRuntimeStatus = {
      state: 'ready',
      active: { source: 'managed', path: '/app-data/codex-runtime/versions/1.2.2/codex', version: '1.2.2', sha256: 'a'.repeat(64), prefixArgs: [] },
      managedVersions: [{ version: '1.2.2', installedAt: '2026-07-13T00:00:00.000Z', selected: true, path: '/app-data/codex-runtime/versions/1.2.2/codex' }],
    };
    const updateAvailable: CodexRuntimeStatus = { ...managed, updateAvailable: '1.3.0' };
    const updated: CodexRuntimeStatus = {
      state: 'ready',
      active: { source: 'managed', path: '/app-data/codex-runtime/versions/1.3.0/codex', version: '1.3.0', sha256: 'b'.repeat(64), prefixArgs: [] },
      managedVersions: [],
    };
    const status = vi.fn().mockResolvedValueOnce(managed).mockResolvedValueOnce(updateAvailable);
    const install = vi.fn(async () => updated);
    const update = vi.fn(async () => updated);
    Object.defineProperty(window, 'researchIDE', {
      configurable: true,
      value: { codexRuntime: { status, catalog: vi.fn(async () => catalog), selectExecutable: vi.fn(), install, update, clearSelection: vi.fn(), onEvent: vi.fn(() => () => undefined) } },
    });

    renderToolbox();
    fireEvent.click(await screen.findByRole('button', { name: /Codex CLI/u }));
    expect((await screen.findAllByText('Research IDE 管理')).length).toBeGreaterThan(0);
    expect(screen.getByText('1.2.2')).toBeTruthy();
    expect(screen.getByTitle('/app-data/codex-runtime/versions/1.2.2/codex')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /检查更新/u }));
    fireEvent.click(await screen.findByRole('button', { name: '更新到 1.3.0' }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(install).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^使用$/u })).toBeNull();
  });
});
