import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import Underline from '@tiptap/extension-underline';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { ResearchParagraphFormatting, ResearchTextStyle, TYPOGRAPHY_LIMITS } from './research-typography';
import { semanticIcons } from './semantic-icons';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const ResearchImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => {
          const width = Number(element.getAttribute('width'));
          return Number.isFinite(width) && width > 0 ? Math.min(width, 624) : null;
        },
        renderHTML: (attributes) => attributes.width ? { width: String(attributes.width) } : {},
      },
      height: {
        default: null,
        parseHTML: (element) => {
          const height = Number(element.getAttribute('height'));
          return Number.isFinite(height) && height > 0 ? Math.min(height, 900) : null;
        },
        renderHTML: (attributes) => attributes.height ? { height: String(attributes.height) } : {},
      },
    };
  },
}).configure({ allowBase64: true, HTMLAttributes: { class: 'research-doc-image' } });

function safeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function cleanPastedHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script,style,iframe,object,embed,form,meta,link').forEach((element) => element.remove());
  parsed.querySelectorAll('img').forEach((element) => {
    if (!/^data:image\/(?:png|jpeg|jpg|gif|bmp);base64,/iu.test(element.getAttribute('src') ?? '')) element.remove();
  });
  parsed.querySelectorAll('a').forEach((element) => {
    const href = element.getAttribute('href') ?? '';
    if (!safeLink(href)) element.removeAttribute('href');
    element.removeAttribute('target');
  });
  parsed.body.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) if (attribute.name.startsWith('on') || attribute.name === 'style') element.removeAttribute(attribute.name);
  });
  return parsed.body.innerHTML;
}

function ToolbarButton({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return <button aria-label={label} className={active ? 'active' : ''} disabled={disabled} onClick={onClick} title={label} type="button"><Icon name={icon} size={15} /></button>;
}

const LINE_HEIGHTS = [1, 1.15, 1.5, 2] as const;
const FONT_SIZES = [9, 10, 10.5, 11, 12, 14, 16, 18, 24] as const;
const FONT_FAMILIES = ['Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Georgia', 'Noto Serif', 'Noto Sans', '宋体', '黑体'] as const;
const BLOCK_TYPES = ['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem'] as const;

function promptNumber(label: string, current: number, min: number, max: number): number | null {
  const raw = window.prompt(`${label}（${min}–${max}）`, String(current));
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    window.alert(`请输入 ${min} 到 ${max} 之间的数字`);
    return null;
  }
  return Math.round(value * 100) / 100;
}

async function fileAsImage(file: File): Promise<{ src: string; width: number; height: number }> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(file.type)) throw new Error('仅支持 PNG、JPEG、GIF 或 BMP 图片');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB');
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取图片'));
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片格式无效'));
    reader.readAsDataURL(file);
  });
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new window.Image();
    image.onerror = () => reject(new Error('无法解析图片'));
    image.onload = () => {
      const width = Math.min(Math.max(image.naturalWidth, 1), 624);
      resolve({ width, height: Math.max(1, Math.round(width * image.naturalHeight / Math.max(image.naturalWidth, 1))) });
    };
    image.src = src;
  });
  return { src, ...dimensions };
}

