import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexThreadSummary } from '../types';
import { ConversationMenu } from './CodexPanel';

const active: CodexThreadSummary = {
  id: 'thread-active', title: 'Active experiment', preview: 'Active experiment',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', status: 'idle',
};
const archived: CodexThreadSummary = {
  ...active, id: 'thread-archived', title: 'Archived experiment', archived: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Codex conversation lifecycle menu', () => {
  it('archives and restores only the selected persisted conversation', () => {
    const onArchive = vi.fn();
    const onUnarchive = vi.fn();
    const onViewChange = vi.fn();
    const { rerender } = render(<ConversationMenu
      activeThreadId={active.id}
      activeThreads={[active]}
      archivedThreads={[archived]}
      onArchive={onArchive}
      onDelete={() => undefined}
      onRefresh={() => undefined}
      onSelect={() => undefined}
      onUnarchive={onUnarchive}
      onViewChange={onViewChange}
      view="active"
    />);

    fireEvent.click(screen.getByRole('button', { name: `归档对话：${active.title}` }));
    expect(onArchive).toHaveBeenCalledWith('thread-active');
    fireEvent.click(screen.getByRole('tab', { name: /已归档/u }));
    expect(onViewChange).toHaveBeenCalledWith('archived');

    rerender(<ConversationMenu
      activeThreads={[active]}
      archivedThreads={[archived]}
      onArchive={onArchive}
      onDelete={() => undefined}
      onRefresh={() => undefined}
      onSelect={() => undefined}
      onUnarchive={onUnarchive}
      onViewChange={onViewChange}
      view="archived"
    />);
    fireEvent.click(screen.getByRole('button', { name: `取消归档：${archived.title}` }));
    expect(onUnarchive).toHaveBeenCalledWith('thread-archived');
  });

  it('requires explicit confirmation and deletes exactly the target conversation', () => {
    const onDelete = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ConversationMenu
      activeThreads={[active]}
      archivedThreads={[archived]}
      onArchive={() => undefined}
      onDelete={onDelete}
      onRefresh={() => undefined}
      onSelect={() => undefined}
      onUnarchive={() => undefined}
      onViewChange={() => undefined}
      view="active"
    />);

    const deleteButton = screen.getByRole('button', { name: `删除对话：${active.title}` });
    fireEvent.click(deleteButton);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/只删除该对话.*无法撤销/su));
    expect(onDelete).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith('thread-active');
  });
});
