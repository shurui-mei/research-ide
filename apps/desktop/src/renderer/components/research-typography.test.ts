import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { ResearchParagraphFormatting, ResearchTextStyle } from './research-typography';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe('research document typography', () => {
  it('parses safe DOCX formatting attributes into the editor model and renders them back', () => {
    const editor = new Editor({
      extensions: [StarterKit, ResearchParagraphFormatting, ResearchTextStyle],
      content: '<p data-ri-line-height="1.5" data-ri-space-before-pt="6" data-ri-space-after-pt="12" data-ri-text-align="justify" data-ri-first-line-indent-cm="1.27" data-ri-left-indent-cm="1.27" data-ri-right-indent-cm="0.64"><span data-ri-font-family="Times New Roman" data-ri-font-size-pt="12" data-ri-color="#123456">Results</span></p>',
    });
    editors.push(editor);

    expect(editor.getJSON()).toMatchObject({
      content: [{
        type: 'paragraph',
        attrs: {
          lineHeight: 1.5,
          spaceBeforePt: 6,
          spaceAfterPt: 12,
          textAlign: 'justify',
          firstLineIndentCm: 1.27,
          leftIndentCm: 1.27,
          rightIndentCm: 0.64,
        },
        content: [{
          text: 'Results',
          marks: [{ type: 'textStyle', attrs: { fontFamily: 'Times New Roman', fontSizePt: 12, color: '#123456' } }],
        }],
      }],
    });
    const html = editor.getHTML();
    for (const expected of ['data-ri-line-height="1.5"', 'data-ri-text-align="justify"', 'data-ri-font-family="Times New Roman"', 'data-ri-color="#123456"', 'font-size: 12pt']) {
      expect(html).toContain(expected);
    }
  });

  it('normalizes imported values outside the editable ranges instead of rendering arbitrary CSS', () => {
    const editor = new Editor({
      extensions: [StarterKit, ResearchParagraphFormatting, ResearchTextStyle],
      content: '<p data-ri-line-height="999"><span data-ri-font-family="serif; color: red" data-ri-color="url(test)">Safe</span></p>',
    });
    editors.push(editor);

    expect(editor.getJSON().content?.[0].attrs?.lineHeight).toBe(1.15);
    expect(editor.getJSON().content?.[0].content?.[0].marks).toBeUndefined();
    expect(editor.getHTML()).not.toContain('url(test)');
    expect(editor.getHTML()).not.toContain('color: red');
  });
});
