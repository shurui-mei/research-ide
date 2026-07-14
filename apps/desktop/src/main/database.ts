import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { LiteratureItem } from '../shared/types';
import { AppError } from './errors';

type LiteratureRow = {
  id: string; title: string; authors_json: string; year: number | null; venue: string | null;
  citekey: string | null; item_type: LiteratureItem['itemType'] | null; tags_json: string;
  attachment_path: string | null; source: LiteratureItem['source'];
};

export class ProjectDatabase {
  readonly db: Database.Database;
  readonly recoveredDatabasePath?: string;

  constructor(projectRoot: string) {
    const metadataRoot = realpathSync(path.join(projectRoot, '.research_ide'));
    const relativeMetadata = path.relative(projectRoot, metadataRoot);
    if (relativeMetadata === '..' || relativeMetadata.startsWith(`..${path.sep}`) || path.isAbsolute(relativeMetadata)) throw new AppError('UNSAFE_PROJECT_METADATA', 'Database directory resolves outside the project');
    const databasePath = path.join(metadataRoot, 'state.sqlite');
    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (!existsSync(candidate)) continue;
      const info = lstatSync(candidate);
      if (info.isSymbolicLink() || !info.isFile()) throw new AppError('UNSAFE_PROJECT_METADATA', `${path.basename(candidate)} must be a regular file`);
      const canonical = realpathSync(candidate);
      const relative = path.relative(metadataRoot, canonical);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AppError('UNSAFE_PROJECT_METADATA', 'Database file resolves outside project metadata');
    }
    try {
      this.db = this.open(databasePath);
    } catch (error) {
      if (!this.isCorruption(error)) throw error;
      const historyRoot = realpathSync(path.join(metadataRoot, 'history'));
      const relativeHistory = path.relative(metadataRoot, historyRoot);
      if (relativeHistory === '..' || relativeHistory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeHistory)) throw new AppError('UNSAFE_PROJECT_METADATA', 'Database recovery directory resolves outside project metadata');
      const recoveryRoot = path.join(historyRoot, `database-corrupt-${new Date().toISOString().replaceAll(':', '-')}`);
      mkdirSync(recoveryRoot, { mode: 0o700 });
      for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(candidate)) renameSync(candidate, path.join(recoveryRoot, path.basename(candidate)));
      }
      this.recoveredDatabasePath = recoveryRoot;
      this.db = this.open(databasePath);
      this.setSetting('database_recovered_from', { path: recoveryRoot, at: new Date().toISOString() });
    }
  }

  private open(databasePath: string): Database.Database {
    const database = new Database(databasePath);
    try {
      database.pragma('busy_timeout = 5000');
      const quickCheck = database.pragma('quick_check', { simple: true });
      if (quickCheck !== 'ok') throw new AppError('SQLITE_CORRUPT', 'Project state database failed SQLite quick_check');
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');
      this.migrate(database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private isCorruption(error: unknown): boolean {
    if (error instanceof AppError && error.code === 'SQLITE_CORRUPT') return true;
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB';
  }

  private migrate(database: Database.Database): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS toolchains (
        id TEXT PRIMARY KEY,
        executable_path TEXT NOT NULL,
        version TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS literature (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL DEFAULT '[]',
        year INTEGER,
        venue TEXT,
        citekey TEXT,
        item_type TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        attachment_path TEXT,
        source TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        relative_path TEXT PRIMARY KEY,
        content_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        label TEXT,
        paths_json TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value_json) as T; } catch { return undefined; }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  listLiterature(query = ''): LiteratureItem[] {
    const rows = (query
      ? this.db.prepare(`SELECT * FROM literature WHERE title LIKE ? OR authors_json LIKE ? OR citekey LIKE ? ORDER BY updated_at DESC`).all(`%${query}%`, `%${query}%`, `%${query}%`)
      : this.db.prepare('SELECT * FROM literature ORDER BY updated_at DESC').all()) as LiteratureRow[];
    return rows.map((row) => this.toLiterature(row));
  }

  getLiterature(id: string): LiteratureItem | undefined {
    const row = this.db.prepare('SELECT * FROM literature WHERE id = ?').get(id) as LiteratureRow | undefined;
    return row ? this.toLiterature(row) : undefined;
  }

  saveLiterature(item: LiteratureItem): LiteratureItem {
    if (!item.title.trim()) throw new AppError('INVALID_LITERATURE', 'A title is required');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO literature
      (id,title,authors_json,year,venue,citekey,item_type,tags_json,attachment_path,source,created_at,updated_at)
      VALUES (@id,@title,@authors,@year,@venue,@citekey,@itemType,@tags,@attachmentPath,@source,@now,@now)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,authors_json=excluded.authors_json,year=excluded.year,
      venue=excluded.venue,citekey=excluded.citekey,item_type=excluded.item_type,tags_json=excluded.tags_json,
      attachment_path=excluded.attachment_path,source=excluded.source,updated_at=excluded.updated_at`).run({
        id: item.id, title: item.title.trim(), authors: JSON.stringify(item.authors ?? []), year: item.year ?? null,
        venue: item.venue ?? null, citekey: item.citekey ?? null, itemType: item.itemType ?? 'other',
        tags: JSON.stringify(item.tags ?? []), attachmentPath: item.attachmentPath ?? null, source: item.source ?? 'local', now,
      });
    return this.getLiterature(item.id)!;
  }

  deleteLiterature(id: string): boolean {
    return this.db.prepare('DELETE FROM literature WHERE id = ?').run(id).changes > 0;
  }

  private toLiterature(row: LiteratureRow): LiteratureItem {
    const parseList = (value: string): string[] => {
      try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []; } catch { return []; }
    };
    return {
      id: row.id, title: row.title, authors: parseList(row.authors_json), year: row.year ?? undefined,
      venue: row.venue ?? undefined, citekey: row.citekey ?? undefined, itemType: row.item_type ?? undefined,
      tags: parseList(row.tags_json), attachmentPath: row.attachment_path ?? undefined, source: row.source ?? 'local',
    };
  }
}
