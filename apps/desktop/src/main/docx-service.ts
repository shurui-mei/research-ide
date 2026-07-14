import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AlignmentType,
  Document as DocxDocument,
  ExternalHyperlink,
  HeadingLevel,
  HighlightColor,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type FileChild,
  type ICharacterStyleOptions,
  type ParagraphChild,
} from 'docx';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { DocxCompatibilityWarning, DocxOpenResult, DocxSaveRequest, DocxSaveResult } from '../shared/types';
import { AppError } from './errors';
import type { ProjectService } from './project-service';
import type { SnapshotService } from './snapshot-service';
import { flushFileHandle, syncParentDirectory } from './file-durability';

const MAX_DOCX_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 300 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_XML_BYTES = 20 * 1024 * 1024;
// JSON and imported HTML include base64-expanded images. Keep both envelopes
// large enough for the full image budget plus the independent text budget.
const MAX_DOCUMENT_JSON_BYTES = 80 * 1024 * 1024;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMPORTED_IMAGE_BYTES = MAX_TOTAL_IMAGE_BYTES;
const MAX_IMPORTED_HTML_BYTES = 80 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
]);
const OFFICE_RELATIONSHIP_NAMESPACES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
] as const;
const DRAWINGML_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const WORDPROCESSINGML_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const OFFICE_MATH_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/math',
  'http://purl.oclc.org/ooxml/officeDocument/math',
]);
const VML_NAMESPACE = 'urn:schemas-microsoft-com:vml';

interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  marks?: ProseMirrorMark[];
  text?: string;
}

interface ObservedDocx {
  hash: string;
  warnings: DocxCompatibilityWarning[];
  readOnly: boolean;
}

interface DecodedImage {
  data: Buffer;
  type: 'jpg' | 'png' | 'gif' | 'bmp';
  width: number;
  height: number;
  alt: string;
}

interface ParagraphFormat {
  lineHeight?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  firstLineIndentCm?: number;
  leftIndentCm?: number;
  rightIndentCm?: number;
}

interface TextStyleFormat {
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
}

interface DocumentConversionContext {
  listInstance: number;
  characterStyles: Map<string, { format: TextStyleFormat; definition: ICharacterStyleOptions }>;
}

const RESEARCH_CHARACTER_STYLE_PREFIX = 'RIDE-C-';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function warning(
  code: string,
  title: string,
  detail: string,
  severity: DocxCompatibilityWarning['severity'] = 'warning',
  requiresAcknowledgement = true,
): DocxCompatibilityWarning {
  return { code, title, detail, severity, requiresAcknowledgement };
}

function inspectZipEnvelope(buffer: Buffer): Set<string> {
  if (buffer.byteLength < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new AppError('INVALID_DOCX', 'The file is not a valid DOCX package');
  const searchStart = Math.max(0, buffer.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = buffer.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new AppError('INVALID_DOCX', 'The DOCX package has no ZIP directory');
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const directorySize = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new AppError('DOCX_ZIP64_UNSUPPORTED', 'ZIP64 DOCX files are not supported');
  if (entryCount <= 0 || entryCount > MAX_ZIP_ENTRIES || directoryOffset + directorySize > buffer.byteLength) throw new AppError('INVALID_DOCX', 'The DOCX ZIP directory is invalid or too large');
  const names = new Set<string>();
  let totalUncompressed = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.byteLength || buffer.readUInt32LE(offset) !== 0x02014b50) throw new AppError('INVALID_DOCX', 'The DOCX ZIP directory is corrupt');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > buffer.byteLength || !nameLength) throw new AppError('INVALID_DOCX', 'The DOCX ZIP entry is invalid');
    if ((flags & 1) !== 0) throw new AppError('DOCX_ENCRYPTED', 'Password-protected or encrypted DOCX files cannot be edited');
    if (method !== 0 && method !== 8) throw new AppError('DOCX_COMPRESSION_UNSUPPORTED', 'The DOCX uses an unsupported compression method');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
    const components = name.split('/');
    if (name.startsWith('/') || /^[a-z]:\//iu.test(name) || components.includes('..') || name.includes('\0')) throw new AppError('UNSAFE_DOCX_ENTRY', 'The DOCX package contains an unsafe path');
    if (names.has(name)) throw new AppError('INVALID_DOCX', 'The DOCX package contains duplicate entries');
    names.add(name);
    totalUncompressed += uncompressed;
    if (uncompressed > MAX_UNCOMPRESSED_BYTES || totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new AppError('DOCX_EXPANSION_LIMIT', 'The DOCX expands beyond the 300 MB safety limit');
    if (uncompressed > 1024 * 1024 && (compressed === 0 || uncompressed / compressed > 200)) throw new AppError('DOCX_EXPANSION_LIMIT', 'The DOCX compression ratio exceeds the safety limit');
    offset = nextOffset;
  }
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
    if (!names.has(required)) throw new AppError('INVALID_DOCX', `The DOCX package is missing ${required}`);
  }
  return names;
}

async function xmlEntry(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) return '';
  const value = await entry.async('nodebuffer');
  if (value.byteLength > MAX_XML_BYTES) throw new AppError('DOCX_XML_TOO_LARGE', `${name} is larger than the XML safety limit`);
  return value.toString('utf8');
}

function parseXmlPart(source: string, name: string): Document {
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) throw new AppError('UNSAFE_DOCX_XML', `${name} contains a forbidden document type declaration`);
  const errors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message) => errors.push(String(message)),
      fatalError: (message) => errors.push(String(message)),
    },
  }).parseFromString(source, 'application/xml');
  if (!document.documentElement || errors.length) throw new AppError('INVALID_DOCX_XML', `${name} is not well-formed XML`);
  return document;
}

function localName(value: Node): string {
  return ((value as Node & { localName?: string | null }).localName || value.nodeName.split(':').at(-1) || '').toLowerCase();
}

function unqualifiedAttribute(element: Element, name: 'Id' | 'Type' | 'Target'): string | undefined {
  const attribute = element.getAttributeNode(name);
  return attribute && !attribute.namespaceURI ? attribute.value : undefined;
}

function officeRelationshipAttribute(element: Element, name: 'embed' | 'id' | 'link'): string | undefined {
  for (const namespace of OFFICE_RELATIONSHIP_NAMESPACES) {
    const attribute = element.getAttributeNodeNS(namespace, name);
    if (attribute) return attribute.value;
  }
  return undefined;
}

function relationshipSourcePart(relationshipPart: string): string | undefined {
  if (relationshipPart === '_rels/.rels') return undefined;
  const marker = '/_rels/';
  const markerIndex = relationshipPart.lastIndexOf(marker);
  if (markerIndex < 0 || !relationshipPart.endsWith('.rels')) return undefined;
  const parent = relationshipPart.slice(0, markerIndex);
  const sourceName = relationshipPart.slice(markerIndex + marker.length, -'.rels'.length);
  return parent ? `${parent}/${sourceName}` : sourceName;
}

