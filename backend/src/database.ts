import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename: string): Database.Database {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
      description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
      status TEXT NOT NULL CHECK (status IN ('to_do', 'pending', 'in_progress', 'done')),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
      taskTitle TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('john.doe', 'jane.smith', 'alex.chen')),
      fromStatus TEXT NOT NULL CHECK (fromStatus IN ('to_do', 'pending', 'in_progress', 'done')),
      toStatus TEXT NOT NULL CHECK (toStatus IN ('to_do', 'pending', 'in_progress', 'done')),
      changedAt TEXT NOT NULL,
      CHECK (
        (fromStatus = 'to_do' AND toStatus = 'pending') OR
        (fromStatus = 'pending' AND toStatus = 'in_progress') OR
        (fromStatus = 'in_progress' AND toStatus = 'done')
      )
    );
    CREATE INDEX IF NOT EXISTS audit_logs_task_sequence ON audit_logs(taskId, sequence);
    CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
      BEFORE UPDATE ON audit_logs BEGIN
        SELECT RAISE(ABORT, 'Audit logs are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
      BEFORE DELETE ON audit_logs BEGIN
        SELECT RAISE(ABORT, 'Audit logs are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS audit_logs_no_replace
      BEFORE INSERT ON audit_logs
      WHEN EXISTS (SELECT 1 FROM audit_logs WHERE id = NEW.id OR sequence = NEW.sequence)
      BEGIN
        SELECT RAISE(ABORT, 'Audit logs are immutable');
      END;
  `);
  return db;
}
