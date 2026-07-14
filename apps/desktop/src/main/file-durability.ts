import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

interface SyncableFileHandle {
  sync(): Promise<void>;
}

/**
 * Ask the operating system to flush an already-written file handle.
 *
 * Callers must pass the same writable handle used to create the file. Windows'
 * FlushFileBuffers requires write access, so reopening the temporary file as
 * read-only before calling sync() can fail with EPERM. Flush errors remain
 * fatal because continuing would claim durability that the OS did not provide.
 */
export async function flushFileHandle(
  handle: SyncableFileHandle,
): Promise<void> {
  await handle.sync();
}

/**
 * Persist the directory entry created by an atomic rename where directory
 * handles are supported. Node/Win32 cannot open a directory for fsync, so the
 * file flush, close, and atomic rename are the strongest available sequence
 * there and this one directory-only step is intentionally skipped.
 */
export async function syncParentDirectory(
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === 'win32') return false;

  const directory = path.dirname(target);
  const directoryOnly = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
  const handle = await open(directory, constants.O_RDONLY | directoryOnly);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      const error = new Error(`Atomic-write parent is not a directory: ${directory}`) as NodeJS.ErrnoException;
      error.code = 'ENOTDIR';
      throw error;
    }
    await flushFileHandle(handle);
    return true;
  } finally {
    await handle.close();
  }
}