function relationshipSourceDirectory(relationshipPart: string): string | undefined {
  if (relationshipPart === '_rels/.rels') return '';
  const sourcePart = relationshipSourcePart(relationshipPart);
  return sourcePart ? path.posix.dirname(sourcePart).replace(/^\.$/u, '') : undefined;
}

function safePackageImageTarget(rawTarget: string | undefined, relationshipPart: string, packageNames: Set<string>): boolean {
  if (!rawTarget || rawTarget.length > 8_192 || rawTarget.includes('\0')) return false;
  let target: string;
  try { target = decodeURIComponent(rawTarget); } catch { return false; }
  if (!target || target.includes('\\') || target.startsWith('/') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/iu.test(target) || /^[a-z]:/iu.test(target) || /[?#]/u.test(target)) return false;
  const components = target.split('/');
  if (components.some((component) => !component || component === '.' || component === '..')) return false;
  const sourceDirectory = relationshipSourceDirectory(relationshipPart);
  if (sourceDirectory === undefined) return false;
  const resolved = path.posix.join(sourceDirectory, target);
  return !resolved.startsWith('../') && !path.posix.isAbsolute(resolved) && packageNames.has(resolved);
}

function safeRelationshipTarget(rawTarget: string | undefined, relationshipType: string | undefined, relationshipPart: string, packageNames: Set<string>): boolean {
  if (!rawTarget || rawTarget.length > 8_192 || rawTarget.includes('\0')) return false;
  let target: string;
  try { target = decodeURIComponent(rawTarget); } catch { return false; }
  const type = relationshipType?.trim().toLowerCase() ?? '';
  if (target.startsWith('#')) return type.endsWith('/hyperlink') && !target.includes('\\');
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
    if (!type.endsWith('/hyperlink')) return false;
    try {
      const url = new URL(target);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }
  return safePackageImageTarget(rawTarget, relationshipPart, packageNames);
}

function linkedImageRelationshipIds(document: Document): Set<string> {
  const result = new Set<string>();
  const elements = document.getElementsByTagName('*');
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements.item(index);
    if (!element || localName(element) !== 'blip' || !DRAWINGML_NAMESPACES.has(element.namespaceURI ?? '')) continue;
    const linkedId = officeRelationshipAttribute(element, 'link');
    if (linkedId) result.add(linkedId);
  }
  return result;
}

async function sanitizeImageRelationships(zip: JSZip, packageNames: Set<string>): Promise<{ conversionBuffer?: Buffer; removed: number }> {
  let removed = 0;
  const removedIdsBySourcePart = new Map<string, Set<string>>();
  for (const relationshipPart of packageNames) {
    if (!relationshipPart.toLowerCase().endsWith('.rels')) continue;
    const source = await xmlEntry(zip, relationshipPart);
    if (!source) continue;
    const document = parseXmlPart(source, relationshipPart);
    const sourcePart = relationshipSourcePart(relationshipPart);
    let linkedImageIds = new Set<string>();
    if (sourcePart?.toLowerCase().endsWith('.xml') && packageNames.has(sourcePart)) {
      const sourceXml = await xmlEntry(zip, sourcePart);
      if (sourceXml) linkedImageIds = linkedImageRelationshipIds(parseXmlPart(sourceXml, sourcePart));
    }
    const elements = document.getElementsByTagName('*');
    let changed = false;
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements.item(index);
      if (!element || localName(element) !== 'relationship' || !PACKAGE_RELATIONSHIP_NAMESPACES.has(element.namespaceURI ?? '')) continue;
      const type = unqualifiedAttribute(element, 'Type')?.trim().toLowerCase();
      const relationshipId = unqualifiedAttribute(element, 'Id');
      const target = unqualifiedAttribute(element, 'Target');
      const referencedAsLinkedImage = Boolean(relationshipId && linkedImageIds.has(relationshipId));
      const targetIsSafe = type?.endsWith('/image')
        ? safePackageImageTarget(target, relationshipPart, packageNames)
        : safeRelationshipTarget(target, type, relationshipPart, packageNames);
      if (!referencedAsLinkedImage && targetIsSafe) continue;
      if (relationshipId && sourcePart && packageNames.has(sourcePart)) {
        const ids = removedIdsBySourcePart.get(sourcePart) ?? new Set<string>();
        ids.add(relationshipId);
        removedIdsBySourcePart.set(sourcePart, ids);
      }
      element.parentNode?.removeChild(element);
      removed += 1;
      changed = true;
    }
    if (changed) zip.file(relationshipPart, new XMLSerializer().serializeToString(document));
  }
  for (const [sourcePart, removedIds] of removedIdsBySourcePart) {
    const source = await xmlEntry(zip, sourcePart);
    if (!source) continue;
    const document = parseXmlPart(source, sourcePart);
    const elements = document.getElementsByTagName('*');
    let changed = false;
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements.item(index);
      if (!element) continue;
      const elementNamespace = element.namespaceURI ?? '';
      const elementName = localName(element);
      const relationshipReference = elementName === 'blip' && DRAWINGML_NAMESPACES.has(elementNamespace)
        ? officeRelationshipAttribute(element, 'link') ?? officeRelationshipAttribute(element, 'embed')
        : elementName === 'imagedata' && elementNamespace === VML_NAMESPACE
          ? officeRelationshipAttribute(element, 'id')
          : undefined;
      const referencesRemovedImage = Boolean(relationshipReference && removedIds.has(relationshipReference));
      if (!referencesRemovedImage) continue;
      element.parentNode?.removeChild(element);
      changed = true;
    }
    if (changed) zip.file(sourcePart, new XMLSerializer().serializeToString(document));
  }
  if (!removed) return { removed };
  return {
    removed,
    conversionBuffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
  };
}

function hasNamespacedElement(document: Document | undefined, namespaces: Set<string>, names: readonly string[]): boolean {
  if (!document) return false;
  const expectedNames = new Set(names.map((name) => name.toLowerCase()));
  const elements = document.getElementsByTagName('*');
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements.item(index);
    if (element && namespaces.has(element.namespaceURI ?? '') && expectedNames.has(localName(element))) return true;
  }
  return false;
}

