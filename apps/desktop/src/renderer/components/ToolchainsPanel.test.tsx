import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedToolchainCatalog, ToolchainInfo } from '../types';
import { ToolchainsPanel } from './ToolchainsPanel';

afterEach(cleanup);

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