export function RichTextEditor({
  content,
  onChange,
  editable = true,
}: {
  content: Record<string, unknown> | string;
  onChange(content: Record<string, unknown>): void;
  editable?: boolean;
}) {
  const onChangeRef = useRef(onChange);
  const imageInput = useRef<HTMLInputElement>(null);
  const colorInput = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState('');
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const editor = useEditor({
    extensions: [
      StarterKit,
      ResearchParagraphFormatting,
      ResearchTextStyle,
      Underline,
      Subscript,
      Superscript,
      Highlight,
      Link.configure({
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
        protocols: ['http', 'https', 'mailto'],
        isAllowedUri: (url, { defaultValidate }) => defaultValidate(url) && safeLink(url),
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      ResearchImage,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content,
    editable,
    editorProps: {
      attributes: {
        class: 'research-document-content',
        spellcheck: 'true',
      },
      transformPastedHTML: cleanPastedHtml,
    },
    onUpdate({ editor: current }) {
      onChangeRef.current(current.getJSON() as Record<string, unknown>);
    },
  });

  useEffect(() => { editor?.setEditable(editable, false); }, [editable, editor]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (typeof content === 'string') {
      if (editor.getHTML() !== content) editor.commands.setContent(content, false);
    } else if (JSON.stringify(editor.getJSON()) !== JSON.stringify(content)) {
      editor.commands.setContent(content, false);
    }
  }, [content, editor]);

  if (!editor) return <div className="document-loading"><span className="spinner" />正在准备文档编辑器…</div>;

  const editLink = () => {
    const previous = String(editor.getAttributes('link').href ?? 'https://');
    const value = window.prompt('输入完整链接（https://、http:// 或 mailto:）', previous);
    if (value === null) return;
    if (!value.trim()) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    if (!safeLink(value.trim())) { window.alert('链接无效，仅允许 http、https 或 mailto 链接，且不能包含凭据'); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: value.trim() }).run();
  };

  const resizeImage = (factor: number) => {
    const attributes = editor.getAttributes('image');
    const currentWidth = Number(attributes.width) || 480;
    const currentHeight = Number(attributes.height) || Math.round(currentWidth * 2 / 3);
    const width = Math.max(80, Math.min(624, Math.round(currentWidth * factor)));
    editor.chain().focus().updateAttributes('image', { width, height: Math.max(1, Math.round(currentHeight * width / currentWidth)) }).run();
  };

  const activeBlockType = BLOCK_TYPES.find((type) => editor.isActive(type)) ?? 'paragraph';
  const blockAttributes = editor.getAttributes(activeBlockType) as Record<string, unknown>;
  const textStyleAttributes = editor.getAttributes('textStyle') as Record<string, unknown>;
  const blockNumber = (name: string, fallback: number) => Number.isFinite(Number(blockAttributes[name])) ? Number(blockAttributes[name]) : fallback;
  const currentLineHeight = blockNumber('lineHeight', 1.15);
  const currentFontSize = Number.isFinite(Number(textStyleAttributes.fontSizePt)) ? Number(textStyleAttributes.fontSizePt) : 0;
  const currentFontFamily = typeof textStyleAttributes.fontFamily === 'string' ? textStyleAttributes.fontFamily : '';
  const currentColor = typeof textStyleAttributes.color === 'string' && /^#[0-9a-f]{6}$/iu.test(textStyleAttributes.color) ? textStyleAttributes.color : '#000000';

  const updateBlocks = (attributes: Record<string, unknown>) => {
    editor.chain().focus()
      .updateAttributes('paragraph', attributes)
      .updateAttributes('heading', attributes)
      .updateAttributes('blockquote', attributes)
      .updateAttributes('codeBlock', attributes)
      .updateAttributes('listItem', attributes)
      .run();
  };

  const updateBlockNumber = (name: string, label: string, min: number, max: number, fallback: number) => {
    const value = promptNumber(label, blockNumber(name, fallback), min, max);
    if (value !== null) updateBlocks({ [name]: value });
  };

  const updateTextStyle = (attributes: Record<string, unknown>) => {
    const next = { ...textStyleAttributes, ...attributes };
    editor.chain().focus().setMark('textStyle', next).run();
  };

  return (
    <div className="rich-editor-shell">
      <input
        accept="image/png,image/jpeg,image/gif,image/bmp"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setImageError('');
          try {
            const image = await fileAsImage(file);
            editor.chain().focus().insertContent({ type: 'image', attrs: { src: image.src, alt: file.name, title: file.name, width: image.width, height: image.height } }).run();
          } catch (error) { setImageError(error instanceof Error ? error.message : '图片插入失败'); }
        }}
        ref={imageInput}
        type="file"
      />
      <input
        aria-label="文字颜色"
        hidden
        onChange={(event) => updateTextStyle({ color: event.target.value.toUpperCase() })}
        ref={colorInput}
        type="color"
        value={currentColor}
      />
      <div className="rich-toolbar" role="toolbar" aria-label="文档格式">
        <label className="toolbar-select-control" title="段落样式">
          <Icon name="heading" size={15} />
          <select
            aria-label="段落样式"
            disabled={!editable}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'paragraph') editor.chain().focus().setParagraph().run();
              else editor.chain().focus().toggleHeading({ level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
            }}
            value={editor.isActive('heading', { level: 1 }) ? '1' : editor.isActive('heading', { level: 2 }) ? '2' : editor.isActive('heading', { level: 3 }) ? '3' : editor.isActive('heading', { level: 4 }) ? '4' : editor.isActive('heading', { level: 5 }) ? '5' : editor.isActive('heading', { level: 6 }) ? '6' : 'paragraph'}
          >
            <option value="paragraph">正文</option><option value="1">标题 1</option><option value="2">标题 2</option><option value="3">标题 3</option><option value="4">标题 4</option><option value="5">标题 5</option><option value="6">标题 6</option>
          </select>
        </label>
        <label className="toolbar-select-control font-family-select" title="字体">
          <Icon name={semanticIcons.formatting.fontFamily} size={15} />
          <select aria-label="字体" disabled={!editable} onChange={(event) => updateTextStyle({ fontFamily: event.target.value || null })} value={currentFontFamily}>
            <option value="">默认字体</option>
            {FONT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
          </select>
        </label>
        <label className="toolbar-select-control font-size-select" title="字号">
          <Icon name={semanticIcons.formatting.fontSize} size={15} />
          <select
            aria-label="字号"
            disabled={!editable}
            onChange={(event) => {
              if (event.target.value === 'custom') {
                const value = promptNumber('字号（pt）', currentFontSize || 12, TYPOGRAPHY_LIMITS.fontSizePt.min, TYPOGRAPHY_LIMITS.fontSizePt.max);
                if (value !== null) updateTextStyle({ fontSizePt: value });
              } else updateTextStyle({ fontSizePt: event.target.value ? Number(event.target.value) : null });
            }}
            value={currentFontSize ? String(currentFontSize) : ''}
          >
            <option value="">默认</option>
            {FONT_SIZES.map((size) => <option key={size} value={size}>{size} pt</option>)}
            {currentFontSize > 0 && !FONT_SIZES.some((size) => size === currentFontSize) && <option value={currentFontSize}>{currentFontSize} pt</option>}
            <option value="custom">自定义…</option>
          </select>
        </label>
        <span className="toolbar-divider" />
        <ToolbarButton active={editor.isActive('bold')} disabled={!editable} icon={semanticIcons.formatting.bold} label="粗体" onClick={() => editor.chain().focus().toggleBold().run()} />
        <ToolbarButton active={editor.isActive('italic')} disabled={!editable} icon={semanticIcons.formatting.italic} label="斜体" onClick={() => editor.chain().focus().toggleItalic().run()} />
        <ToolbarButton active={editor.isActive('underline')} disabled={!editable} icon={semanticIcons.formatting.underline} label="下划线" onClick={() => editor.chain().focus().toggleUnderline().run()} />
        <ToolbarButton active={editor.isActive('subscript')} disabled={!editable} icon={semanticIcons.formatting.subscript} label="下标" onClick={() => editor.chain().focus().toggleSubscript().run()} />
        <ToolbarButton active={editor.isActive('superscript')} disabled={!editable} icon={semanticIcons.formatting.superscript} label="上标" onClick={() => editor.chain().focus().toggleSuperscript().run()} />
        <ToolbarButton active={editor.isActive('highlight')} disabled={!editable} icon={semanticIcons.formatting.highlight} label="高亮" onClick={() => editor.chain().focus().toggleHighlight().run()} />
        <ToolbarButton disabled={!editable} icon={semanticIcons.formatting.textColor} label="文字颜色" onClick={() => colorInput.current?.click()} />
        <span className="toolbar-divider" />
        <label className="toolbar-select-control line-spacing-select" title="行距">
          <Icon name={semanticIcons.formatting.lineSpacing} size={15} />
          <select
            aria-label="行距"
            disabled={!editable}
            onChange={(event) => {
              if (event.target.value === 'custom') {
                const value = promptNumber('行距倍数', currentLineHeight, TYPOGRAPHY_LIMITS.lineHeight.min, TYPOGRAPHY_LIMITS.lineHeight.max);
                if (value !== null) updateBlocks({ lineHeight: value });
              } else updateBlocks({ lineHeight: Number(event.target.value) });
            }}
            value={String(currentLineHeight)}
          >
            {LINE_HEIGHTS.map((height) => <option key={height} value={height}>{height}×</option>)}
            {!LINE_HEIGHTS.some((height) => height === currentLineHeight) && <option value={currentLineHeight}>{currentLineHeight}×</option>}
            <option value="custom">自定义…</option>
          </select>
        </label>
        <ToolbarButton disabled={!editable} icon={semanticIcons.formatting.spacingBefore} label={`段前间距（当前 ${blockNumber('spaceBeforePt', 0)} pt）`} onClick={() => updateBlockNumber('spaceBeforePt', '段前间距（pt）', TYPOGRAPHY_LIMITS.spacingPt.min, TYPOGRAPHY_LIMITS.spacingPt.max, 0)} />
        <ToolbarButton disabled={!editable} icon={semanticIcons.formatting.spacingAfter} label={`段后间距（当前 ${blockNumber('spaceAfterPt', 5)} pt）`} onClick={() => updateBlockNumber('spaceAfterPt', '段后间距（pt）', TYPOGRAPHY_LIMITS.spacingPt.min, TYPOGRAPHY_LIMITS.spacingPt.max, 5)} />
        <ToolbarButton disabled={!editable} icon={semanticIcons.formatting.firstLineIndent} label={`首行缩进（当前 ${blockNumber('firstLineIndentCm', 0)} cm）`} onClick={() => updateBlockNumber('firstLineIndentCm', '首行缩进（cm，负值表示悬挂缩进）', TYPOGRAPHY_LIMITS.firstLineIndentCm.min, TYPOGRAPHY_LIMITS.firstLineIndentCm.max, 0)} />
        <ToolbarButton disabled={!editable} icon={semanticIcons.formatting.leftIndent} label={`左缩进（当前 ${blockNumber('leftIndentCm', 0)} cm）`} onClick={() => updateBlockNumber('leftIndentCm', '左缩进（cm）', TYPOGRAPHY_LIMITS.sideIndentCm.min, TYPOGRAPHY_LIMITS.sideIndentCm.max, 0)} />
        <ToolbarButton disabled={!editable} icon={semanticIcons.formatting.rightIndent} label={`右缩进（当前 ${blockNumber('rightIndentCm', 0)} cm）`} onClick={() => updateBlockNumber('rightIndentCm', '右缩进（cm）', TYPOGRAPHY_LIMITS.sideIndentCm.min, TYPOGRAPHY_LIMITS.sideIndentCm.max, 0)} />
        <ToolbarButton active={blockAttributes.textAlign === 'left'} disabled={!editable} icon={semanticIcons.formatting.alignLeft} label="左对齐" onClick={() => updateBlocks({ textAlign: 'left' })} />
        <ToolbarButton active={blockAttributes.textAlign === 'center'} disabled={!editable} icon={semanticIcons.formatting.alignCenter} label="居中对齐" onClick={() => updateBlocks({ textAlign: 'center' })} />
        <ToolbarButton active={blockAttributes.textAlign === 'right'} disabled={!editable} icon={semanticIcons.formatting.alignRight} label="右对齐" onClick={() => updateBlocks({ textAlign: 'right' })} />
        <ToolbarButton active={blockAttributes.textAlign === 'justify'} disabled={!editable} icon={semanticIcons.formatting.alignJustify} label="两端对齐" onClick={() => updateBlocks({ textAlign: 'justify' })} />
        <span className="toolbar-divider" />
        <ToolbarButton active={editor.isActive('bulletList')} disabled={!editable} icon={semanticIcons.formatting.bulletList} label="项目符号列表" onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <ToolbarButton active={editor.isActive('orderedList')} disabled={!editable} icon={semanticIcons.formatting.orderedList} label="编号列表" onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <ToolbarButton active={editor.isActive('blockquote')} disabled={!editable} icon={semanticIcons.formatting.quote} label="引用" onClick={() => editor.chain().focus().toggleBlockquote().run()} />
        <ToolbarButton active={editor.isActive('link')} disabled={!editable} icon={semanticIcons.formatting.link} label="插入或编辑链接" onClick={editLink} />
        <span className="toolbar-divider" />
        <ToolbarButton disabled={!editable} icon={semanticIcons.table.insert} label="插入 3×3 表格" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
        <ToolbarButton disabled={!editable} icon={semanticIcons.document.image} label="插入本地图片" onClick={() => imageInput.current?.click()} />
        {editor.isActive('image') && <>
          <ToolbarButton disabled={!editable} icon="zoomOut" label="缩小图片" onClick={() => resizeImage(0.8)} />
          <ToolbarButton disabled={!editable} icon="zoomIn" label="放大图片" onClick={() => resizeImage(1.25)} />
        </>}
        {editor.isActive('table') && <>
          <ToolbarButton disabled={!editable} icon={semanticIcons.table.addColumn} label="在后面插入列" onClick={() => editor.chain().focus().addColumnAfter().run()} />
          <ToolbarButton disabled={!editable} icon={semanticIcons.table.deleteColumn} label="删除当前列" onClick={() => editor.chain().focus().deleteColumn().run()} />
          <ToolbarButton disabled={!editable} icon={semanticIcons.table.addRow} label="在后面插入行" onClick={() => editor.chain().focus().addRowAfter().run()} />
          <ToolbarButton disabled={!editable} icon={semanticIcons.table.deleteRow} label="删除当前行" onClick={() => editor.chain().focus().deleteRow().run()} />
          <ToolbarButton disabled={!editable || !editor.can().mergeCells()} icon={semanticIcons.table.mergeCells} label="合并单元格" onClick={() => editor.chain().focus().mergeCells().run()} />
          <ToolbarButton disabled={!editable || !editor.can().splitCell()} icon={semanticIcons.table.splitCell} label="拆分单元格" onClick={() => editor.chain().focus().splitCell().run()} />
          <ToolbarButton disabled={!editable} icon={semanticIcons.table.delete} label="删除表格" onClick={() => editor.chain().focus().deleteTable().run()} />
        </>}
        <span className="toolbar-spacer" />
        {imageError && <span className="rich-toolbar-error" title={imageError}>{imageError}</span>}
        <ToolbarButton disabled={!editable || !editor.can().undo()} icon={semanticIcons.document.undo} label="撤销" onClick={() => editor.chain().focus().undo().run()} />
        <ToolbarButton disabled={!editable || !editor.can().redo()} icon={semanticIcons.document.redo} label="重做" onClick={() => editor.chain().focus().redo().run()} />
      </div>
      <div className="document-canvas" onClick={() => editor.commands.focus()}>
        <div className="document-page">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