async function analyzePackage(buffer: Buffer): Promise<{ warnings: DocxCompatibilityWarning[]; readOnly: boolean; conversionBuffer: Buffer }> {
  const names = inspectZipEnvelope(buffer);
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false }); }
  catch { throw new AppError('INVALID_DOCX', 'The DOCX package failed integrity validation'); }
  const documentXml = await xmlEntry(zip, 'word/document.xml');
  const settingsXml = await xmlEntry(zip, 'word/settings.xml');
  const documentDom = parseXmlPart(documentXml, 'word/document.xml');
  const settingsDom = settingsXml ? parseXmlPart(settingsXml, 'word/settings.xml') : undefined;
  const relationshipSanitization = await sanitizeImageRelationships(zip, names);
  const conversionBuffer = relationshipSanitization.conversionBuffer ?? buffer;
  const hasUnsafeImageRelationship = relationshipSanitization.removed > 0;
  const warnings: DocxCompatibilityWarning[] = [warning(
    'round-trip-layout',
    'Word layout may be simplified',
    'Text, headings, lists, tables, links, and supported images are editable. Exact pagination, theme styles, and advanced Word layout are regenerated when saved.',
    'info',
  )];
  let readOnly = false;
  const blockingChecks: Array<[boolean, string, string, string]> = [
    [[...names].some((name) => /(^|\/)vbaProject\.bin$/iu.test(name)), 'macros', 'Macros detected', 'Macro-enabled content cannot be preserved safely. Open this file in Word or LibreOffice to edit it.'],
    [[...names].some((name) => name.toLowerCase().startsWith('_xmlsignatures/')), 'digital-signature', 'Digital signature detected', 'Saving would invalidate the document signature, so Research IDE opens this file read-only.'],
    [[...names].some((name) => name.toLowerCase().startsWith('word/embeddings/')), 'embedded-object', 'Embedded objects detected', 'Embedded OLE objects or packages cannot be preserved safely, so Research IDE opens this file read-only.'],
    [hasNamespacedElement(documentDom, WORDPROCESSINGML_NAMESPACES, ['altChunk']), 'alternate-content', 'Embedded alternate content detected', 'HTML or other alternate content blocks cannot be converted safely, so Research IDE opens this file read-only.'],
    [hasNamespacedElement(settingsDom, WORDPROCESSINGML_NAMESPACES, ['documentProtection']), 'document-protection', 'Document protection detected', 'Research IDE will not remove editing protection by regenerating this document, so it is opened read-only.'],
  ];
  for (const [present, code, title, detail] of blockingChecks) {
    if (!present) continue;
    readOnly = true;
    warnings.push(warning(code, title, detail, 'blocking'));
  }
  const lossyChecks: Array<[boolean, string, string, string]> = [
    [hasNamespacedElement(documentDom, WORDPROCESSINGML_NAMESPACES, ['ins', 'del', 'moveFrom', 'moveTo']), 'tracked-changes', 'Tracked changes will be flattened', 'Visible text is imported, but revision authorship and accept/reject state are not retained.'],
    [names.has('word/comments.xml'), 'comments', 'Comments are not retained', 'Word comments and comment threads are outside the current editable subset.'],
    [names.has('word/footnotes.xml') || names.has('word/endnotes.xml'), 'notes', 'Footnotes or endnotes are not retained', 'Footnote and endnote structures are outside the current editable subset.'],
    [[...names].some((name) => /^word\/(header|footer)\d+\.xml$/iu.test(name)), 'headers-footers', 'Headers and footers are regenerated', 'Existing headers, footers, and page-number fields are not retained.'],
    [hasNamespacedElement(documentDom, OFFICE_MATH_NAMESPACES, ['oMath', 'oMathPara']), 'equations', 'Word equations are not retained', 'OMML equations are outside the current editable subset.'],
    [hasNamespacedElement(documentDom, WORDPROCESSINGML_NAMESPACES, ['txbxContent', 'pict']), 'text-boxes', 'Text boxes or legacy drawings are not retained', 'Floating text boxes and legacy drawing objects are outside the current editable subset.'],
    [hasNamespacedElement(documentDom, WORDPROCESSINGML_NAMESPACES, ['fldSimple', 'instrText']), 'fields', 'Fields become plain text', 'Citations, cross-references, dates, and other Word fields lose their live-field behavior.'],
    [hasNamespacedElement(documentDom, WORDPROCESSINGML_NAMESPACES, ['sdt']), 'content-controls', 'Content controls become plain content', 'Form controls and structured document tags are not retained.'],
    [[...names].some((name) => name.toLowerCase().startsWith('word/diagrams/')), 'smart-art', 'SmartArt is not retained', 'SmartArt diagrams are outside the current editable subset.'],
    [hasUnsafeImageRelationship, 'external-media', 'Unsafe image relationships were omitted', 'Research IDE only reads images stored safely inside the DOCX package. File, network, absolute, traversal, and missing image targets are removed from the in-memory conversion copy.'],
  ];
  for (const [present, code, title, detail] of lossyChecks) if (present) warnings.push(warning(code, title, detail));
  return { warnings, readOnly, conversionBuffer };
}

function validImageDataUri(value: string): boolean {
  return /^data:image\/(?:png|jpeg|jpg|gif|bmp);base64,[a-z0-9+/=\s]+$/iu.test(value) && value.length <= Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100;
}

function boundedNumber(raw: unknown, min: number, max: number): number | undefined {
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 100) / 100 : undefined;
}

function safeFontFamily(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value && value.length <= 64 && Buffer.byteLength(value, 'utf8') <= 96 && /^[\p{L}\p{N} .,'-]+$/u.test(value) ? value : undefined;
}

function safeTextColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/u.test(value) ? value : undefined;
}

function paragraphFormatFromAttributes(attrs: Record<string, unknown> | undefined, strict = false): ParagraphFormat {
  if (!attrs) return {};
  const result: ParagraphFormat = {};
  const numeric: Array<[keyof ParagraphFormat, number, number]> = [
    ['lineHeight', 0.8, 4], ['spaceBeforePt', 0, 144], ['spaceAfterPt', 0, 144],
    ['firstLineIndentCm', -5, 10], ['leftIndentCm', 0, 10], ['rightIndentCm', 0, 10],
  ];
  for (const [name, min, max] of numeric) {
    if (attrs[name] === undefined || attrs[name] === null) continue;
    const value = boundedNumber(attrs[name], min, max);
    if (value === undefined) {
      if (strict) throw new AppError('INVALID_DOCUMENT_FORMATTING', `${name} is outside the supported range`);
      continue;
    }
    (result as Record<string, unknown>)[name] = value;
  }
  if (attrs.textAlign !== undefined && attrs.textAlign !== null) {
    const value = String(attrs.textAlign);
    if (['left', 'center', 'right', 'justify'].includes(value)) result.textAlign = value as ParagraphFormat['textAlign'];
    else if (strict) throw new AppError('INVALID_DOCUMENT_FORMATTING', 'textAlign is not supported');
  }
  return result;
}

function textStyleFromAttributes(attrs: Record<string, unknown> | undefined, strict = false): TextStyleFormat {
  if (!attrs) return {};
  const result: TextStyleFormat = {};
  if (attrs.fontFamily !== undefined && attrs.fontFamily !== null) {
    result.fontFamily = safeFontFamily(attrs.fontFamily);
    if (!result.fontFamily && strict) throw new AppError('INVALID_DOCUMENT_FORMATTING', 'The font family is invalid');
  }
  if (attrs.fontSizePt !== undefined && attrs.fontSizePt !== null) {
    result.fontSizePt = boundedNumber(attrs.fontSizePt, 6, 96);
    if (!result.fontSizePt && strict) throw new AppError('INVALID_DOCUMENT_FORMATTING', 'The font size must be between 6 and 96 pt');
  }
  if (attrs.color !== undefined && attrs.color !== null) {
    result.color = safeTextColor(attrs.color);
    if (!result.color && strict) throw new AppError('INVALID_DOCUMENT_FORMATTING', 'The text color must be a six-digit hexadecimal color');
  }
  return result;
}

