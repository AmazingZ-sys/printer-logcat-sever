export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface Config {
  port: number;
  host: string;
  dbPath: string;
  ingestToken: string;
  viewToken: string;
  retentionDays: number;
  maxLogs: number;
  corsOrigins: string[];
}
export interface LogInput {
  deviceId: string;
  level: Level;
  tag: string;
  message: string;
  jobId?: string;
  sessionId?: string;
  timestamp?: string;
  data?: unknown;
}
export interface LogEntry {
  id: number;
  deviceId: string;
  level: Level;
  tag: string;
  message: string;
  jobId: string | null;
  sessionId: string | null;
  timestamp: string;
  receivedAt: string;
  data: unknown;
}
export interface LogFilters {
  deviceId?: string;
  level?: Level;
  tag?: string;
  jobId?: string;
  q?: string;
  from?: string;
  to?: string;
}
