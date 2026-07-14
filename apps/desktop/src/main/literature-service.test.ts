import { describe, expect, it, vi } from 'vitest';
import { probeZoteroLocalApi } from './literature-service';

describe('Zotero local API diagnostics', () => {
  it('checks only the loopback connector and API with Zotero API v3', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Zotero is running', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Total-Results': '42' } }));

    await expect(probeZoteroLocalApi(fetchMock)).resolves.toEqual({
      zoteroAvailable: true,
      connected: true,
      detail: 'Zotero 本地 API 连接诊断通过，检测到 42 条记录；当前版本尚未把这些元数据同步到项目文献列表。',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:23119/connector/ping',
      'http://127.0.0.1:23119/api/users/0/items/top?limit=1&format=json',
    ]);
    const apiOptions = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(apiOptions?.headers).get('Zotero-API-Version')).toBe('3');
    expect(apiOptions).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('distinguishes an unavailable desktop app from a disabled local API', async () => {
    const unavailable = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connect ECONNREFUSED'));
    await expect(probeZoteroLocalApi(unavailable)).resolves.toMatchObject({
      zoteroAvailable: false,
      connected: false,
      detail: expect.stringMatching(/启动 Zotero/u),
    });

    const disabled = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Zotero is running', { status: 200 }))
      .mockResolvedValueOnce(new Response('Local API disabled', { status: 403 }));
    await expect(probeZoteroLocalApi(disabled)).resolves.toMatchObject({
      zoteroAvailable: true,
      connected: false,
      detail: expect.stringMatching(/设置 → 高级.*允许本机/u),
    });
  });

  it('rejects malformed or oversized local API responses', async () => {
    const malformed = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Zotero is running', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"unexpected":true}', { status: 200 }));
    await expect(probeZoteroLocalApi(malformed)).resolves.toMatchObject({
      zoteroAvailable: true,
      connected: false,
      detail: expect.stringMatching(/无法识别/u),
    });

    const oversized = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Zotero is running', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Content-Length': String(2 * 1024 * 1024) } }));
    await expect(probeZoteroLocalApi(oversized)).resolves.toMatchObject({
      zoteroAvailable: true,
      connected: false,
      detail: expect.stringMatching(/超过安全限制/u),
    });
  });
});