function researchCharacterStyleName(format: TextStyleFormat): string {
  const payload = JSON.stringify({ f: format.fontFamily, s: format.fontSizePt, c: format.color });
  return `${RESEARCH_CHARACTER_STYLE_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

function decodeResearchCharacterStyleName(name: string): TextStyleFormat | undefined {
  if (!name.startsWith(RESEARCH_CHARACTER_STYLE_PREFIX) || name.length > 255) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(name.slice(RESEARCH_CHARACTER_STYLE_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    const format = textStyleFromAttributes({ fontFamily: parsed.f, fontSizePt: parsed.s, color: parsed.c });
    return Object.keys(format).length ? format : undefined;
  } catch { return undefined; }
}

const FORMATTING_HTML_ATTRIBUTES = [
  'data-ri-line-height', 'data-ri-space-before-pt', 'data-ri-space-after-pt', 'data-ri-text-align',
  'data-ri-first-line-indent-cm', 'data-ri-left-indent-cm', 'data-ri-right-indent-cm',
] as const;

function formattingHtmlAttributes(format: ParagraphFormat): string {
  const pairs: Array<[string, unknown]> = [
    ['data-ri-line-height', format.lineHeight], ['data-ri-space-before-pt', format.spaceBeforePt],
    ['data-ri-space-after-pt', format.spaceAfterPt], ['data-ri-text-align', format.textAlign],
    ['data-ri-first-line-indent-cm', format.firstLineIndentCm], ['data-ri-left-indent-cm', format.leftIndentCm],
    ['data-ri-right-indent-cm', format.rightIndentCm],
  ];
  return pairs.filter(([, value]) => value !== undefined).map(([name, value]) => ` ${name}="${String(value)}"`).join('');
}

function textStyleHtmlAttributes(format: TextStyleFormat): string {
  return [
    format.fontFamily ? ` data-ri-font-family="${format.fontFamily.replaceAll('"', '&quot;')}"` : '',
    format.fontSizePt ? ` data-ri-font-size-pt="${format.fontSizePt}"` : '',
    format.color ? ` data-ri-color="${format.color}"` : '',
  ].join('');
}

function directWordChild(parent: Element, expected: string): Element | undefined {
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const node = parent.childNodes.item(index);
    const element = node?.nodeType === 1 ? node as Element : undefined;
    if (element && WORDPROCESSINGML_NAMESPACES.has(element.namespaceURI ?? '') && localName(element) === expected.toLowerCase()) return element;
  }
  return undefined;
}

function wordAttribute(element: Element | undefined, name: string): string | undefined {
  if (!element) return undefined;
  for (const namespace of WORDPROCESSINGML_NAMESPACES) {
    const attribute = element.getAttributeNodeNS(namespace, name);
    if (attribute) return attribute.value;
  }
  return undefined;
}

function paragraphFormatFromXml(paragraph: Element): ParagraphFormat {
  const properties = directWordChild(paragraph, 'pPr');
  if (!properties) return {};
  const format: ParagraphFormat = {};
  const spacing = directWordChild(properties, 'spacing');
  const line = boundedNumber(wordAttribute(spacing, 'line'), 1, 10_000);
  if (line !== undefined) format.lineHeight = boundedNumber(line / 240, 0.8, 4);
  const before = boundedNumber(wordAttribute(spacing, 'before'), 0, 2_880);
  const after = boundedNumber(wordAttribute(spacing, 'after'), 0, 2_880);
  if (before !== undefined) format.spaceBeforePt = Math.round(before / 20 * 100) / 100;
  if (after !== undefined) format.spaceAfterPt = Math.round(after / 20 * 100) / 100;
  const justification = wordAttribute(directWordChild(properties, 'jc'), 'val')?.toLowerCase();
  if (justification === 'center') format.textAlign = 'center';
  else if (justification === 'right' || justification === 'end') format.textAlign = 'right';
  else if (justification === 'both' || justification === 'distribute') format.textAlign = 'justify';
  else if (justification === 'left' || justification === 'start') format.textAlign = 'left';
  const indentation = directWordChild(properties, 'ind');
  const firstLine = boundedNumber(wordAttribute(indentation, 'firstLine'), 0, 5_670);
  const hanging = boundedNumber(wordAttribute(indentation, 'hanging'), 0, 2_835);
  const left = boundedNumber(wordAttribute(indentation, 'left') ?? wordAttribute(indentation, 'start'), 0, 5_670);
  const right = boundedNumber(wordAttribute(indentation, 'right') ?? wordAttribute(indentation, 'end'), 0, 5_670);
  if (firstLine !== undefined) format.firstLineIndentCm = Math.round(firstLine / 567 * 100) / 100;
  else if (hanging !== undefined) format.firstLineIndentCm = -Math.round(hanging / 567 * 100) / 100;
  if (left !== undefined) format.leftIndentCm = Math.round(left / 567 * 100) / 100;
  if (right !== undefined) format.rightIndentCm = Math.round(right / 567 * 100) / 100;
  return format;
}

async function editableFormattingFromDocx(buffer: Buffer): Promise<{
  paragraphFormats: ParagraphFormat[];
  characterStyleMap: string[];
  characterFormats: Map<string, TextStyleFormat>;
}> {
  const zip = await JSZip.loadAsync(buffer);
  const document = parseXmlPart(await xmlEntry(zip, 'word/document.xml'), 'word/document.xml');
  const paragraphFormats: ParagraphFormat[] = [];
  const documentElements = document.getElementsByTagName('*');
  for (let index = 0; index < documentElements.length; index += 1) {
    const element = documentElements.item(index);
    if (element && WORDPROCESSINGML_NAMESPACES.has(element.namespaceURI ?? '') && localName(element) === 'p') paragraphFormats.push(paragraphFormatFromXml(element));
  }
  const characterStyleMap: string[] = [];
  const characterFormats = new Map<string, TextStyleFormat>();
  const stylesSource = await xmlEntry(zip, 'word/styles.xml');
  if (stylesSource) {
    const styles = parseXmlPart(stylesSource, 'word/styles.xml').getElementsByTagName('*');
    for (let index = 0; index < styles.length; index += 1) {
      const style = styles.item(index);
      if (!style || !WORDPROCESSINGML_NAMESPACES.has(style.namespaceURI ?? '') || localName(style) !== 'style' || wordAttribute(style, 'type') !== 'character') continue;
      const name = wordAttribute(directWordChild(style, 'name'), 'val');
      const format = name ? decodeResearchCharacterStyleName(name) : undefined;
      if (!name || !format) continue;
      const className = `ri-character-${characterFormats.size}`;
      characterFormats.set(className, format);
      characterStyleMap.push(`r[style-name='${name}'] => span.${className}`);
    }
  }
  return { paragraphFormats, characterStyleMap, characterFormats };
}

