import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibreOfficeExecutableStatus } from '../../shared/types';
import { SettingsDialog } from './SettingsDialog';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'researchIDE');
});

describe('LibreOffice settings', () => {
  it('shows app-level trust status and opens the native executable selector', async () => {
    const initial: LibreOfficeExecutableStatus = { state: 'notConfigured', detail: '本机未找到 LibreOffice；打开旧版 DOC 前需要先安装或手动选择可执行文件。' };
    const selected: LibreOfficeExecutableStatus = {
      state: 'ready',
      source: 'custom',
      path: '/opt/libreoffice/program/soffice',
      sha256: 'a'.repeat(64),
    };
    const libreOfficeStatus = vi.fn(async () => initial);
    const selectLibreOffice = vi.fn(async () => selected);
    Object.defineProperty(window, 'researchIDE', {
      configurable: true,
      value: { documents: { libreOfficeStatus, selectLibreOffice, clearLibreOffice: vi.fn(async () => initial) } },
    });

    render(<SettingsDialog onClose={() => undefined} onReveal={() => undefined} project={null} />);
    fireEvent.click(screen.getByRole('button', { name: '工具链' }));
    expect(await screen.findByText('旧版 Word 转换器')).toBeTruthy();
    expect(screen.getByText(/本机未找到 LibreOffice/u)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '选择…' }));
    await waitFor(() => expect(selectLibreOffice).toHaveBeenCalledOnce());
    expect(await screen.findByTitle(/\/opt\/libreoffice\/program\/soffice/u)).toBeTruthy();
  });
});
