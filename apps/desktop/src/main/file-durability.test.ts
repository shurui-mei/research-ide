import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushFileHandle, syncParentDirectory } from './file-durability';

const roots: string[] = [];

function fsError(code: string, syscall: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${syscall}`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = syscall;
  return error;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('file durability', () => {
  it('propagates every flush failure, including Windows EPERM', async () => {
    await expect(flushFileHandle({ sync: vi.fn().mockRejectedValue(fsError('EPERM', 'fsync')) }))
      .rejects.toMatchObject({ code: 'EPERM', syscall: 'fsync' });
    await expect(flushFileHandle({ sync: vi.fn().mockRejectedValue(fsError('EIO', 'fsync')) }))
      .rejects.toMatchObject({ code: 'EIO', syscall: 'fsync' });
    await expect(flushFileHandle({ sync: vi.fn().mockRejectedValue(fsError('EPERM', 'write')) }))
      .rejects.toMatchObject({ code: 'EPERM', syscall: 'write' });
  });

  it('reports a successful file flush', async () => {
    const handle = { sync: vi.fn().mockResolvedValue(undefined) };
    await expect(flushFileHandle(handle)).resolves.toBeUndefined();
    expect(handle.sync).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === 'win32')('syncs the containing directory on supported platforms', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'research-ide-durability-'));
    roots.push(root);
    const target = path.join(root, 'record.json');
    await writeFile(target, '{}', 'utf8');

    await expect(syncParentDirectory(target, process.platform)).resolves.toBe(true);
  });

  it('skips the unsupported directory-handle step on Windows', async () => {
    await expect(syncParentDirectory(path.join('missing', 'record.json'), 'win32')).resolves.toBe(false);
  });
});