function annotateImportedFormatting(
  value: string,
  paragraphFormats: ParagraphFormat[],
  characterFormats: Map<string, TextStyleFormat>,
): string {
  let paragraphIndex = 0;
  const paragraphs = value.replace(/<(p|h[1-6]|li|blockquote|pre)(?=[\s>])([^>]*)>/giu, (opening, tag: string, remainder: string) => {
    const format = paragraphFormats[paragraphIndex++] ?? {};
    return `<${tag}${remainder}${formattingHtmlAttributes(format)}>`;
  });
  return paragraphs.replace(/<span class="(ri-character-\d+)">/giu, (opening, className: string) => {
    const format = characterFormats.get(className);
    return format ? `<span${textStyleHtmlAttributes(format)}>` : opening;
  });
}

function sanitizeDocumentHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup', 'mark', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img'],
    allowedAttributes: {
      p: [...FORMATTING_HTML_ATTRIBUTES],
      h1: [...FORMATTING_HTML_ATTRIBUTES], h2: [...FORMATTING_HTML_ATTRIBUTES], h3: [...FORMATTING_HTML_ATTRIBUTES],
      h4: [...FORMATTING_HTML_ATTRIBUTES], h5: [...FORMATTING_HTML_ATTRIBUTES], h6: [...FORMATTING_HTML_ATTRIBUTES],
      li: [...FORMATTING_HTML_ATTRIBUTES], blockquote: [...FORMATTING_HTML_ATTRIBUTES], pre: [...FORMATTING_HTML_ATTRIBUTES],
      span: ['data-ri-font-family', 'data-ri-font-size-pt', 'data-ri-color'],
      a: ['href', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    exclusiveFilter: (frame) => frame.tag === 'img' && !validImageDataUri(frame.attribs.src ?? ''),
  });
}

async function importDocx(buffer: Buffer): Promise<{ html: string; messages: DocxCompatibilityWarning[] }> {
  const imageMessages: DocxCompatibilityWarning[] = [];
  const formatting = await editableFormattingFromDocx(buffer);
  const supportedImages = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp']);
  let importedImageBytes = 0;
  const result = await mammoth.convertToHtml({ buffer }, {
    includeEmbeddedStyleMap: false,
    styleMap: ['u => u', 'highlight => mark', ...formatting.characterStyleMap],
    convertImage: mammoth.images.imgElement(async (image) => {
      const contentType = image.contentType.toLowerCase();
      if (!supportedImages.has(contentType)) {
        imageMessages.push(warning('unsupported-image', 'An image was omitted', `${contentType || 'Unknown image type'} is not supported. Use PNG, JPEG, GIF, or BMP.`, 'warning'));
        return { src: '' };
      }
      const data = await image.readAsBuffer();
      if (data.byteLength > MAX_IMAGE_BYTES) {
        imageMessages.push(warning('oversize-image', 'A large image was omitted', 'An embedded image exceeds the 10 MB per-image safety limit.', 'warning'));
        return { src: '' };
      }
      importedImageBytes += data.byteLength;
      if (importedImageBytes > MAX_IMPORTED_IMAGE_BYTES) throw new AppError('DOCX_IMAGES_TOO_LARGE', 'Embedded images exceed the 32 MB import safety limit');
      const normalizedType = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
      return { src: `data:${normalizedType};base64,${data.toString('base64')}` };
    }),
  });
  const messages = result.messages.slice(0, 20).map((message, index) => warning(
    `mammoth-${index}`,
    message.type === 'error' ? 'DOCX conversion issue' : 'DOCX compatibility note',
    message.message.slice(0, 1_000),
    'warning',
  ));
  const annotated = annotateImportedFormatting(result.value, formatting.paragraphFormats, formatting.characterFormats);
  if (Buffer.byteLength(annotated, 'utf8') > MAX_IMPORTED_HTML_BYTES) throw new AppError('DOCX_CONTENT_TOO_LARGE', 'Converted DOCX content exceeds the 80 MB editor safety limit');
  const html = sanitizeDocumentHtml(annotated);
  if (Buffer.byteLength(html, 'utf8') > MAX_IMPORTED_HTML_BYTES) throw new AppError('DOCX_CONTENT_TOO_LARGE', 'Sanitized DOCX content exceeds the 80 MB editor safety limit');
  if (!html.trim()) throw new AppError('EMPTY_DOCX', 'No editable document content could be extracted from this DOCX');
  return { html, messages: [...imageMessages, ...messages] };
}

function safeLink(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 8_192) return undefined;
  try {
    const value = new URL(raw);
    if (!['http:', 'https:', 'mailto:'].includes(value.protocol)) return undefined;
    if (value.username || value.password) return undefined;
    return value.toString();
  } catch { return undefined; }
}

