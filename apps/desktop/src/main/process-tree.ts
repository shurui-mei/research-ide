import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/**
 * Long-running tools are placed in their own POSIX process group.  Windows has
 * no equivalent Node spawn flag, so shutdown uses the OS task-tree primitive.
 */
export function detachedProcessGroup(): boolean {
  return process.platform !== 'win32';
}

export function processTreeAlive(child: ChildProcess): boolean {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals, force = false): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  const killer = spawn(taskkill, ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], {
    env: { SystemRoot: systemRoot, WINDIR: systemRoot },
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  killer.once('error', () => child.kill(force ? 'SIGKILL' : signal));
  killer.unref();
}
