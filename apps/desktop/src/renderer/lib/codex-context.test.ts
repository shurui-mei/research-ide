import { describe, expect, it } from 'vitest';
import type { EditorTab } from '../types';
import { buildCodexContextBuffers } from './codex-context';

describe('Codex editor context buffers', () => {
  it('uses only selected dirty editor state and leaves saved files as mentions', () => {
    const tabs: EditorTab[] = [
      { id: 'dirty', name: 'draft.md', path: 'draft.md', kind: 'text', content: 'current unsaved text', dirty: true },
      { id: 'saved', name: 'saved.md', path: 'saved.md', kind: 'text', content: 'saved text', dirty: false },
      { id: 'other', name: 'other.md', path: 'other.md', kind: 'text', content: 'not selected', dirty: true },
    ];
    expect(buildCodexContextBuffers(['draft.md', 'saved.md'], tabs)).toEqual([
      { path: 'draft.md', format: 'text', content: 'current unsaved text' },
    ]);
  });

  it('removes base64 images from an unsaved ProseMirror document', () => {
    const tabs: EditorTab[] = [{
      id: 'paper', name: 'paper.docx', path: 'paper.docx', kind: 'docx', dirty: true,
      document: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Live paragraph' }] },
          { type: 'image', attrs: { src: 'data:image/png;base64,QUJDRA==', alt: 'Figure 1' } },
        ],
      },
    }];
    const [buffer] = buildCodexContextBuffers(['paper.docx'], tabs);
    expect(buffer.format).toBe('prosemirror');
    expect(buffer.content).toContain('Live paragraph');
    expect(buffer.content).toContain('embedded image omitted');
    expect(buffer.content).not.toContain('data:image');
  });

  it('rejects an oversized dirty buffer before crossing IPC', () => {
    const tabs: EditorTab[] = [{
      id: 'large', name: 'large.txt', path: 'large.txt', kind: 'text', content: 'x'.repeat(512 * 1024 + 1), dirty: true,
    }];
    expect(() => buildCodexContextBuffers(['large.txt'], tabs)).toThrow(/512 KiB/u);
  });
});
