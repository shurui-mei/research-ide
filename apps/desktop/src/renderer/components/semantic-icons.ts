import type { IconName } from './Icon';

/**
 * Components refer to user intent instead of choosing visual glyphs locally.
 * This keeps iconography stable while accessible labels can be translated.
 */
export const semanticIcons = Object.freeze({
  formatting: {
    bold: 'bold', italic: 'italic', underline: 'underline', subscript: 'subscript', superscript: 'superscript', highlight: 'highlight',
    alignLeft: 'alignLeft', alignCenter: 'alignCenter', alignRight: 'alignRight', alignJustify: 'alignJustify',
    lineSpacing: 'lineSpacing', spacingBefore: 'spacingBefore', spacingAfter: 'spacingAfter',
    firstLineIndent: 'indentFirst', leftIndent: 'indentLeft', rightIndent: 'indentRight',
    fontFamily: 'fontFamily', fontSize: 'fontSize', textColor: 'textColor',
    bulletList: 'list', orderedList: 'orderedList', quote: 'quote', link: 'link',
  },
  table: {
    insert: 'table', addColumn: 'columnAdd', deleteColumn: 'columnDelete', addRow: 'rowAdd', deleteRow: 'rowDelete',
    mergeCells: 'mergeCells', splitCell: 'splitCell', delete: 'tableDelete',
  },
  document: { image: 'upload', undo: 'undo', redo: 'redo' },
  conversation: { archive: 'archive', unarchive: 'undo', delete: 'trash' },
  navigation: { commandCenter: 'command' },
} as const satisfies Record<string, Record<string, IconName>>);
