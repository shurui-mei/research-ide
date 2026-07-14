import { CODEX_CONTEXT_LIMITS, type CodexContextBuffer } from '../../shared/types';
import type { EditorTab } from '../types';

const EMBEDDED_IMAGE_DATA = /data:image\/(?:png|jpe?g|gif|bmp|webp);base64,[a-z0-9+/=\s]+/giu;
const OMITTED_EMBEDDED_IMAGE = '[embedded image omitted by Research IDE]';

function withoutEmbeddedImages(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error('未保存文档结构过深，无法作为 Codex 上下文发送');
  if (typeof value === 'string') return value.replace(EMBEDDED_IMAGE_DATA, OMITTED_EMBEDDED_IMAGE);
  if (Array.isArray(value)) return value.map((item) => withoutEmbeddedImages(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withoutEmbeddedImages(child, depth + 1)]));
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function buildCodexContextBuffers(selectedPaths: string[], tabs: EditorTab[]): CodexContextBuffer[] {
  const selected = new Set(selectedPaths);
  const buffers: CodexContextBuffer[] = [];
  let totalBytes = 0;
  for (const tab of tabs) {
    if (!tab.dirty || tab.virtual || tab.loading || tab.error || !selected.has(tab.path)) continue;
    let buffer: CodexContextBuffer | undefined;
    if (tab.kind === 'text') {
      buffer = { path: tab.path, format: 'text', content: (tab.content ?? '').replace(EMBEDDED_IMAGE_DATA, OMITTED_EMBEDDED_IMAGE) };
    } else if (tab.kind === 'document' || tab.kind === 'docx') {
      if (typeof tab.document === 'string') {
        buffer = { path: tab.path, format: 'text', content: tab.document.replace(EMBEDDED_IMAGE_DATA, OMITTED_EMBEDDED_IMAGE) };
      } else if (tab.document) {
        buffer = { path: tab.path, format: 'prosemirror', content: JSON.stringify(withoutEmbeddedImages(tab.document)) };
      }
    }
    if (!buffer) continue;
    const size = byteLength(buffer.content);
    if (size > CODEX_CONTEXT_LIMITS.maxBufferBytes) throw new Error(`“${tab.name}”的未保存缓冲区超过 ${Math.round(CODEX_CONTEXT_LIMITS.maxBufferBytes / 1024)} KiB，无法作为上下文发送`);
    totalBytes += size;
    if (buffers.length >= CODEX_CONTEXT_LIMITS.maxBuffers) throw new Error(`一次最多发送 ${CODEX_CONTEXT_LIMITS.maxBuffers} 个未保存缓冲区`);
    if (totalBytes > CODEX_CONTEXT_LIMITS.maxTotalBufferBytes) throw new Error(`未保存缓冲区总计不能超过 ${Math.round(CODEX_CONTEXT_LIMITS.maxTotalBufferBytes / 1024 / 1024)} MiB`);
    buffers.push(buffer);
  }
  return buffers;
}

export const codexContextInternals = { withoutEmbeddedImages };
