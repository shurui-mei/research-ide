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
    fireEvent.click(screen.getByRole('button', { name: '工具箱' }));
    expect(await screen.findByText('旧版 Word 转换器')).toBeTruthy();
    expect(screen.getByText(/本机未找到 LibreOffice/u)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '选择…' }));
    await waitFor(() => expect(selectLibreOffice).toHaveBeenCalledOnce());
    expect(await screen.findByTitle(/\/opt\/libreoffice\/program\/soffice/u)).toBeTruthy();
  });
});

describe('Codex and API settings', () => {
  it('keeps connection guidance while moving CLI management out of settings', async () => {
    const libreOffice: LibreOfficeExecutableStatus = { state: 'notConfigured' };
    const runtimeStatus = vi.fn();
    const runtimeCatalog = vi.fn();
    Object.defineProperty(window, 'researchIDE', {
      configurable: true,
      value: {
        documents: {
          libreOfficeStatus: vi.fn(async () => libreOffice),
          selectLibreOffice: vi.fn(async () => libreOffice),
          clearLibreOffice: vi.fn(async () => libreOffice),
        },
        codexRuntime: {
          status: runtimeStatus,
          catalog: runtimeCatalog,
          selectExecutable: vi.fn(),
          install: vi.fn(),
          update: vi.fn(),
          clearSelection: vi.fn(),
          onEvent: vi.fn(() => () => undefined),
        },
      },
    });

    render(<SettingsDialog onClose={() => undefined} onReveal={() => undefined} project={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex 与 API' }));
    expect(await screen.findByText('OpenAI API 与 OpenAI-like API')).toBeTruthy();
    expect(screen.getByText(/模型与思考强度/u)).toBeTruthy();
    expect(screen.getByText(/已统一移到左侧“工具箱”/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /导入|检查版本|下载并使用/u })).toBeNull();
    expect(runtimeStatus).not.toHaveBeenCalled();
    expect(runtimeCatalog).not.toHaveBeenCalled();
  });
});
