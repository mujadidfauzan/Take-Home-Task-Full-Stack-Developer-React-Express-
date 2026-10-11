import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { DatabaseConnection } from './database';
import { ApiError, assertTransition, type Actor, type AuditLog, type Task, type TaskStatus } from './domain';

export type TaskDocument = Task & { _id: string };
export type AuditDocument = AuditLog & { _id: string };
const taskDto = ({ _id: _ignored, ...task }: TaskDocument): Task => task;
const logDto = ({ _id: _ignored, ...log }: AuditDocument): AuditLog => log;

export class TaskService {
  private readonly tasks;
  private readonly logs;

  constructor(private readonly connection: DatabaseConnection) {
    this.tasks = connection.db.collection<TaskDocument>('tasks');
    this.logs = connection.db.collection<AuditDocument>('audit_logs');
  }

  async list(deleted = false): Promise<Task[]> {
    const records = await this.tasks.find({ deletedAt: deleted ? { $ne: null } : null }).sort({ createdAt: -1, id: -1 }).toArray();
    return records.map(taskDto);
  }

  async get(id: string, includeDeleted = false, session?: ClientSession): Promise<Task> {
    const record = await this.tasks.findOne({ _id: id, ...(includeDeleted ? {} : { deletedAt: null }) }, { session });
    if (!record) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task not found.');
    return taskDto(record);
  }

  async create(input: { title: string; description: string }): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = { id: randomUUID(), ...input, status: 'to_do', createdAt: now, updatedAt: now, deletedAt: null, version: 0 };
    await this.tasks.insertOne({ _id: task.id, ...task });
    return task;
  }

  private async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.connection.client.startSession();
    try {
      return await session.withTransaction(() => operation(session), {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 5000
      });
    } finally { await session.endSession(); }
  }

  async updateStatus(id: string, status: TaskStatus, actor: Actor) {
    // The driver retries write conflicts; each retry validates the latest task state.
    return this.transaction(async (session) => {
      const task = await this.get(id, false, session);
      assertTransition(task.status, status);
      if (task.status === status) return { task, changed: false, auditLog: null };

      const changedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt))).toISOString();
      const updated = { ...task, status, updatedAt: changedAt, version: task.version + 1 };
      const auditLog: AuditLog = { id: randomUUID(), sequence: updated.version, taskId: id, taskTitle: task.title, actor, fromStatus: task.status, toStatus: status, changedAt };
      const result = await this.tasks.updateOne({ _id: id, version: task.version, deletedAt: null }, {
        $set: { status, updatedAt: changedAt }, $inc: { version: 1 }
      }, { session });
      if (result.modifiedCount !== 1) throw new ApiError(409, 'TASK_CONFLICT', 'Task has changed. Refresh and retry.');
      await this.logs.insertOne({ _id: auditLog.id, ...auditLog }, { session });
      return { task: updated, changed: true, auditLog };
    });
  }

  async delete(id: string) {
    return this.transaction(async (session) => {
      const task = await this.get(id, true, session);
      if (task.deletedAt) return { task, changed: false };
      const deletedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt))).toISOString();
      await this.tasks.updateOne({ _id: id, version: task.version }, { $set: { deletedAt }, $inc: { version: 1 } }, { session });
      return { task: { ...task, deletedAt, version: task.version + 1 }, changed: true };
    });
  }

  async auditLogs(id: string): Promise<AuditLog[]> {
    await this.get(id, true);
    return (await this.logs.find({ taskId: id }).sort({ sequence: 1 }).toArray()).map(logDto);
  }

  async ping(): Promise<void> { await this.connection.db.command({ ping: 1 }); }
}
