import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { connectDatabase, DEFAULT_MONGO_URI } from '../src/database';
import type { AuditLog, Task } from '../src/domain';
import type { AuditDocument, TaskDocument } from '../src/task-service';

async function main() {
  const filename = process.env.SQLITE_PATH ?? resolve(__dirname, '../data/tasks.sqlite');
  const source = new DatabaseSync(filename, { readOnly: true });
  const tasks = source.prepare('SELECT * FROM tasks').all() as unknown as Omit<Task, 'version'>[];
  const logs = source.prepare('SELECT * FROM audit_logs ORDER BY sequence ASC').all() as unknown as AuditLog[];
  source.close();
  const connection = await connectDatabase(process.env.MONGODB_URI ?? DEFAULT_MONGO_URI, process.env.MONGO_DB_NAME ?? 'mini_tasks');
  const session = connection.client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const task of tasks) {
        const taskLogs = logs.filter((log) => log.taskId === task.id);
        const version = Math.max(0, ...taskLogs.map((log) => log.sequence)) + (task.deletedAt ? 1 : 0);
        await connection.db.collection<TaskDocument>('tasks').insertOne({ _id: task.id, ...task, version }, { session });
      }
      for (const log of logs) await connection.db.collection<AuditDocument>('audit_logs').insertOne({ _id: log.id, ...log }, { session });
    }, { writeConcern: { w: 'majority' } });
    console.log(`Migration complete: ${tasks.length} tasks and ${logs.length} audit logs. SQLite source unchanged.`);
  } finally { await session.endSession(); await connection.client.close(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