function validateDocument(content: Record<string, unknown>): ProseMirrorNode {
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > MAX_DOCUMENT_JSON_BYTES) throw new AppError('DOCUMENT_TOO_LARGE', 'The editable document envelope is larger than 80 MB');
  const allowedNodes = new Set(['doc', 'paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'listItem', 'horizontalRule', 'hardBreak', 'text', 'table', 'tableRow', 'tableCell', 'tableHeader', 'image']);
  const allowedMarks = new Set(['bold', 'italic', 'strike', 'underline', 'subscript', 'superscript', 'highlight', 'code', 'link', 'textStyle']);
  let nodes = 0;
  let textBytes = 0;
  let imageBytes = 0;
  const visit = (value: unknown, depth: number): ProseMirrorNode => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_DOCUMENT', 'The DOCX editor content is not a valid document tree');
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new AppError('DOCUMENT_TOO_COMPLEX', 'The document tree exceeds the safety limit');
    const input = value as Record<string, unknown>;
    if (typeof input.type !== 'string' || !allowedNodes.has(input.type)) throw new AppError('UNSUPPORTED_DOCUMENT_NODE', `Cannot save unsupported document element: ${String(input.type)}`);
    const result: ProseMirrorNode = { type: input.type };
    if (input.attrs !== undefined && (!input.attrs || typeof input.attrs !== 'object' || Array.isArray(input.attrs))) throw new AppError('INVALID_DOCUMENT', 'A document element has invalid attributes');
    const rawAttributes = input.attrs as Record<string, unknown> | undefined;
    if (['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem'].includes(input.type)) {
      result.attrs = { ...paragraphFormatFromAttributes(rawAttributes, true) };
      if (input.type === 'heading') {
        const level = boundedNumber(rawAttributes?.level, 1, 6);
        if (!level || !Number.isInteger(level)) throw new AppError('INVALID_DOCUMENT_FORMATTING', 'A heading level must be between 1 and 6');
        result.attrs.level = level;
      }
    } else if (input.type === 'image') {
      result.attrs = {
        src: rawAttributes?.src,
        alt: typeof rawAttributes?.alt === 'string' ? rawAttributes.alt.slice(0, 255) : undefined,
        title: typeof rawAttributes?.title === 'string' ? rawAttributes.title.slice(0, 255) : undefined,
        width: boundedNumber(rawAttributes?.width, 1, 624),
        height: boundedNumber(rawAttributes?.height, 1, 900),
      };
    } else if (input.type === 'tableCell' || input.type === 'tableHeader') {
      const colspan = boundedNumber(rawAttributes?.colspan, 1, 50) ?? 1;
      const rowspan = boundedNumber(rawAttributes?.rowspan, 1, 50) ?? 1;
      if (!Number.isInteger(colspan) || !Number.isInteger(rowspan)) throw new AppError('INVALID_DOCUMENT_FORMATTING', 'Table spans must be whole numbers between 1 and 50');
      result.attrs = {
        colspan,
        rowspan,
      };
    }
    if (input.type === 'text') {
      if (typeof input.text !== 'string') throw new AppError('INVALID_DOCUMENT', 'A text element has invalid content');
      textBytes += Buffer.byteLength(input.text, 'utf8');
      if (textBytes > MAX_TEXT_BYTES) throw new AppError('DOCUMENT_TOO_LARGE', 'Document text exceeds the 20 MB safety limit');
      result.text = input.text;
    }
    if (input.marks !== undefined) {
      if (!Array.isArray(input.marks) || input.marks.length > 16) throw new AppError('INVALID_DOCUMENT', 'A text mark list is invalid');
      result.marks = input.marks.map((mark) => {
        if (!mark || typeof mark !== 'object' || Array.isArray(mark) || typeof (mark as { type?: unknown }).type !== 'string') throw new AppError('INVALID_DOCUMENT', 'A text mark is invalid');
        const typed = mark as ProseMirrorMark;
        if (!allowedMarks.has(typed.type)) throw new AppError('UNSUPPORTED_DOCUMENT_MARK', `Cannot save unsupported text formatting: ${typed.type}`);
        if (typed.attrs !== undefined && (!typed.attrs || typeof typed.attrs !== 'object' || Array.isArray(typed.attrs))) throw new AppError('INVALID_DOCUMENT', 'A text mark has invalid attributes');
        if (typed.type === 'link') {
          const href = safeLink(typed.attrs?.href);
          if (!href) throw new AppError('UNSAFE_DOCUMENT_LINK', 'The document contains an unsafe or invalid hyperlink');
          return { type: typed.type, attrs: { href } };
        }
        if (typed.type === 'textStyle') {
          const attrs = textStyleFromAttributes(typed.attrs, true);
          return { type: typed.type, attrs: Object.keys(attrs).length ? { ...attrs } : undefined };
        }
        return { type: typed.type };
      });
    }
    if (input.content !== undefined) {
      if (!Array.isArray(input.content)) throw new AppError('INVALID_DOCUMENT', 'A document element has invalid children');
      result.content = input.content.map((child) => visit(child, depth + 1));
    }
    if (input.type === 'image') {
      const source = result.attrs?.src;
      if (typeof source !== 'string' || !validImageDataUri(source)) throw new AppError('UNSAFE_DOCUMENT_IMAGE', 'Images must be embedded PNG, JPEG, GIF, or BMP data');
      const encoded = source.slice(source.indexOf(',') + 1).replace(/\s/gu, '');
      const size = Buffer.from(encoded, 'base64').byteLength;
      if (size > MAX_IMAGE_BYTES) throw new AppError('IMAGE_TOO_LARGE', 'An image exceeds the 10 MB safety limit');
      imageBytes += size;
      if (imageBytes > MAX_TOTAL_IMAGE_BYTES) throw new AppError('IMAGES_TOO_LARGE', 'Embedded images exceed the 32 MB document safety limit');
    }
    return result;
  };
  const root = visit(content, 0);
  if (root.type !== 'doc') throw new AppError('INVALID_DOCUMENT', 'The document root must be a ProseMirror doc node');
  return root;
}

function imageDimensions(data: Buffer, type: DecodedImage['type']): { width: number; height: number } {
  if (type === 'png' && data.length >= 24 && data.subarray(1, 4).toString('ascii') === 'PNG') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if ((type === 'gif' || type === 'bmp') && data.length >= 10) {
    if (type === 'gif') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (data.length >= 26) return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  }
  if (type === 'jpg') {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return { width: 600, height: 400 };
}

function imageSignatureMatches(data: Buffer, type: DecodedImage['type']): boolean {
  if (type === 'png') return data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'jpg') return data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (type === 'gif') return data.length >= 10 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'));
  return data.length >= 26 && data.subarray(0, 2).toString('ascii') === 'BM';
}

function decodeImage(node: ProseMirrorNode): DecodedImage {
  const source = String(node.attrs?.src ?? '');
  const match = /^data:image\/(png|jpeg|jpg|gif|bmp);base64,(.+)$/isu.exec(source);
  if (!match) throw new AppError('UNSAFE_DOCUMENT_IMAGE', 'An image has an unsupported encoding');
  const type = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase() as DecodedImage['type'];
  const data = Buffer.from(match[2].replace(/\s/gu, ''), 'base64');
  if (!imageSignatureMatches(data, type)) throw new AppError('INVALID_DOCUMENT_IMAGE', 'An embedded image does not match its declared image type');
  const intrinsic = imageDimensions(data, type);
  const requestedWidth = Number(node.attrs?.width);
  const requestedHeight = Number(node.attrs?.height);
  const width = Number.isFinite(requestedWidth) && requestedWidth > 0 ? Math.min(requestedWidth, 624) : Math.min(Math.max(intrinsic.width, 1), 624);
  const ratio = intrinsic.width > 0 && intrinsic.height > 0 ? intrinsic.height / intrinsic.width : 2 / 3;
  const height = Number.isFinite(requestedHeight) && requestedHeight > 0 ? Math.min(requestedHeight, 900) : Math.max(1, Math.round(width * ratio));
  return { data, type, width: Math.round(width), height: Math.round(height), alt: typeof node.attrs?.alt === 'string' ? node.attrs.alt.slice(0, 255) : 'Document image' };
}

function characterStyleForMarks(marks: ProseMirrorMark[], forceCode: boolean, context: DocumentConversionContext): { id?: string; format: TextStyleFormat } {
  const textStyle = marks.find((mark) => mark.type === 'textStyle');
  const format = textStyleFromAttributes(textStyle?.attrs);
  if (forceCode || marks.some((mark) => mark.type === 'code')) format.fontFamily = 'Courier New';
  if (!Object.keys(format).length) return { format };
  const name = researchCharacterStyleName(format);
  if (!context.characterStyles.has(name)) {
    context.characterStyles.set(name, {
      format,
      definition: {
        id: name,
        name,
        run: {
          font: format.fontFamily,
          size: format.fontSizePt ? Math.round(format.fontSizePt * 2) : undefined,
          color: format.color?.slice(1),
        },
      },
    });
  }
  return { id: name, format };
}

