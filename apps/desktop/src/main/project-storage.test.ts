import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from './errors';
import { ProjectService } from './project-service';
import { SnapshotService } from './snapshot-service';

interface TestProject {
  base: string;
  root: string;
  projects: ProjectService;
}

const opened: TestProject[] = [];

async function createProject(template: 'blank' | 'latex' | 'paper' = 'blank'): Promise<TestProject> {
  const base = await mkdtemp(path.join(tmpdir(), 'research-ide-storage-'));
  const parent = path.join(base, 'projects');
  await mkdir(parent);
  const projects = new ProjectService(path.join(base, 'user-data'), () => undefined);
  const summary = await projects.create({ name: 'paper', parentPath: parent, template, initializeGit: false });
  const result = { base, root: summary.path, projects };
  opened.push(result);
  return result;
}

afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.projects.close().catch(() => undefined);
    await rm(item.base, { force: true, recursive: true });
  }
});

describe('project configuration and document storage', () => {
  it.each([
    ['paper', '研究论文'],
    ['latex', '中文 LaTeX 项目'],
  ] as const)('creates a ctex/Fandol Chinese LaTeX template for %s projects', async (template, title) => {
    const { root } = await createProject(template);

    const source = await readFile(path.join(root, 'main.tex'), 'utf8');
    expect(source).toContain('\\documentclass[UTF8,fontset=fandol]{ctexart}');
    expect(source).toContain(`\\title{${title}}`);
    expect(source).toContain('\\section{引言}');
    expect(source).toContain('支持中文排版');
    expect(source).not.toContain('inputenc');
    await expect(readFile(path.join(root, 'references.bib'), 'utf8')).resolves.toBe('');
  });

  it('creates a reviewable Codex policy copy that explicitly cannot grant authority', async () => {
    const { root } = await createProject();

    const policy = await readFile(path.join(root, '.research_ide', 'codex-policy.md'), 'utf8');
    expect(policy).toContain('not an authorization source');
    expect(policy).toContain('Electron main process');
  });

  it('adds a missing policy audit copy to an existing initialized project without overwriting project config', async () => {
    const { projects, root } = await createProject();
    const policyPath = path.join(root, '.research_ide', 'codex-policy.md');
    const configPath = path.join(root, '.research_ide', 'project.toml');
    const configBefore = await readFile(configPath, 'utf8');
    await rm(policyPath);
    await projects.close();

    await projects.open(root);

    await expect(readFile(policyPath, 'utf8')).resolves.toContain('not an authorization source');
    await expect(readFile(configPath, 'utf8')).resolves.toBe(configBefore);
  });

  it('refreshes the generated project schema for an existing project', async () => {
    const { projects, root } = await createProject();
    const schemaPath = path.join(root, '.research_ide', 'project.schema.json');
    await writeFile(schemaPath, '{}', 'utf8');
    await projects.close();

    await projects.open(root);

    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as { properties?: { toolchains?: { properties?: Record<string, unknown> } } };
    expect(schema.properties?.toolchains?.properties).toMatchObject({ compiler: expect.any(Object), julia: expect.any(Object) });
  });

  it('atomically writes a schema-valid structured toolchain binding', async () => {
    const { projects, root } = await createProject();

    await projects.updateToolchainBinding('python', { source: 'system' });

    const config = TOML.parse(await readFile(path.join(root, '.research_ide', 'project.toml'), 'utf8'));
    expect(config.toolchains).toEqual({ python: { source: 'system' } });
    expect(projects.configuredToolchains).toEqual({ python: { source: 'system' } });
    expect((await readdir(path.join(root, '.research_ide'))).some((name) => name.startsWith('.project.toml-'))).toBe(false);
  });

  it.each(['CON', 'nul.txt', 'paper:stream'])('rejects non-portable project name %s', async (name) => {
    const base = await mkdtemp(path.join(tmpdir(), 'research-ide-project-name-'));
    opened.push({ base, root: '', projects: new ProjectService(path.join(base, 'user-data'), () => undefined) });
    const parent = path.join(base, 'projects');
    await mkdir(parent);

    await expect(opened.at(-1)!.projects.create({ name, parentPath: parent, template: 'blank', initializeGit: false }))
      .rejects.toMatchObject({ code: 'INVALID_PROJECT_NAME' });
  });

  it('rejects an unknown project configuration field without dropping the active project', async () => {
    const { projects, root } = await createProject();
    const configPath = path.join(root, '.research_ide', 'project.toml');
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}\nunknown = true\n`, 'utf8');
    let transitionStarted = false;

    await expect(projects.open(root, async () => { transitionStarted = true; })).rejects.toMatchObject({ code: 'INVALID_PROJECT_CONFIG' });
    expect(projects.current?.path).toBe(root);
    expect(transitionStarted).toBe(false);
  });

  it('uses the structured document on disk as the source of truth', async () => {
    const { projects, root } = await createProject('paper');
    const external = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'external edit' }] }] };
    await writeFile(path.join(root, 'paper.researchdoc'), JSON.stringify(external), 'utf8');

    await expect(projects.readDocument('paper.researchdoc')).resolves.toEqual(external);

    const saved = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Saved' }] }] };
    await projects.writeDocument('paper.researchdoc', saved);
    await expect(readFile(path.join(root, 'paper.researchdoc'), 'utf8').then(JSON.parse)).resolves.toEqual(saved);
  });

  it('refuses to overwrite an externally changed open text file', async () => {
    const { projects, root } = await createProject();
    await projects.writeText('notes.md', 'original');
    await projects.readText('notes.md');
    await writeFile(path.join(root, 'notes.md'), 'external edit', 'utf8');

    await expect(projects.writeText('notes.md', 'stale editor contents')).rejects.toMatchObject({ code: 'FILE_CHANGED_ON_DISK' });
    await expect(readFile(path.join(root, 'notes.md'), 'utf8')).resolves.toBe('external edit');
  });

  it('quarantines a corrupt rebuildable state database without losing project files', async () => {
    const { projects, root } = await createProject();
    await projects.writeText('manuscript.md', 'source of truth');
    await projects.close();
    await writeFile(path.join(root, '.research_ide', 'state.sqlite'), 'not a sqlite database', 'utf8');

    await expect(projects.open(root)).resolves.toMatchObject({ path: root });
    await expect(projects.readText('manuscript.md')).resolves.toBe('source of truth');
    const history = await readdir(path.join(root, '.research_ide', 'history'));
    expect(history.some((name) => name.startsWith('database-corrupt-'))).toBe(true);
  });
});

describe('local snapshots', () => {
  it('restores a verified file and creates a pre-restore recovery point', async () => {
    const { projects } = await createProject();
    const snapshots = new SnapshotService(projects);
    await projects.writeText('notes.txt', 'version one');
    const snapshot = await snapshots.create(['notes.txt'], 'version one');
    await projects.writeText('notes.txt', 'version two');

    await snapshots.restore(snapshot.id);

    await expect(projects.readText('notes.txt')).resolves.toBe('version one');
    expect(snapshots.list().some((item) => item.label?.startsWith('Before restore'))).toBe(true);
  });

  it('fails before changing the worktree when snapshot content is corrupt', async () => {
    const { projects, root } = await createProject();
    const snapshots = new SnapshotService(projects);
    await projects.writeText('notes.txt', 'snapshot value');
    const snapshot = await snapshots.create(['notes.txt']);
    await projects.writeText('notes.txt', 'current value');
    await writeFile(path.join(root, '.research_ide', 'backups', snapshot.id, 'files', 'notes.txt'), 'tampered', 'utf8');

    await expect(snapshots.restore(snapshot.id)).rejects.toMatchObject({ code: 'SNAPSHOT_CORRUPT' });
    await expect(projects.readText('notes.txt')).resolves.toBe('current value');
  });

  it('rolls back files already applied when a later restore write fails', async () => {
    const { projects } = await createProject();
    const snapshots = new SnapshotService(projects);
    await projects.writeText('a.txt', 'snapshot a');
    await projects.writeText('b.txt', 'snapshot b');
    const snapshot = await snapshots.create(['a.txt', 'b.txt']);
    await projects.writeText('a.txt', 'current a');
    await projects.writeText('b.txt', 'current b');
    const writable = projects.guard.writable.bind(projects.guard);
    vi.spyOn(projects.guard, 'writable').mockImplementation((relativePath, allowInternal) => {
      if (relativePath === 'b.txt') return Promise.reject(new AppError('SIMULATED_IO_FAILURE', 'simulated second-file failure'));
      return writable(relativePath, allowInternal);
    });

    await expect(snapshots.restore(snapshot.id)).rejects.toMatchObject({ code: 'SIMULATED_IO_FAILURE' });
    await expect(projects.readText('a.txt')).resolves.toBe('current a');
    await expect(projects.readText('b.txt')).resolves.toBe('current b');
  });
});
