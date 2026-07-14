import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LiteratureItem, LiteratureStatus } from '../shared/types';
import { AppError } from './errors';
import type { ProjectService } from './project-service';

const ZOTERO_ORIGIN = 'http://127.0.0.1:23119';
const ZOTERO_PING_URL = `${ZOTERO_ORIGIN}/connector/ping`;
const ZOTERO_API_PROBE_URL = `${ZOTERO_ORIGIN}/api/users/0/items/top?limit=1&format=json`;
const ZOTERO_PROBE_TIMEOUT_MS = 3_000;
const ZOTERO_PING_LIMIT = 32 * 1024;
const ZOTERO_API_LIMIT = 1024 * 1024;

export interface LiteratureServiceOptions {
  probeZotero?: () => Promise<LiteratureStatus>;
}

async function boundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('ZOTERO_RESPONSE_TOO_LARGE', 'Zotero 本地服务返回的数据超过安全限制');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('ZOTERO_RESPONSE_TOO_LARGE', 'Zotero 本地服务返回的数据超过安全限制');
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function localRequest(fetchImpl: typeof fetch, url: string, maxBytes: number): Promise<{ response: Response; body: Buffer }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZOTERO_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain;q=0.8', 'Zotero-API-Version': '3' },
    });
    return { response, body: await boundedResponse(response, maxBytes) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probe only Zotero's fixed loopback endpoint. No account, API key, external
 * network request, or direct access to Zotero's SQLite database is involved.
 */
export async function probeZoteroLocalApi(fetchImpl: typeof fetch = fetch): Promise<LiteratureStatus> {
  let ping: { response: Response; body: Buffer };
  try {
    ping = await localRequest(fetchImpl, ZOTERO_PING_URL, ZOTERO_PING_LIMIT);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return {
      zoteroAvailable: false,
      connected: false,
      detail: timedOut
        ? 'Zotero 本地服务响应超时。请确认 Zotero 已启动，再重试连接。'
        : '未检测到 Zotero。请先启动 Zotero 桌面应用，再点击连接。',
    };
  }
  if (!ping.response.ok) {
    return {
      zoteroAvailable: true,
      connected: false,
      detail: `已发现 Zotero，但连接器自检返回 HTTP ${ping.response.status}。请重启 Zotero 后重试。`,
    };
  }

  let api: { response: Response; body: Buffer };
  try {
    api = await localRequest(fetchImpl, ZOTERO_API_PROBE_URL, ZOTERO_API_LIMIT);
  } catch (error) {
    return {
      zoteroAvailable: true,
      connected: false,
      detail: error instanceof AppError
        ? error.message
        : '已发现 Zotero，但无法读取本地 API。请检查 Zotero 的本地 API 设置后重试。',
    };
  }
  if (api.response.status === 403) {
    return {
      zoteroAvailable: true,
      connected: false,
      detail: '已发现 Zotero，但本地 API 未启用。请在 Zotero“设置 → 高级”中允许本机其它应用通信，然后重试。',
    };
  }
  if (!api.response.ok) {
    return {
      zoteroAvailable: true,
      connected: false,
      detail: `已发现 Zotero，但本地 API 返回 HTTP ${api.response.status}。请检查 Zotero 设置后重试。`,
    };
  }
  try {
    const payload = JSON.parse(api.body.toString('utf8')) as unknown;
    if (!Array.isArray(payload)) throw new Error('not an item list');
  } catch {
    return {
      zoteroAvailable: true,
      connected: false,
      detail: 'Zotero 本地 API 返回了无法识别的数据，请更新或重启 Zotero 后重试。',
    };
  }
  const totalHeader = api.response.headers.get('total-results');
  const total = totalHeader && /^\d+$/u.test(totalHeader) ? Number(totalHeader) : undefined;
  return {
    zoteroAvailable: true,
    connected: true,
    detail: total === undefined
      ? 'Zotero 本地 API 连接诊断通过；当前版本尚未把 Zotero 元数据同步到项目文献列表。'
      : `Zotero 本地 API 连接诊断通过，检测到 ${total} 条记录；当前版本尚未把这些元数据同步到项目文献列表。`,
  };
}

export class LiteratureService {
  constructor(
    private readonly projects: ProjectService,
    private readonly launchZoteroUrl: () => Promise<void>,
    private readonly options: LiteratureServiceOptions = {},
  ) {}

  status(): LiteratureStatus {
    const stored = this.projects.database.getSetting<LiteratureStatus>('zotero.status');
    if (stored && typeof stored.zoteroAvailable === 'boolean' && typeof stored.connected === 'boolean') {
      return {
        zoteroAvailable: stored.zoteroAvailable,
        connected: stored.connected,
        detail: typeof stored.detail === 'string' ? stored.detail.slice(0, 500) : undefined,
      };
    }
    return { zoteroAvailable: false, connected: false, detail: '尚未检测 Zotero。点击连接可检查本机 Zotero，不会访问外网。' };
  }

  list(): LiteratureItem[] { return this.projects.database.listLiterature(); }
  search(query: string): LiteratureItem[] {
    if (typeof query !== 'string' || query.length > 500) throw new AppError('INVALID_SEARCH', 'Literature search query is invalid');
    return this.projects.database.listLiterature(query.trim().slice(0, 300));
  }

  create(input: Omit<LiteratureItem, 'id'> & { id?: string }): LiteratureItem {
    if (!input || typeof input !== 'object') throw new AppError('INVALID_LITERATURE', 'Literature metadata is invalid');
    return this.projects.database.saveLiterature(this.sanitize({ ...input, id: input.id ?? randomUUID() }));
  }

  update(id: string, patch: Partial<LiteratureItem>): LiteratureItem {
    if (typeof id !== 'string' || id.length > 100 || !patch || typeof patch !== 'object') throw new AppError('INVALID_LITERATURE', 'Literature metadata is invalid');
    const current = this.projects.database.getLiterature(id);
    if (!current) throw new AppError('LITERATURE_NOT_FOUND', 'Literature item does not exist');
    return this.projects.database.saveLiterature(this.sanitize({ ...current, ...patch, id }));
  }

  delete(id: string): void {
    if (typeof id !== 'string' || id.length > 100) throw new AppError('INVALID_LITERATURE', 'Literature id is invalid');
    if (!this.projects.database.deleteLiterature(id)) throw new AppError('LITERATURE_NOT_FOUND', 'Literature item does not exist');
  }

  async importAttachment(sourcePath: string): Promise<LiteratureItem> {
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > 500 * 1024 * 1024) throw new AppError('INVALID_ATTACHMENT', 'Attachment must be a file smaller than 500 MB');
    const referencesDir = await this.projects.guard.writable('references');
    await mkdir(referencesDir, { recursive: true });
    const cleanName = path.basename(sourcePath).replaceAll(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180) || 'attachment';
    const relative = `references/${randomUUID().slice(0, 8)}-${cleanName}`;
    const destination = await this.projects.guard.writable(relative);
    await copyFile(sourcePath, destination);
    return this.create({
      title: path.basename(sourcePath, path.extname(sourcePath)), authors: [], itemType: 'other', tags: [],
      attachmentPath: relative, source: 'local',
    });
  }

  async openAttachment(id: string): Promise<string | null> {
    const item = this.projects.database.getLiterature(id);
    if (!item?.attachmentPath) return null;
    const absolute = await this.projects.guard.existing(item.attachmentPath);
    return this.projects.guard.relative(absolute);
  }

  async connectZotero(): Promise<LiteratureStatus> {
    const result = await (this.options.probeZotero ?? probeZoteroLocalApi)();
    this.projects.database.setSetting('zotero.status', result);
    return result;
  }

  async launchZotero(): Promise<void> { await this.launchZoteroUrl(); }

  private sanitize(item: LiteratureItem): LiteratureItem {
    const short = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
    const year = typeof item.year === 'number' && Number.isInteger(item.year) && item.year >= 0 && item.year <= 9999 ? item.year : undefined;
    const attachmentPath = short(item.attachmentPath, 1_000);
    if (attachmentPath) this.projects.guard.lexical(attachmentPath);
    return {
      id: short(item.id, 100) ?? randomUUID(), title: short(item.title, 1_000) ?? '',
      authors: Array.isArray(item.authors) ? item.authors.filter((value): value is string => typeof value === 'string').map((value) => value.trim().slice(0, 300)).filter(Boolean).slice(0, 100) : [],
      year, venue: short(item.venue, 500), citekey: short(item.citekey, 200),
      itemType: ['article', 'book', 'thesis', 'web', 'other'].includes(item.itemType ?? '') ? item.itemType : 'other',
      tags: Array.isArray(item.tags) ? item.tags.filter((value): value is string => typeof value === 'string').map((value) => value.trim().slice(0, 100)).filter(Boolean).slice(0, 100) : [],
      attachmentPath, source: item.source === 'zotero' ? 'zotero' : 'local',
    };
  }
}
