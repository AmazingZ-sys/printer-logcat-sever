import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config, LogEntry, LogFilters, LogInput } from './types.js';

type Row = Omit<LogEntry, 'data'> & { data: string | null };
const decode = (row: Row): LogEntry => ({ ...row, data: row.data === null ? null : JSON.parse(row.data) });

export class LogStore {
  private readonly db: Database.Database;
  constructor(private readonly config: Config, private readonly now: () => Date = () => new Date()) {
    if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deviceId TEXT NOT NULL, level TEXT NOT NULL, tag TEXT NOT NULL,
        message TEXT NOT NULL, jobId TEXT, sessionId TEXT,
        timestamp TEXT NOT NULL, receivedAt TEXT NOT NULL, data TEXT
      );
      CREATE INDEX IF NOT EXISTS logs_received ON logs(receivedAt);
      CREATE INDEX IF NOT EXISTS logs_device ON logs(deviceId, id);
      CREATE INDEX IF NOT EXISTS logs_job ON logs(jobId, id);
    `);
    this.prune();
  }

  latestId(): number {
    return (this.db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'logs'), 0) AS id").get() as { id: number }).id;
  }

  insert(entries: LogInput[]): number[] {
    const statement = this.db.prepare(`INSERT INTO logs
      (deviceId, level, tag, message, jobId, sessionId, timestamp, receivedAt, data)
      VALUES (@deviceId, @level, @tag, @message, @jobId, @sessionId, @timestamp, @receivedAt, @data)`);
    return this.db.transaction(() => {
      const receivedAt = this.now().toISOString();
      const ids = entries.map((entry) => Number(statement.run({ ...entry, jobId: entry.jobId ?? null, sessionId: entry.sessionId ?? null, timestamp: entry.timestamp ?? receivedAt, receivedAt, data: entry.data === undefined ? null : JSON.stringify(entry.data) }).lastInsertRowid));
      this.prune();
      return ids;
    })();
  }

  private where(filters: LogFilters) {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    for (const key of ['deviceId', 'level', 'tag', 'jobId'] as const) {
      if (filters[key] !== undefined) { clauses.push(`${key} = ?`); values.push(filters[key]); }
    }
    if (filters.from) { clauses.push('receivedAt >= ?'); values.push(filters.from); }
    if (filters.to) { clauses.push('receivedAt <= ?'); values.push(filters.to); }
    if (filters.q) {
      const pattern = '%' + filters.q.replace(/[\\%_]/g, '\\$&') + '%';
      clauses.push("(message LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')");
      values.push(pattern, pattern);
    }
    return { clauses, values };
  }

  history(filters: LogFilters, limit: number, beforeId?: number) {
    const { clauses, values } = this.where(filters);
    if (beforeId !== undefined) { clauses.push('id < ?'); values.push(beforeId); }
    const rows = this.db.prepare(`SELECT * FROM logs ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...values, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const logs = rows.slice(0, limit).map(decode);
    return { logs, hasMore, nextBeforeId: hasMore ? logs.at(-1)!.id : null, latestId: this.latestId() };
  }

  after(filters: LogFilters, afterId: number): LogEntry[] {
    const { clauses, values } = this.where(filters);
    clauses.push('id > ?');
    values.push(afterId);
    return (this.db.prepare(`SELECT * FROM logs WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT 100`).all(...values) as Row[]).map(decode);
  }

  prune() {
    const cutoff = new Date(this.now().getTime() - this.config.retentionDays * 86400000).toISOString();
    this.db.prepare('DELETE FROM logs WHERE receivedAt < ?').run(cutoff);
    this.db.prepare('DELETE FROM logs WHERE id <= COALESCE((SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?), -1)').run(this.config.maxLogs);
  }

  check() { this.db.prepare('SELECT 1').get(); }
  close() { if (this.db.open) this.db.close(); }
}
