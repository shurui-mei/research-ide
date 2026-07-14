import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiteraturePanel } from './LiteraturePanel';

afterEach(cleanup);

describe('Zotero connection feedback', () => {
  it('shows the actionable result returned by the real connection diagnostic', async () => {
    const connect = vi.fn(async () => ({
      zoteroAvailable: true,
      connected: false,
      detail: '已发现 Zotero，但本地 API 未启用。请在 Zotero“设置 → 高级”中允许本机其它应用通信，然后重试。',
    }));
    render(<LiteraturePanel
      onConnectZotero={connect}
      onCopyCitation={() => undefined}
      onImport={async () => null}
      onLaunchZotero={() => undefined}
      onList={async () => ({ items: [], status: { zoteroAvailable: false, connected: false, detail: '尚未检测 Zotero。' } })}
      onOpenAttachment={() => undefined}
      onSearch={async () => []}
    />);

    fireEvent.click(await screen.findByRole('button', { name: '连接' }));
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(await screen.findByText(/本地 API 未启用/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
