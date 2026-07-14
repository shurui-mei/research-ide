import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocxBuffer, DocxService, docxInternals } from './docx-service';
import { ProjectService } from './project-service';
import { SnapshotService } from './snapshot-service';

const temporaryRoots: string[] = [];
const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function projectWithPaper(): Promise<{ root: string; projects: ProjectService; snapshots: SnapshotService; docx: DocxService }> {
  const base = await mkdtemp(path.join(tmpdir(), 'research-ide-docx-'));
  temporaryRoots.push(base);
  const parent = path.join(base, 'projects');
  await mkdir(parent);
  const projects = new ProjectService(path.join(base, 'user-data'), () => undefined);
  const summary = await projects.create({ name: 'paper', parentPath: parent, template: 'paper', initializeGit: false });
  const snapshots = new SnapshotService(projects);
  return { root: summary.path, projects, snapshots, docx: new DocxService(projects, snapshots) };
}

afterEach(async () => {
  for (const base of temporaryRoots.splice(0)) await rm(base, { recursive: true, force: true });
});

describe('DOCX conversion safety', () => {
  it('sanitizes active content, unsafe links, and non-embedded images', () => {
    const clean = docxInternals.sanitizeDocumentHtml('<p onclick="steal()">Safe<script>alert(1)</script><a href="javascript:alert(1)">link</a><img src="https://example.test/a.png"><img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="></p>');

    expect(clean).toContain('<p>Safe');
    expect(clean).toContain('<a>link</a>');
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('<img');
    expect(clean).not.toContain('javascript:');
  });

  it('rejects malformed packages and unsafe rich-text payloads before writing', async () => {
    expect(() => docxInternals.inspectZipEnvelope(Buffer.from('not-a-docx'))).toThrow(/valid DOCX/u);
    await expect(createDocxBuffer({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }],
    })).rejects.toMatchObject({ code: 'UNSAFE_DOCUMENT_LINK' });
    await expect(createDocxBuffer({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { lineHeight: 99 }, content: [{ type: 'text', text: 'invalid spacing' }] }],
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_FORMATTING' });
    await expect(createDocxBuffer({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'invalid font', marks: [{ type: 'textStyle', attrs: { fontFamily: 'serif; color: red' } }] }] }],
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_FORMATTING' });
  });

  it('never reads a linked local image even when its relationship is prefixed, lacks TargetMode, and disguises its type', async () => {
    const { root, projects, docx } = await projectWithPaper();
    const sentinel = Buffer.concat([Buffer.from(ONE_PIXEL_PNG.split(',')[1], 'base64'), Buffer.from('LOCAL-SENTINEL-DO-NOT-READ')]);
    const sentinelPath = path.join(path.dirname(root), 'local-sentinel.png');
    await writeFile(sentinelPath, sentinel);
    const source = await createDocxBuffer({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Safe text' }] }, { type: 'image', attrs: { src: ONE_PIXEL_PNG, alt: 'linked plot' } }] });
    const zip = await JSZip.loadAsync(source);
    const relationshipPath = 'word/_rels/document.xml.rels';
    const documentXml = await zip.file('word/document.xml')!.async('string');
    const imageId = /r:embed="([^"]+)"/u.exec(documentXml)?.[1];
    expect(imageId).toBeTruthy();
    const decoyNamespace = 'urn:research-ide:relationship-decoy';
    zip.file('word/document.xml', documentXml
      .replace(`r:embed="${imageId}"`, `xmlns:decoy="${decoyNamespace}" decoy:link="safeDecoy" r:link="${imageId}"`)
      .replace('</w:body>', `<w:p><w:r xmlns:decoy="${decoyNamespace}" decoy:value="${imageId}"><w:t>Unrelated survives</w:t></w:r></w:p></w:body>`));
    const relationships = await zip.file(relationshipPath)!.async('string');
    const imageRelationship = new RegExp(`<Relationship\\b(?=[^>]*\\bId="${imageId}")(?=[^>]*\\bType="[^"]*/image")[^>]*/>`, 'u');
    expect(imageRelationship.test(relationships)).toBe(true);
    const safeMediaTarget = Object.keys(zip.files).find((name) => name.startsWith('word/media/'))!.slice('word/'.length);
    const maliciousRelationship = `<rel:Relationship xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:decoy="${decoyNamespace}" decoy:Id="safeDecoy" decoy:Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" decoy:Target="${safeMediaTarget}" Id="${imageId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${pathToFileURL(sentinelPath).toString()}"/>`;
    zip.file(relationshipPath, relationships.replace(imageRelationship, maliciousRelationship).replace('</Relationships>', '<Relationship Id="safeLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>'));
    const extraRelationship = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><rel:Relationship xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships" Id="linkedImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${pathToFileURL(sentinelPath).toString()}"/></Relationships>`;
    for (const part of ['footnotes', 'endnotes', 'header1']) {
      zip.file(`word/${part}.xml`, `<?xml version="1.0"?><w:${part} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
      zip.file(`word/_rels/${part}.xml.rels`, extraRelationship);
    }

    const malicious = await zip.generateAsync({ type: 'nodebuffer' });
    const analysis = await docxInternals.analyzePackage(malicious);
    const conversionZip = await JSZip.loadAsync(analysis.conversionBuffer);
    const safeRelationships = await conversionZip.file(relationshipPath)!.async('string');

    expect(analysis.warnings).toContainEqual(expect.objectContaining({ code: 'external-media' }));
    expect(safeRelationships).not.toContain('local-sentinel.png');
    expect(safeRelationships).toContain('https://example.com');
    for (const part of ['footnotes', 'endnotes', 'header1']) {
      expect(await conversionZip.file(`word/_rels/${part}.xml.rels`)!.async('string')).not.toContain('local-sentinel.png');
    }
    expect(await conversionZip.file('word/document.xml')!.async('string')).not.toContain(`r:link="${imageId}"`);
    expect(await conversionZip.file('word/document.xml')!.async('string')).toContain('Unrelated survives');

    await writeFile(path.join(root, 'paper.docx'), malicious);
    const opened = await docx.open('paper.docx');
    expect(opened.content).toContain('Safe text');
    expect(opened.content).toContain('Unrelated survives');
    expect(opened.content).not.toContain(sentinel.toString('base64'));
    await projects.close();
  });

  it('detects high-risk and lossy Word features by namespace instead of a conventional prefix', async () => {
    const source = await createDocxBuffer({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Namespace test' }] }] });
    const zip = await JSZip.loadAsync(source);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    const transitionalWord = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const strictWord = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
    const strictMath = 'http://purl.oclc.org/ooxml/officeDocument/math';
    const injected = [
      `<alternate:altChunk xmlns:alternate="${strictWord}"/>`,
      `<revision:ins xmlns:revision="${transitionalWord}"/>`,
      `<formula:oMath xmlns:formula="${strictMath}"/>`,
      `<drawing:txbxContent xmlns:drawing="${transitionalWord}"/>`,
      `<field:fldSimple xmlns:field="${strictWord}"/>`,
      `<control:sdt xmlns:control="${transitionalWord}"/>`,
      '<decoy:altChunk xmlns:decoy="urn:research-ide:not-wordprocessingml"/>',
    ].join('');
    zip.file('word/document.xml', documentXml.replace('</w:body>', `${injected}</w:body>`));

    const analysis = await docxInternals.analyzePackage(await zip.generateAsync({ type: 'nodebuffer' }));
    const codes = new Set(analysis.warnings.map((item) => item.code));

    expect(analysis.readOnly).toBe(true);
    for (const code of ['alternate-content', 'tracked-changes', 'equations', 'text-boxes', 'fields', 'content-controls']) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it('keeps save and reopen budgets symmetric after base64 expansion', () => {
    const limits = docxInternals.limits;
    const expandedImageBudget = Math.ceil(limits.maxTotalImageBytes / 3) * 4;

    expect(limits.maxImportedImageBytes).toBe(limits.maxTotalImageBytes);
    expect(limits.maxDocumentJsonBytes).toBeGreaterThan(expandedImageBudget + limits.maxTextBytes);
    expect(limits.maxImportedHtmlBytes).toBeGreaterThan(expandedImageBudget + limits.maxTextBytes);

    const image = Buffer.alloc(4 * 1024 * 1024);
    Buffer.from(ONE_PIXEL_PNG.split(',')[1], 'base64').copy(image);
    const source = `data:image/png;base64,${image.toString('base64')}`;
    const imageHeavyDocument = {
      type: 'doc',
      content: Array.from({ length: 4 }, () => ({ type: 'image', attrs: { src: source, alt: 'budget image' } })),
    };
    expect(Buffer.byteLength(JSON.stringify(imageHeavyDocument), 'utf8')).toBeGreaterThan(20 * 1024 * 1024);
    expect(() => docxInternals.validateDocument(imageHeavyDocument)).not.toThrow();

    const textHeavyDocument = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(limits.maxTextBytes + 1) }] }] };
    expect(() => docxInternals.validateDocument(textHeavyDocument)).toThrow(/text exceeds the 20 MB/u);
  });
});

describe('native DOCX workflow', () => {
  it('opens, saves to the same DOCX, creates a restorable backup, and reopens', async () => {
    const { root, projects, snapshots, docx } = await projectWithPaper();
    const original = await readFile(path.join(root, 'paper.docx'));
    const opened = await docx.open('paper.docx');
    const content = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Results' }] },
        {
          type: 'paragraph',
          attrs: { lineHeight: 1.5, spaceBeforePt: 6, spaceAfterPt: 12, textAlign: 'justify', firstLineIndentCm: 1.27, leftIndentCm: 1.27, rightIndentCm: 0.64 },
          content: [
            { type: 'text', text: 'Styled results ', marks: [{ type: 'textStyle', attrs: { fontFamily: 'Times New Roman', fontSizePt: 12, color: '#123456' } }] },
            { type: 'text', text: 'Read the source', marks: [{ type: 'link', attrs: { href: 'https://example.com/paper' } }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '2', marks: [{ type: 'subscript' }] }, { type: 'text', text: 'n', marks: [{ type: 'superscript' }] }, { type: 'text', text: 'significant', marks: [{ type: 'highlight' }] }] },
        { type: 'image', attrs: { src: ONE_PIXEL_PNG, alt: 'Result plot', width: 240, height: 160 } },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Replicate the experiment' }] }] }] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Metric' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Accuracy' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '98%' }] }] }] }] },
      ],
    };

    const saved = await docx.save({ path: 'paper.docx', content, expectedSourceHash: opened.sourceHash, acknowledgeCompatibilityWarnings: true });
    const rawText = await mammoth.extractRawText({ buffer: await readFile(path.join(root, 'paper.docx')) });

    expect(rawText.value).toContain('Results');
    expect(rawText.value).toContain('Accuracy');
    const savedPackage = await JSZip.loadAsync(await readFile(path.join(root, 'paper.docx')));
    expect(Object.keys(savedPackage.files).some((name) => name.startsWith('word/media/'))).toBe(true);
    const savedDocumentXml = await savedPackage.file('word/document.xml')!.async('string');
    expect(savedDocumentXml).toContain('<w:vertAlign w:val="subscript"/>');
    expect(savedDocumentXml).toContain('<w:vertAlign w:val="superscript"/>');
    expect(savedDocumentXml).toContain('<w:highlight w:val="yellow"/>');
    expect(savedDocumentXml).toMatch(/<w:spacing\b(?=[^>]*w:before="120")(?=[^>]*w:after="240")(?=[^>]*w:line="360")(?=[^>]*w:lineRule="auto")[^>]*\/>/u);
    expect(savedDocumentXml).toContain('<w:jc w:val="both"/>');
    expect(savedDocumentXml).toMatch(/<w:ind\b(?=[^>]*w:left="720")(?=[^>]*w:right="363")(?=[^>]*w:firstLine="720")[^>]*\/>/u);
    expect(savedDocumentXml).toContain('<w:rFonts w:ascii="Times New Roman"');
    expect(savedDocumentXml).toContain('<w:sz w:val="24"/>');
    expect(savedDocumentXml).toContain('<w:color w:val="123456"/>');
    expect(saved.sourceHash).not.toBe(opened.sourceHash);
    expect(snapshots.list()).toContainEqual(expect.objectContaining({ id: saved.backupId, paths: ['paper.docx'] }));
    const reopened = await docx.open('paper.docx');
    expect(reopened).toMatchObject({ readOnly: false, sourceHash: saved.sourceHash });
    expect(reopened.content).toContain('<sub>2</sub>');
    expect(reopened.content).toContain('<sup>n</sup>');
    expect(reopened.content).toContain('<mark>significant</mark>');
    expect(reopened.content).toContain('data-ri-line-height="1.5"');
    expect(reopened.content).toContain('data-ri-space-before-pt="6"');
    expect(reopened.content).toContain('data-ri-space-after-pt="12"');
    expect(reopened.content).toContain('data-ri-text-align="justify"');
    expect(reopened.content).toContain('data-ri-first-line-indent-cm="1.27"');
    expect(reopened.content).toContain('data-ri-left-indent-cm="1.27"');
    expect(reopened.content).toContain('data-ri-right-indent-cm="0.64"');
    expect(reopened.content).toContain('data-ri-font-family="Times New Roman"');
    expect(reopened.content).toContain('data-ri-font-size-pt="12"');
    expect(reopened.content).toContain('data-ri-color="#123456"');
    expect((await readdir(root)).some((name) => name.endsWith('.researchdoc'))).toBe(false);
    await snapshots.restore(saved.backupId);
    await expect(readFile(path.join(root, 'paper.docx'))).resolves.toEqual(original);

    await projects.close();
  });

  it('requires compatibility acknowledgement and makes high-risk packages read-only', async () => {
    const { root, projects, docx } = await projectWithPaper();
    const opened = await docx.open('paper.docx');
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited' }] }] };
    await expect(docx.save({ path: 'paper.docx', content, expectedSourceHash: opened.sourceHash, acknowledgeCompatibilityWarnings: false }))
      .rejects.toMatchObject({ code: 'DOCX_CONFIRM_COMPATIBILITY' });

    const zip = await JSZip.loadAsync(await readFile(path.join(root, 'paper.docx')));
    zip.file('word/embeddings/oleObject1.bin', Buffer.from('embedded object'));
    const settings = await zip.file('word/settings.xml')!.async('string');
    zip.file('word/settings.xml', settings.replace('</w:settings>', '<w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>'));
    await writeFile(path.join(root, 'paper.docx'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const blocked = await docx.open('paper.docx');
    expect(blocked.readOnly).toBe(true);
    expect(blocked.warnings).toContainEqual(expect.objectContaining({ code: 'embedded-object', severity: 'blocking' }));
    expect(blocked.warnings).toContainEqual(expect.objectContaining({ code: 'document-protection', severity: 'blocking' }));
    await expect(docx.save({ path: 'paper.docx', content, expectedSourceHash: blocked.sourceHash, acknowledgeCompatibilityWarnings: true }))
      .rejects.toMatchObject({ code: 'DOCX_READ_ONLY' });

    await projects.close();
  });

  it('refuses a stale save and leaves the externally replaced DOCX untouched', async () => {
    const { root, projects, docx } = await projectWithPaper();
    const opened = await docx.open('paper.docx');
    const external = await createDocxBuffer({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'External version' }] }] });
    await writeFile(path.join(root, 'paper.docx'), external);

    await expect(docx.save({
      path: 'paper.docx',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stale editor version' }] }] },
      expectedSourceHash: opened.sourceHash,
      acknowledgeCompatibilityWarnings: true,
    })).rejects.toMatchObject({ code: 'FILE_CHANGED_ON_DISK' });
    await expect(readFile(path.join(root, 'paper.docx'))).resolves.toEqual(external);

    await projects.close();
  });
});