function inlineChildren(nodes: ProseMirrorNode[] = [], forceCode = false, context: DocumentConversionContext): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const node of nodes) {
    if (node.type === 'hardBreak') { children.push(new TextRun({ break: 1 })); continue; }
    if (node.type === 'image') {
      const image = decodeImage(node);
      children.push(new ImageRun({ type: image.type, data: image.data, transformation: { width: image.width, height: image.height }, altText: { title: image.alt, description: image.alt, name: image.alt } }));
      continue;
    }
    if (node.type !== 'text') continue;
    const marks = node.marks ?? [];
    const markTypes = new Set(marks.map((mark) => mark.type));
    const characterStyle = characterStyleForMarks(marks, forceCode, context);
    const run = new TextRun({
      text: node.text ?? '',
      style: characterStyle.id,
      bold: markTypes.has('bold'),
      italics: markTypes.has('italic'),
      strike: markTypes.has('strike'),
      underline: markTypes.has('underline') ? { type: UnderlineType.SINGLE } : undefined,
      subScript: markTypes.has('subscript'),
      superScript: markTypes.has('superscript'),
      highlight: markTypes.has('highlight') ? HighlightColor.YELLOW : undefined,
      font: characterStyle.format.fontFamily,
      size: characterStyle.format.fontSizePt ? Math.round(characterStyle.format.fontSizePt * 2) : undefined,
      color: characterStyle.format.color?.slice(1),
    });
    const link = marks.find((mark) => mark.type === 'link');
    const href = safeLink(link?.attrs?.href);
    children.push(href ? new ExternalHyperlink({ children: [run], link: href }) : run);
  }
  return children;
}

function headingLevel(raw: unknown): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (Number(raw)) {
    case 1: return HeadingLevel.HEADING_1;
    case 2: return HeadingLevel.HEADING_2;
    case 3: return HeadingLevel.HEADING_3;
    case 4: return HeadingLevel.HEADING_4;
    case 5: return HeadingLevel.HEADING_5;
    default: return HeadingLevel.HEADING_6;
  }
}

function flattenInlineContent(nodes: ProseMirrorNode[] = []): ProseMirrorNode[] {
  const result: ProseMirrorNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'hardBreak' || node.type === 'image') result.push(node);
    else if (node.content?.length) {
      if (result.length && result.at(-1)?.type !== 'hardBreak') result.push({ type: 'hardBreak' });
      result.push(...flattenInlineContent(node.content));
    }
  }
  return result;
}

function paragraphAlignment(value: ParagraphFormat['textAlign']): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (value === 'center') return AlignmentType.CENTER;
  if (value === 'right') return AlignmentType.RIGHT;
  if (value === 'justify') return AlignmentType.JUSTIFIED;
  return AlignmentType.LEFT;
}

function centimetresToTwips(value: number): number {
  return Math.round(value * 567);
}

function paragraphFromNode(node: ProseMirrorNode, context: DocumentConversionContext, list?: { type: 'bullet' | 'ordered'; level: number; instance: number }): Paragraph {
  const format = paragraphFormatFromAttributes(node.attrs);
  const firstLine = format.firstLineIndentCm ?? 0;
  const leftIndent = centimetresToTwips(format.leftIndentCm ?? 0) + (node.type === 'blockquote' ? 720 : 0);
  const rightIndent = centimetresToTwips(format.rightIndentCm ?? 0);
  const common = {
    children: inlineChildren(node.type === 'blockquote' ? flattenInlineContent(node.content) : node.content, node.type === 'codeBlock', context),
    alignment: paragraphAlignment(format.textAlign),
    spacing: {
      before: Math.round((format.spaceBeforePt ?? 0) * 20),
      after: Math.round((format.spaceAfterPt ?? (node.type === 'heading' ? 8 : 5)) * 20),
      line: Math.round((format.lineHeight ?? 1.15) * 240),
      lineRule: LineRuleType.AUTO,
    },
    indent: {
      left: leftIndent,
      right: rightIndent,
      firstLine: firstLine > 0 ? centimetresToTwips(firstLine) : undefined,
      hanging: firstLine < 0 ? centimetresToTwips(Math.abs(firstLine)) : undefined,
    },
  };
  if (node.type === 'heading') return new Paragraph({ ...common, heading: headingLevel(node.attrs?.level) });
  if (list?.type === 'bullet') return new Paragraph({ ...common, bullet: { level: Math.min(list.level, 8) } });
  if (list?.type === 'ordered') return new Paragraph({ ...common, numbering: { reference: 'research-ordered-list', level: Math.min(list.level, 8), instance: list.instance } });
  return new Paragraph(common);
}

function tableFromNode(node: ProseMirrorNode, context: DocumentConversionContext): Table {
  const rows = (node.content ?? []).filter((row) => row.type === 'tableRow').map((row, rowIndex) => new TableRow({
    tableHeader: rowIndex === 0 && (row.content ?? []).some((cell) => cell.type === 'tableHeader'),
    children: (row.content ?? []).filter((cell) => cell.type === 'tableCell' || cell.type === 'tableHeader').map((cell) => {
      const children = blocksFromNodes(cell.content ?? [], context);
      return new TableCell({
        children: children.length ? children.filter((child): child is Paragraph | Table => child instanceof Paragraph || child instanceof Table) : [new Paragraph('')],
        columnSpan: Math.max(1, Math.min(Number(cell.attrs?.colspan) || 1, 50)),
        rowSpan: Math.max(1, Math.min(Number(cell.attrs?.rowspan) || 1, 50)),
        shading: cell.type === 'tableHeader' ? { fill: 'E8EDF3' } : undefined,
      });
    }),
  }));
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, alignment: AlignmentType.CENTER });
}

function blocksFromNodes(nodes: ProseMirrorNode[], context: DocumentConversionContext, list?: { type: 'bullet' | 'ordered'; level: number; instance: number }): FileChild[] {
  const result: FileChild[] = [];
  for (const node of nodes) {
    if (['paragraph', 'heading', 'blockquote', 'codeBlock'].includes(node.type)) result.push(paragraphFromNode(node, context, list));
    else if (node.type === 'horizontalRule') result.push(new Paragraph({ text: '────────────────────────────────', alignment: AlignmentType.CENTER }));
    else if (node.type === 'image') result.push(new Paragraph({ children: inlineChildren([node], false, context), alignment: AlignmentType.CENTER }));
    else if (node.type === 'table') result.push(tableFromNode(node, context));
    else if (node.type === 'bulletList' || node.type === 'orderedList') {
      const type = node.type === 'bulletList' ? 'bullet' : 'ordered';
      const instance = ++context.listInstance;
      for (const item of node.content ?? []) {
        if (item.type !== 'listItem') continue;
        for (const child of item.content ?? []) {
          if (child.type === 'bulletList' || child.type === 'orderedList') result.push(...blocksFromNodes([child], context, { type: child.type === 'bulletList' ? 'bullet' : 'ordered', level: (list?.level ?? 0) + 1, instance }));
          else {
            const formattedChild = ['paragraph', 'heading', 'blockquote', 'codeBlock'].includes(child.type) && item.attrs
              ? { ...child, attrs: { ...item.attrs, ...child.attrs } }
              : child;
            result.push(...blocksFromNodes([formattedChild], context, { type, level: list?.level ?? 0, instance }));
          }
        }
      }
    }
  }
  return result;
}

/**
 * Opens an in-memory DOCX through the same package checks, relationship
 * sanitization and HTML allow-list as the project-file workflow.  Legacy DOC
 * conversion uses this boundary so a converter result never bypasses the DOCX
 * security model.
 */
