import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ApiError, assertTransition, type Actor, type AuditLog, type Task, type TaskStatus } from './domain';

export class TaskService {
  constructor(private readonly db: Database.Database) {}

  list(deleted = false): Task[] {
    return this.db.prepare(`SELECT * FROM tasks WHERE deletedAt IS ${deleted ? 'NOT ' : ''}NULL ORDER BY createdAt DESC, rowid DESC`).all() as Task[];
  }

  get(id: string, includeDeleted = false): Task {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (!task || (!includeDeleted && task.deletedAt)) {
      throw new ApiError(404, 'TASK_NOT_FOUND', 'Task not found.');
    }
    return task;
  }

  create(input: { title: string; description: string }): Task {
    const now = new Date().toISOString();
    const task: Task = { id: randomUUID(), ...input, status: 'to_do', createdAt: now, updatedAt: now, deletedAt: null };
    this.db.prepare(`INSERT INTO tasks (id, title, description, status, createdAt, updatedAt, deletedAt)
      VALUES (@id, @title, @description, @status, @createdAt, @updatedAt, @deletedAt)`).run(task);
    return task;
  }

  updateStatus(id: string, status: TaskStatus, actor: Actor) {
    // Read, validate, update, and append inside the same write transaction.
    return this.db.transaction(() => {
      const task = this.get(id);
      assertTransition(task.status, status);
      if (task.status === status) return { task, changed: false, auditLog: null };

      // Keep timestamps chronological even if the system clock moves backwards.
      const changedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt))).toISOString();
      const entry = { id: randomUUID(), taskId: id, taskTitle: task.title, actor, fromStatus: task.status, toStatus: status, changedAt };
      this.db.prepare('UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?').run(status, changedAt, id);
      const result = this.db.prepare(`INSERT INTO audit_logs (id, taskId, taskTitle, actor, fromStatus, toStatus, changedAt)
        VALUES (@id, @taskId, @taskTitle, @actor, @fromStatus, @toStatus, @changedAt)`).run(entry);
      const auditLog: AuditLog = { sequence: Number(result.lastInsertRowid), ...entry };
      return { task: { ...task, status, updatedAt: changedAt }, changed: true, auditLog };
    }).immediate();
  }

  delete(id: string): void {
    this.db.transaction(() => {
      const task = this.get(id, true);
      if (task.deletedAt) return;
      const deletedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt))).toISOString();
      this.db.prepare('UPDATE tasks SET deletedAt = ? WHERE id = ?').run(deletedAt, id);
    }).immediate();
  }

  auditLogs(id: string): AuditLog[] {
    this.get(id, true);
    return this.db.prepare('SELECT * FROM audit_logs WHERE taskId = ? ORDER BY sequence ASC').all(id) as AuditLog[];
  }
}
