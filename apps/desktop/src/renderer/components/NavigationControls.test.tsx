import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityBar } from './ActivityBar';
import { TitleBar } from './TitleBar';

afterEach(cleanup);

describe('workbench navigation controls', () => {
  it('omits the sidebar search activity while retaining the project activities', () => {
    render(<ActivityBar active="explorer" onChange={() => undefined} onSettings={() => undefined} />);
    expect(screen.queryByTitle('搜索')).toBeNull();
    expect(screen.getByTitle('项目')).toBeTruthy();
    expect(screen.getByTitle('文献')).toBeTruthy();
    expect(screen.getByTitle('Codex')).toBeTruthy();
  });

  it('presents the instruction center as an accessible menu button', () => {
    const onCommandPalette = vi.fn();
    render(<TitleBar
      onCommandPalette={onCommandPalette}
      onNewProject={() => undefined}
      onOpenProject={() => undefined}
      onSave={() => undefined}
      project={{ id: 'project-1', name: 'Paper', path: '/project' }}
    />);
    const trigger = screen.getByRole('button', { name: '打开 Paper 的指令中心' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.textContent).toContain('指令中心');
    fireEvent.click(trigger);
    expect(onCommandPalette).toHaveBeenCalledOnce();
  });
});
