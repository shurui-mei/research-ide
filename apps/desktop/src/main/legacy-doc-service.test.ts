import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocxBuffer } from './docx-service';
import {
  LegacyDocService,
  LibreOfficeConverter,
  legacyDocInternals,
  type LegacyDocConverter,
} from './legacy-doc-service';
import { ProjectService } from './project-service';
import { SnapshotService } from './snapshot-service';

const temporaryRoots: string[] = [];
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

class MemoryWordConverter implements LegacyDocConverter {
  calls: Array<{ from: string; to: string }> = [];
  private lastDocx: Buffer;

  constructor(private readonly initialDocx: Buffer, private readonly initialDoc: Buffer) {
    this.lastDocx = initialDocx;
  }

  async convert(input: Buffer, from: 'doc' | 'docx', to: 'doc' | 'docx'): Promise<Buffer> {
    this.calls.push({ from, to });
    if (from === 'docx' && to === 'doc') {
      this.lastDocx = Buffer.from(input);
      return Buffer.concat([OLE_SIGNATURE, createHash('sha256').update(input).digest()]);
    }
    if (from === 'doc' && to === 'docx') {
      return Buffer.from(input.equals(this.initialDoc) ? this.initialDocx : this.lastDocx);
    }
    throw new Error('unexpected conversion');
  }
}

