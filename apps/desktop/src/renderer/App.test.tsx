import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./components/CodexPanel', () => ({
  CodexPanel: () => <div data-testid="codex-panel">Codex panel</div>,
}));

vi.mock('./components/EditorArea', () => ({
  EditorArea: () => <main data-testid="editor-area" />,
}));

import App from './App';

function desktopBridge() {
  return {
    project: {
      listRecent: vi.fn(async () => []),
      openDialog: vi.fn(async () => ({ id: 'paper', name: 'Paper', path: '/research/paper' })),
      getTree: vi.fn(async () => []),
      onWorkspaceChange: vi.fn(() => () => undefined),
    },
    diagnostics: { listProblems: vi.fn(async () => []) },
    snapshots: { list: vi.fn(async () => []) },
    toolchains: { onEvent: vi.fn(() => () => undefined) },
  } as unknown as NonNullable<Window['researchIDE']>;
}

afterEach(() => {
  cleanup();
  window.researchIDE = undefined;
});

describe('project workbench defaults', () => {
  it('keeps project-only navigation out of the no-project welcome screen', async () => {
    const bridge = desktopBridge();
    window.researchIDE = bridge;
    render(<App />);
    await waitFor(() => expect(bridge.project.listRecent).toHaveBeenCalledOnce());
    expect(screen.queryByRole('navigation', { name: '主要功能' })).toBeNull();
    expect(screen.queryByTestId('codex-panel')).toBeNull();
  });

  it('opens Codex in the right column after a project is opened successfully', async () => {
    const bridge = desktopBridge();
    window.researchIDE = bridge;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '打开项目' }));

    const codexToggle = await screen.findByRole('button', { name: '收起 Codex' });
    expect(codexToggle.getAttribute('aria-expanded')).toBe('true');
    const host = screen.getByTestId('codex-panel').closest('.right-codex-host');
    expect(host?.classList.contains('open')).toBe(true);
    expect(host?.getAttribute('aria-hidden')).toBe('false');
    expect(bridge.project.getTree).toHaveBeenCalledOnce();
  });
});
