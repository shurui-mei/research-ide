import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityBar } from './ActivityBar';
import { TitleBar } from './TitleBar';

afterEach(cleanup);

describe('workbench navigation controls', () => {
  it('shows localized names alongside every primary navigation icon', () => {
    render(<ActivityBar active="explorer" onChange={() => undefined} onSettings={() => undefined} />);
    const navigation = screen.getByRole('navigation', { name: '主要功能' });
    expect(screen.queryByTitle('搜索')).toBeNull();
    for (const label of ['文件管理器', '文献管理', '工具箱', 'Codex', '设置']) {
      const button = screen.getByRole('button', { name: label });
      expect(button.textContent).toContain(label);
      expect(button.querySelector('svg')).toBeTruthy();
    }
    expect(navigation.querySelector('.sr-only')).toBeNull();
  });

  it('exposes Codex as an independent right-panel toggle', () => {
    const onChange = vi.fn();
    render(<ActivityBar active="explorer" codexOpen onChange={onChange} onSettings={() => undefined} />);
    const explorer = screen.getByRole('button', { name: '文件管理器' });
    const codex = screen.getByRole('button', { name: '收起 Codex' });
    expect(explorer.getAttribute('aria-current')).toBe('page');
    expect(codex.getAttribute('aria-pressed')).toBe('true');
    expect(codex.getAttribute('aria-expanded')).toBe('true');
    expect(codex.getAttribute('aria-controls')).toBe('codex-right-panel');
    expect(codex.textContent).toContain('Codex');
    fireEvent.click(codex);
    expect(onChange).toHaveBeenCalledWith('codex');
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