async function projectWithLegacyDoc(): Promise<{
  root: string;
  projects: ProjectService;
  snapshots: SnapshotService;
  initialDoc: Buffer;
  initialDocx: Buffer;
}> {
  const base = await mkdtemp(path.join(tmpdir(), 'research-ide-legacy-doc-'));
  temporaryRoots.push(base);
  const parent = path.join(base, 'projects');
  await mkdir(parent);
  const projects = new ProjectService(path.join(base, 'user-data'), () => undefined);
  const summary = await projects.create({ name: 'paper', parentPath: parent, template: 'blank', initializeGit: false });
  const initialDoc = Buffer.concat([OLE_SIGNATURE, Buffer.from('ORIGINAL-DOC')]);
  const initialDocx = await createDocxBuffer({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original legacy text' }] }],
  });
  await writeFile(path.join(summary.path, 'paper.doc'), initialDoc);
  return { root: summary.path, projects, snapshots: new SnapshotService(projects), initialDoc, initialDocx };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('legacy DOC workflow', () => {
  it('opens and saves the same DOC with a verified conversion and restorable snapshot', async () => {
    const fixture = await projectWithLegacyDoc();
    const converter = new MemoryWordConverter(fixture.initialDocx, fixture.initialDoc);
    const service = new LegacyDocService(fixture.projects, fixture.snapshots, path.join(path.dirname(fixture.root), 'user-data'), converter);
    const opened = await service.open('paper.doc');

    expect(opened.content).toContain('Original legacy text');
    expect(opened.warnings).toContainEqual(expect.objectContaining({ code: 'legacy-doc-round-trip', requiresAcknowledgement: true }));
    await expect(service.save({
      path: 'paper.doc',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited research result' }] }] },
      expectedSourceHash: opened.sourceHash,
      acknowledgeCompatibilityWarnings: false,
    })).rejects.toMatchObject({ code: 'DOC_CONFIRM_COMPATIBILITY' });

    const saved = await service.save({
      path: 'paper.doc',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited research result' }] }] },
      expectedSourceHash: opened.sourceHash,
      acknowledgeCompatibilityWarnings: true,
    });
    const replacement = await readFile(path.join(fixture.root, 'paper.doc'));
    expect(replacement.subarray(0, OLE_SIGNATURE.length)).toEqual(OLE_SIGNATURE);
    expect(saved.sourceHash).not.toBe(opened.sourceHash);
    const reopened = await service.open('paper.doc');
    expect(reopened.content).toContain('Edited research result');
    expect(converter.calls).toEqual([
      { from: 'doc', to: 'docx' },
      { from: 'docx', to: 'doc' },
      { from: 'doc', to: 'docx' },
      { from: 'doc', to: 'docx' },
    ]);
    expect(fixture.snapshots.list()).toContainEqual(expect.objectContaining({ id: saved.backupId, paths: ['paper.doc'] }));
    await fixture.snapshots.restore(saved.backupId);
    await expect(readFile(path.join(fixture.root, 'paper.doc'))).resolves.toEqual(fixture.initialDoc);
    await fixture.projects.close();
  });

  it('rejects an external replacement before saving and leaves it untouched', async () => {
    const fixture = await projectWithLegacyDoc();
    const converter = new MemoryWordConverter(fixture.initialDocx, fixture.initialDoc);
    const service = new LegacyDocService(fixture.projects, fixture.snapshots, path.join(path.dirname(fixture.root), 'user-data'), converter);
    const opened = await service.open('paper.doc');
    const external = Buffer.concat([OLE_SIGNATURE, Buffer.from('EXTERNAL')]);
    await writeFile(path.join(fixture.root, 'paper.doc'), external);

    await expect(service.save({
      path: 'paper.doc',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stale edit' }] }] },
      expectedSourceHash: opened.sourceHash,
      acknowledgeCompatibilityWarnings: true,
    })).rejects.toMatchObject({ code: 'FILE_CHANGED_ON_DISK' });
    await expect(readFile(path.join(fixture.root, 'paper.doc'))).resolves.toEqual(external);
    expect(converter.calls).toEqual([{ from: 'doc', to: 'docx' }]);
    await fixture.projects.close();
  });

  it('does not snapshot or replace the source when LibreOffice returns a non-DOC payload', async () => {
    const fixture = await projectWithLegacyDoc();
    const converter: LegacyDocConverter = {
      async convert(_input, from, to) {
        if (from === 'doc' && to === 'docx') return fixture.initialDocx;
        return Buffer.from('not an OLE Word document');
      },
    };
    const service = new LegacyDocService(fixture.projects, fixture.snapshots, path.join(path.dirname(fixture.root), 'user-data'), converter);
    const opened = await service.open('paper.doc');

    await expect(service.save({
      path: 'paper.doc',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Never committed' }] }] },
      expectedSourceHash: opened.sourceHash,
      acknowledgeCompatibilityWarnings: true,
    })).rejects.toMatchObject({ code: 'INVALID_DOC_OUTPUT' });
    await expect(readFile(path.join(fixture.root, 'paper.doc'))).resolves.toEqual(fixture.initialDoc);
    expect(fixture.snapshots.list()).toEqual([]);
    await fixture.projects.close();
  });

  it('reports an actionable error instead of falling back to an untrusted PATH executable', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'research-ide-no-libreoffice-'));
    temporaryRoots.push(base);
    const converter = new LibreOfficeConverter(base, { resolveExecutable: async () => undefined });

    await expect(converter.convert(Buffer.concat([OLE_SIGNATURE, Buffer.from('input')]), 'doc', 'docx'))
      .rejects.toMatchObject({ code: 'LIBREOFFICE_NOT_FOUND', message: expect.stringMatching(/设置 → 工具链/u) });
  });

  it.skipIf(process.platform === 'win32')('preserves bounded LibreOffice diagnostics when conversion fails', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'research-ide-libreoffice-diagnostic-'));
    temporaryRoots.push(base);
    const executable = path.join(base, 'soffice');
    await writeFile(executable, '#!/bin/sh\nprintf "test converter detail" >&2\nexit 7\n', 'utf8');
    await chmod(executable, 0o700);
    const converter = new LibreOfficeConverter(path.join(base, 'user-data'), { resolveExecutable: async () => executable });

    await expect(converter.convert(Buffer.concat([OLE_SIGNATURE, Buffer.from('input')]), 'doc', 'docx'))
      .rejects.toMatchObject({
        code: 'LIBREOFFICE_CONVERSION_FAILED',
        message: expect.stringMatching(/退出码 7.*test converter detail/u),
      });
  });

  it('defines locked-down profiles and versioned managed installation candidates', () => {
    expect(legacyDocInternals.lockedDownProfile).toContain('MacroSecurityLevel');
    expect(legacyDocInternals.lockedDownProfile).toContain('UpdateDocMode');
    const candidates = legacyDocInternals.managedLibreOfficeCandidates('/app-data', 'linux', '24.8.1');
    expect(candidates).toContain(path.join('/app-data', 'toolchains', 'libreoffice', '24.8.1', 'program', 'soffice'));
    expect(legacyDocInternals.systemLibreOfficeCandidates('linux')).toContain('/usr/bin/libreoffice');
    expect(legacyDocInternals.systemLibreOfficeCandidates('linux')).toContain('/usr/lib/libreoffice/program/soffice');
  });
});
