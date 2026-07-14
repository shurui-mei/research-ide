import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from './errors';
import { ProjectPathGuard, validateRelativePath } from './path-guard';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('validateRelativePath', () => {
  it('normalizes project-relative paths', () => {
    expect(validateRelativePath('./manuscript/../main.tex')).toBe('main.tex');
    expect(validateRelativePath('analysis\\model.py')).toBe('analysis/model.py');
  });

  it.each(['/etc/passwd', 'C:/Windows/System32', '../outside', 'notes/../../outside', '.research_ide/state.sqlite'])(
    'rejects unsafe path %s',
    (candidate) => {
      expect(() => validateRelativePath(candidate)).toThrow(AppError);
    },
  );

  it.each(['CON', 'nul.txt', 'analysis/file.py:secret', 'notes/trailing. ', 'COM1.log', '\\\\?\\C:\\Windows'])(
    'rejects non-portable Windows device or alternate-stream path %s',
    (candidate) => {
      expect(() => validateRelativePath(candidate)).toThrow(AppError);
    },
  );
});

describe('ProjectPathGuard', () => {
  it('resolves existing files and new writable paths inside the project', async () => {
    const root = await temporaryDirectory('research-ide-project-');
    await mkdir(path.join(root, 'notes'));
    await writeFile(path.join(root, 'notes', 'paper.md'), '# Paper', 'utf8');
    const guard = await ProjectPathGuard.create(root);

    expect(await guard.existing('notes/paper.md')).toBe(path.join(root, 'notes', 'paper.md'));
    expect(await guard.writable('notes/revision.md')).toBe(path.join(root, 'notes', 'revision.md'));
    expect(guard.relative(path.join(root, 'notes', 'paper.md'))).toBe('notes/paper.md');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink that escapes the project', async () => {
    const root = await temporaryDirectory('research-ide-project-');
    const outside = await temporaryDirectory('research-ide-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(outside, path.join(root, 'escape'), 'dir');
    const guard = await ProjectPathGuard.create(root);

    await expect(guard.existing('escape/secret.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    await expect(guard.writable('escape/new.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
  });
});