export async function openDocxBuffer(buffer: Buffer): Promise<Pick<DocxOpenResult, 'content' | 'warnings' | 'readOnly'>> {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength > MAX_DOCX_BYTES) {
    throw new AppError('FILE_TOO_LARGE', 'DOCX conversion output larger than 100 MB cannot be edited');
  }
  const analysis = await analyzePackage(buffer);
  let imported: Awaited<ReturnType<typeof importDocx>>;
  try { imported = await importDocx(analysis.conversionBuffer); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('DOCX_CONVERSION_FAILED', `The DOCX could not be converted: ${error instanceof Error ? error.message : 'unknown conversion error'}`);
  }
  return {
    content: imported.html,
    warnings: [...analysis.warnings, ...imported.messages],
    readOnly: analysis.readOnly,
  };
}

export async function createDocxBuffer(content: Record<string, unknown>): Promise<Buffer> {
  const root = validateDocument(content);
  const levels = Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 + level * 360, hanging: 260 } } },
  }));
  const context: DocumentConversionContext = { listInstance: 0, characterStyles: new Map() };
  const children = blocksFromNodes(root.content ?? [], context);
  const document = new DocxDocument({
    creator: 'Research IDE',
    title: 'Research document',
    styles: context.characterStyles.size ? { characterStyles: [...context.characterStyles.values()].map((entry) => entry.definition) } : undefined,
    numbering: { config: [{ reference: 'research-ordered-list', levels }] },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: children.length ? children : [new Paragraph('')],
    }],
  });
  const buffer = await Packer.toBuffer(document);
  inspectZipEnvelope(buffer);
  return buffer;
}

export class DocxService {
  private readonly observed = new Map<string, ObservedDocx>();

  constructor(
    private readonly projects: ProjectService,
    private readonly snapshots: SnapshotService,
  ) {}

  async open(relativePath: string): Promise<DocxOpenResult> {
    const { key, target } = await this.resolveExistingDocx(relativePath);
    const info = await stat(target);
    if (!info.isFile()) throw new AppError('NOT_A_FILE', 'The DOCX path is not a file');
    if (info.size > MAX_DOCX_BYTES) throw new AppError('FILE_TOO_LARGE', 'DOCX files larger than 100 MB cannot be edited');
    const buffer = await readFile(target);
    const imported = await openDocxBuffer(buffer);
    const warnings = imported.warnings;
    const sourceHash = sha256(buffer);
    this.observed.set(key, { hash: sourceHash, warnings, readOnly: imported.readOnly });
    return { content: imported.content, sourceHash, warnings, readOnly: imported.readOnly };
  }

  async save(request: DocxSaveRequest): Promise<DocxSaveResult> {
    if (!request || typeof request !== 'object' || typeof request.path !== 'string' || typeof request.expectedSourceHash !== 'string' || typeof request.acknowledgeCompatibilityWarnings !== 'boolean' || !request.content || typeof request.content !== 'object' || Array.isArray(request.content)) throw new AppError('INVALID_DOCX_SAVE', 'DOCX save details are invalid');
    if (!/^[a-f0-9]{64}$/iu.test(request.expectedSourceHash)) throw new AppError('INVALID_DOCX_SAVE', 'The expected DOCX checksum is invalid');
    const { key, normalized, target } = await this.resolveExistingDocx(request.path);
    const observed = this.observed.get(key);
    if (!observed || observed.hash !== request.expectedSourceHash) throw new AppError('DOCX_RELOAD_REQUIRED', 'Reload the DOCX before saving it');
    if (observed.readOnly || observed.warnings.some((item) => item.severity === 'blocking')) throw new AppError('DOCX_READ_ONLY', 'This DOCX contains features that Research IDE cannot preserve safely and is read-only');
    if (observed.warnings.some((item) => item.requiresAcknowledgement) && !request.acknowledgeCompatibilityWarnings) throw new AppError('DOCX_CONFIRM_COMPATIBILITY', 'Review and acknowledge the DOCX compatibility warning before saving');
    const replacement = await createDocxBuffer(request.content);
    // Validate the complete generated package before touching the source file.
    const replacementAnalysis = await analyzePackage(replacement);
    try { await importDocx(replacementAnalysis.conversionBuffer); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('DOCX_GENERATION_FAILED', 'The generated DOCX failed a round-trip validation');
    }
    const current = await readFile(target);
    if (sha256(current) !== observed.hash) throw new AppError('FILE_CHANGED_ON_DISK', `${normalized} changed outside Research IDE; reload before saving`);
    const snapshot = await this.snapshots.create([normalized], `DOCX before save · ${path.basename(normalized)}`);
    const temporary = `${target}.research-ide-${randomUUID()}.tmp`;
    let committed = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(replacement);
        await flushFileHandle(handle);
      } finally {
        await handle.close();
      }
      const latest = await readFile(target);
      if (sha256(latest) !== observed.hash) throw new AppError('FILE_CHANGED_ON_DISK', `${normalized} changed outside Research IDE while it was being saved; reload before saving`);
      await rename(temporary, target);
      committed = true;
      await syncParentDirectory(target);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (committed) throw new AppError('DOCX_SAVE_DURABILITY_FAILED', `The DOCX was replaced, but its directory could not be synchronized; reload it before continuing: ${error instanceof Error ? error.message : 'unknown file error'}`);
      throw new AppError('DOCX_SAVE_FAILED', `The DOCX was not changed because the replacement could not be committed: ${error instanceof Error ? error.message : 'unknown file error'}`);
    } finally {
      await rm(temporary, { force: true });
    }
    const sourceHash = sha256(replacement);
    this.observed.set(key, { hash: sourceHash, warnings: [warning('round-trip-layout', 'Word layout may be simplified', 'This file uses the Research IDE DOCX editable subset.', 'info')], readOnly: false });
    return { sourceHash, backupId: snapshot.id };
  }

  private async resolveExistingDocx(relativePath: string): Promise<{ key: string; normalized: string; target: string }> {
    if (path.extname(relativePath).toLowerCase() !== '.docx') throw new AppError('INVALID_DOCX_PATH', 'Only .docx files can use the DOCX editor');
    const lexical = this.projects.guard.lexical(relativePath);
    const normalized = this.projects.guard.relative(lexical);
    const target = await this.projects.guard.existing(normalized);
    const root = this.projects.current?.path;
    if (!root) throw new AppError('NO_PROJECT', 'Open a project first');
    return { key: `${root}\0${normalized}`, normalized, target };
  }
}

export const docxInternals = {
  inspectZipEnvelope,
  analyzePackage,
  sanitizeDocumentHtml,
  validateDocument,
  createDocxBuffer,
  limits: Object.freeze({
    maxDocumentJsonBytes: MAX_DOCUMENT_JSON_BYTES,
    maxTextBytes: MAX_TEXT_BYTES,
    maxImageBytes: MAX_IMAGE_BYTES,
    maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES,
    maxImportedImageBytes: MAX_IMPORTED_IMAGE_BYTES,
    maxImportedHtmlBytes: MAX_IMPORTED_HTML_BYTES,
  }),
};
