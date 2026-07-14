import { Extension } from '@tiptap/core';
import { TextStyle } from '@tiptap/extension-text-style';

export const TYPOGRAPHY_LIMITS = Object.freeze({
  lineHeight: { min: 0.8, max: 4 },
  spacingPt: { min: 0, max: 144 },
  firstLineIndentCm: { min: -5, max: 10 },
  sideIndentCm: { min: 0, max: 10 },
  fontSizePt: { min: 6, max: 96 },
});

const finiteNumber = (value: unknown, min: number, max: number): number | null => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

const dataNumber = (element: HTMLElement, name: string, min: number, max: number): number | null =>
  finiteNumber(element.getAttribute(name), min, max);

const safeFontFamily = (value: unknown): string | null => {
  const normalized = String(value ?? '').trim().replace(/^['"]|['"]$/gu, '');
  return normalized && normalized.length <= 64 && new TextEncoder().encode(normalized).byteLength <= 96 && /^[\p{L}\p{N} .,'-]+$/u.test(normalized) ? normalized : null;
};

const safeColor = (value: unknown): string | null => {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^#[0-9A-F]{6}$/u.test(normalized) ? normalized : null;
};

const styleAttribute = (property: string, value: string | number | null, unit = ''): Record<string, string> =>
  value === null ? {} : { style: `${property}: ${value}${unit}` };

export const ResearchTextStyle = TextStyle.extend({
  parseHTML() {
    return [{
      tag: 'span',
      getAttrs: (element) => {
        const html = element as HTMLElement;
        const font = safeFontFamily(html.getAttribute('data-ri-font-family') ?? html.style.fontFamily);
        const size = dataNumber(html, 'data-ri-font-size-pt', TYPOGRAPHY_LIMITS.fontSizePt.min, TYPOGRAPHY_LIMITS.fontSizePt.max);
        const color = safeColor(html.getAttribute('data-ri-color') ?? html.style.color);
        return font || size !== null || color ? {} : false;
      },
    }];
  },

  addAttributes() {
    return {
      fontFamily: {
        default: null,
        parseHTML: (element: HTMLElement) => safeFontFamily(element.getAttribute('data-ri-font-family') ?? element.style.fontFamily),
        renderHTML: (attributes: Record<string, unknown>) => {
          const value = safeFontFamily(attributes.fontFamily);
          return value ? { 'data-ri-font-family': value, ...styleAttribute('font-family', `'${value}'`) } : {};
        },
      },
      fontSizePt: {
        default: null,
        parseHTML: (element: HTMLElement) => dataNumber(element, 'data-ri-font-size-pt', TYPOGRAPHY_LIMITS.fontSizePt.min, TYPOGRAPHY_LIMITS.fontSizePt.max),
        renderHTML: (attributes: Record<string, unknown>) => {
          const value = finiteNumber(attributes.fontSizePt, TYPOGRAPHY_LIMITS.fontSizePt.min, TYPOGRAPHY_LIMITS.fontSizePt.max);
          return value === null ? {} : { 'data-ri-font-size-pt': String(value), ...styleAttribute('font-size', value, 'pt') };
        },
      },
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => safeColor(element.getAttribute('data-ri-color') ?? element.style.color),
        renderHTML: (attributes: Record<string, unknown>) => {
          const value = safeColor(attributes.color);
          return value ? { 'data-ri-color': value, ...styleAttribute('color', value) } : {};
        },
      },
    };
  },
});

const alignment = (value: unknown): 'left' | 'center' | 'right' | 'justify' | null =>
  ['left', 'center', 'right', 'justify'].includes(String(value)) ? value as 'left' | 'center' | 'right' | 'justify' : null;

export const ResearchParagraphFormatting = Extension.create({
  name: 'researchParagraphFormatting',

  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem'],
      attributes: {
        lineHeight: {
          default: 1.15,
          parseHTML: (element: HTMLElement) => dataNumber(element, 'data-ri-line-height', TYPOGRAPHY_LIMITS.lineHeight.min, TYPOGRAPHY_LIMITS.lineHeight.max) ?? 1.15,
          renderHTML: (attributes: Record<string, unknown>) => {
            const value = finiteNumber(attributes.lineHeight, TYPOGRAPHY_LIMITS.lineHeight.min, TYPOGRAPHY_LIMITS.lineHeight.max) ?? 1.15;
            return { 'data-ri-line-height': String(value), ...styleAttribute('line-height', value) };
          },
        },
        spaceBeforePt: {
          default: 0,
          parseHTML: (element: HTMLElement) => dataNumber(element, 'data-ri-space-before-pt', TYPOGRAPHY_LIMITS.spacingPt.min, TYPOGRAPHY_LIMITS.spacingPt.max) ?? 0,
          renderHTML: (attributes: Record<string, unknown>) => {
            const value = finiteNumber(attributes.spaceBeforePt, TYPOGRAPHY_LIMITS.spacingPt.min, TYPOGRAPHY_LIMITS.spacingPt.max) ?? 0;
            return { 'data-ri-space-before-pt': String(value), ...styleAttribute('margin-top', value, 'pt') };
          },
        },
        spaceAfterPt: {
          default: 5,
          parseHTML: (element: HTMLElement) => dataNumber(element, 'data-ri-space-after-pt', TYPOGRAPHY_LIMITS.spacingPt.min, TYPOGRAPHY_LIMITS.spacingPt.max) ?? 5,
          renderHTML: (attributes: Record<string, unknown>) => {
            const value = finiteNumber(attributes.spaceAfterPt, TYPOGRAPHY_LIMITS.spacingPt.min, TYPOGRAPHY_LIMITS.spacingPt.max) ?? 5;
            return { 'data-ri-space-after-pt': String(value), ...styleAttribute('margin-bottom', value, 'pt') };
          },
        },
        textAlign: {
          default: 'left',
          parseHTML: (element: HTMLElement) => alignment(element.getAttribute('data-ri-text-align')) ?? 'left',
          renderHTML: (attributes: Record<string, unknown>) => {
            const value = alignment(attributes.textAlign) ?? 'left';
            return { 'data-ri-text-align': value, ...styleAttribute('text-align', value) };
          },
        },
        firstLineIndentCm: {
          default: 0,
          parseHTML: (element: HTMLElement) => dataNumber(element, 'data-ri-first-line-indent-cm', TYPOGRAPHY_LIMITS.firstLineIndentCm.min, TYPOGRAPHY_LIMITS.firstLineIndentCm.max) ?? 0,
          renderHTML: (attributes: Record<string, unknown>) => {
            const value = finiteNumber(attributes.firstLineIndentCm, TYPOGRAPHY_LIMITS.firstLineIndentCm.min, TYPOGRAPHY_LIMITS.firstLineIndentCm.max) ?? 0;
            return { 'data-ri-first-line-indent-cm': String(value), ...styleAttribute('text-indent', value, 'cm') };
          },
        },
        leftIndentCm: {
          default: 0,
          parseHTML: (element: HTMLElement) => dataNumber(element, 'data-ri-left-indent-cm', TYPOGRAPHY_LIMITS.sideIndentCm.min, TYPOGRAPHY_LIMITS.sideIndentCm.max) ?? 0,
          renderHTML: (attributes: Record<string, unknown>) => {
            const value = finiteNumber(attributes.leftIndentCm, TYPOGRAPHY_LIMITS.sideIndentCm.min, TYPOGRAPHY_LIMITS.sideIndentCm.max) ?? 0;
            return { 'data-ri-left-indent-cm': String(value), ...styleAttribute('margin-left', value, 'cm') };
          },
        },
        rightIndentCm: {
          default: 0,
          parseHTML: (element: HTMLElement) => dataNumber(element, 'data-ri-right-indent-cm', TYPOGRAPHY_LIMITS.sideIndentCm.min, TYPOGRAPHY_LIMITS.sideIndentCm.max) ?? 0,
          renderHTML: (attributes: Record<string, unknown>) => {
            const value = finiteNumber(attributes.rightIndentCm, TYPOGRAPHY_LIMITS.sideIndentCm.min, TYPOGRAPHY_LIMITS.sideIndentCm.max) ?? 0;
            return { 'data-ri-right-indent-cm': String(value), ...styleAttribute('margin-right', value, 'cm') };
          },
        },
      },
    }];
  },
});
