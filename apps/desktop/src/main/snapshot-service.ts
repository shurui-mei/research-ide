import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SnapshotInfo } from '../shared/types';
import { AppError } from './errors';
import type { ProjectService } from './project-service';

interface ManifestEntry { path: string; bytes: number; sha256: string }
interface SnapshotRow {
  id: string; label: string | null; paths_json: string; file_count: number; total_bytes: number; created_at: string;
}
const DEFAULT_EXCLUDED_DIRECTORIES = new Set(['.research_ide', '.git', 'node_modules', '.venv', 'venv', '__pycache__']);

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export class SnapshotService {
  constructor(private readonly projects: ProjectService) {}

  list(): SnapshotInfo[] {
    const rows = this.projects.database.db.prepare('SELECT id,label,paths_json,file_count,total_bytes,created_at FROM snapshots ORDER BY created_at DESC').all() as SnapshotRow[];
    return rows.map((row) => ({
      id: row.id, label: row.label ?? undefined, createdAt: row.created_at,
      paths: this.parsePaths(row.paths_json), fileCount: row.file_count, totalBytes: row.total_bytes,
    }));
  }

  async create(paths: string[], label?: string): Promise<SnapshotInfo> {
    await this.projects.assertMetadataIntegrity();
    if (!Array.isArray(paths) || paths.length > 256 || paths.some((value) => typeof value !== 'string' || value.length > 8_192)) throw new AppError('INVALID_SNAPSHOT_PATHS', 'Snapshot paths are invalid');
    if (label !== undefined && (typeof label !== 'string' || label.length > 1_000)) throw new AppError('INVALID_SNAPSHOT_LABEL', 'Snapshot label is invalid');
    const selections = [...new Set((paths.length ? paths : ['']).map((value) => value.replaceAll('\\', '/')))];
    const id = randomUUID();
    const backupsRoot = await this.projects.internalDirectory('backups');
    const backupRoot = path.join(backupsRoot, id, 'files');
    await mkdir(backupRoot, { recursive: true });
    await this.assertInside(backupsRoot, await realpath(backupRoot));
    const manifest: ManifestEntry[] = [];
    try {
      for (const selection of selections) {
        const source = await this.projects.guard.existing(selection);
        const relative = this.projects.guard.relative(source);
        await this.copyIntoSnapshot(source, relative, backupRoot, manifest);
      }
      const normalizedLabel = label?.trim().slice(0, 200) || undefined;
      const createdAt = new Date().toISOString();
      const totalBytes = manifest.reduce((sum, file) => sum + file.bytes, 0);
      await mkdir(path.dirname(backupRoot), { recursive: true });
      await writeFile(path.join(path.dirname(backupRoot), 'manifest.json'), JSON.stringify({ id, label: normalizedLabel, createdAt, paths: selections, files: manifest }, null, 2), { encoding: 'utf8', mode: 0o600 });
      this.projects.database.db.prepare('INSERT INTO snapshots(id,label,paths_json,manifest_json,file_count,total_bytes,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, normalizedLabel ?? null, JSON.stringify(selections), JSON.stringify(manifest), manifest.length, totalBytes, createdAt);
      return { id, label: normalizedLabel, createdAt, paths: selections, fileCount: manifest.length, totalBytes };
    } catch (error) {
      await rm(path.dirname(backupRoot), { recursive: true, force: true });
      throw error;
    }
  }

  async restore(id: string): Promise<void> {
    await this.projects.assertMetadataIntegrity();
    this.assertId(id);
    const row = this.projects.database.db.prepare('SELECT manifest_json FROM snapshots WHERE id = ?').get(id) as { manifest_json: string } | undefined;
    if (!row) throw new AppError('SNAPSHOT_NOT_FOUND', 'Snapshot does not exist');
    let manifest: ManifestEntry[];
    try { manifest = JSON.parse(row.manifest_json) as ManifestEntry[]; } catch { throw new AppError('SNAPSHOT_CORRUPT', 'Snapshot manifest is invalid JSON'); }
    if (!Array.isArray(manifest) || manifest.length > 100_000) throw new AppError('SNAPSHOT_CORRUPT', 'Snapshot manifest is invalid');
    const backupsRoot = await this.projects.internalDirectory('backups');
    const backupRoot = await realpath(path.join(backupsRoot, id, 'files'));
    await this.assertInside(backupsRoot, backupRoot);
    const stageId = randomUUID();
    const stageRoot = path.join(await this.projects.internalDirectory('history'), `restore-stage-${stageId}`);
    await mkdir(stageRoot, { recursive: false });
    const verified: Array<{ entry: ManifestEntry; staged: string }> = [];
    const seenPaths = new Set<string>();
    try {
      // Verify and stage every source before touching a working file. This prevents
      // a corrupt late manifest entry from leaving a half-restored project.
      for (const entry of manifest) {
        if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(entry.sha256)) throw new AppError('SNAPSHOT_CORRUPT', 'Snapshot manifest is invalid');
        this.projects.guard.lexical(entry.path);
        if (seenPaths.has(entry.path)) throw new AppError('SNAPSHOT_CORRUPT', `Snapshot contains a duplicate path: ${entry.path}`);
        seenPaths.add(entry.path);
        const lexicalSource = path.resolve(backupRoot, ...entry.path.split('/'));
        const lexicalRelative = path.relative(backupRoot, lexicalSource);
        if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) throw new AppError('SNAPSHOT_CORRUPT', 'Snapshot contains an unsafe path');
        const sourceInfo = await lstat(lexicalSource);
        if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new AppError('SNAPSHOT_CORRUPT', `Snapshot source is not a regular file: ${entry.path}`);
        const source = await realpath(lexicalSource);
        await this.assertInside(backupRoot, source);
        if (typeof entry.bytes !== 'number' || entry.bytes < 0 || sourceInfo.size !== entry.bytes) throw new AppError('SNAPSHOT_CORRUPT', `Size mismatch for ${entry.path}`);
        if (await sha256File(source) !== entry.sha256) throw new AppError('SNAPSHOT_CORRUPT', `Checksum mismatch for ${entry.path}`);
        const staged = path.join(stageRoot, `${verified.length}.file`);
        await copyFile(source, staged);
        verified.push({ entry, staged });
      }
      const existingPaths: string[] = [];
      const rollbackFiles = new Map<string, string | undefined>();
      for (const { entry } of verified) {
        try {
          const current = await this.projects.guard.existing(entry.path);
          const currentInfo = await lstat(current);
          if (!currentInfo.isFile()) throw new AppError('RESTORE_TARGET_INVALID', `Restore target is not a regular file: ${entry.path}`);
          const rollbackFile = path.join(stageRoot, `${rollbackFiles.size}.original`);
          await copyFile(current, rollbackFile);
          rollbackFiles.set(entry.path, rollbackFile);
          existingPaths.push(entry.path);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error;
          rollbackFiles.set(entry.path, undefined);
        }
      }
      if (existingPaths.length) await this.create([...new Set(existingPaths)], `Before restore ${id.slice(0, 8)}`);
      const applied: ManifestEntry[] = [];
      try {
        for (const { entry, staged } of verified) {
          const target = await this.projects.guard.writable(entry.path);
          await mkdir(path.dirname(target), { recursive: true });
          const temporary = `${target}.${randomUUID()}.restore`;
          try {
            await copyFile(staged, temporary);
            await rename(temporary, target);
          } finally {
            await rm(temporary, { force: true });
          }
          applied.push(entry);
        }
      } catch (restoreError) {
        const rollbackFailures: string[] = [];
        for (const entry of applied.reverse()) {
          try {
            const target = await this.projects.guard.writable(entry.path);
            const original = rollbackFiles.get(entry.path);
            if (original) {
              const temporary = `${target}.${randomUUID()}.rollback`;
              try {
                await copyFile(original, temporary);
                await rename(temporary, target);
              } finally {
                await rm(temporary, { force: true });
              }
            } else {
              await rm(target, { force: true });
            }
          } catch (rollbackError) {
            rollbackFailures.push(`${entry.path}: ${rollbackError instanceof Error ? rollbackError.message : 'unknown error'}`);
          }
        }
        if (rollbackFailures.length) {
          throw new AppError('SNAPSHOT_ROLLBACK_FAILED', `Restore failed and automatic rollback was incomplete. Use the pre-restore snapshot to recover. ${rollbackFailures.join('; ')}`);
        }
        throw restoreError;
      }
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }

  async delete(id: string): Promise<void> {
    await this.projects.assertMetadataIntegrity();
    this.assertId(id);
    const exists = this.projects.database.db.prepare('SELECT id FROM snapshots WHERE id = ?').get(id);
    if (!exists) throw new AppError('SNAPSHOT_NOT_FOUND', 'Snapshot does not exist');
    const snapshotRoot = path.join(await this.projects.internalDirectory('backups'), id);
    const info = await lstat(snapshotRoot).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new AppError('UNSAFE_PROJECT_METADATA', 'Snapshot directory must not be a symbolic link');
    await rm(snapshotRoot, { recursive: true, force: true });
    this.projects.database.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  }

  private async copyIntoSnapshot(source: string, relative: string, backupRoot: string, manifest: ManifestEntry[]): Promise<void> {
    const info = await lstat(source);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || (entry.isDirectory() && DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)) || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        await this.copyIntoSnapshot(path.join(source, entry.name), childRelative, backupRoot, manifest);
      }
      return;
    }
    if (!info.isFile()) return;
    const destination = path.resolve(backupRoot, ...relative.split('/'));
    if (!destination.startsWith(`${backupRoot}${path.sep}`)) throw new AppError('SNAPSHOT_PATH', 'Snapshot destination is unsafe');
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const copied = await lstat(destination);
    manifest.push({ path: relative, bytes: copied.size, sha256: await sha256File(destination) });
  }

  private parsePaths(value: string): string[] {
    try { const result = JSON.parse(value); return Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
  }

  private assertId(id: string): void {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new AppError('INVALID_SNAPSHOT_ID', 'Snapshot id is invalid');
  }

  private async assertInside(root: string, candidate: string): Promise<void> {
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AppError('SNAPSHOT_PATH', 'Snapshot path resolves outside the backup directory');
  }
}
