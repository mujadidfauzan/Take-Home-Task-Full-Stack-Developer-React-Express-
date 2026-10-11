import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from '../src/app';
import { openDatabase } from '../src/database';
import { ACTORS, STATUSES } from '../src/domain';
import { TaskService } from '../src/task-service';

let db: Database.Database;
let service: TaskService;
let app: ReturnType<typeof createApp>;
beforeEach(() => { db = openDatabase(':memory:'); service = new TaskService(db); app = createApp(db); });
afterEach(() => db.close());
const create = () => service.create({ title: 'Prepare Invoice', description: 'Invoice for October' });

test('creates a trimmed task in to_do, without a status-change log', async () => {
  const response = await request(app).post('/api/tasks').send({ title: '  Prepare Invoice  ', description: ' Details ' }).expect(201);
  assert.equal(response.body.task.title, 'Prepare Invoice');
  assert.equal(response.body.task.description, 'Details');
  assert.equal(response.body.task.status, 'to_do');
  assert.equal(response.body.task.deletedAt, null);
  const list = await request(app).get('/api/tasks').expect(200);
  assert.equal(list.body.tasks.length, 1);
  assert.deepEqual(service.auditLogs(response.body.task.id), []);
});

test('rejects invalid create bodies at the API boundary', async () => {
  for (const body of [{}, { title: '   ' }, { title: 123 }, { title: 'a'.repeat(121) }, { title: 'Valid', description: false }, { title: 'Valid', description: 'a'.repeat(2001) }, []]) {
    const response = await request(app).post('/api/tasks').send(body).expect(400);
    assert.equal(response.body.error.code, 'INVALID_INPUT');
  }
  assert.equal(service.list().length, 0);
});

test('records all forward transitions with actor, task snapshot, and chronological order', async () => {
  const task = create();
  for (const [index, status] of STATUSES.slice(1).entries()) {
    const response = await request(app).put(`/api/tasks/${task.id}/status`).send({ status, actor: ACTORS[index] }).expect(200);
    assert.equal(response.body.changed, true);
    assert.equal(response.body.task.status, status);
    assert.equal(response.body.auditLog.fromStatus, STATUSES[index]);
    assert.equal(response.body.auditLog.toStatus, status);
    assert.equal(response.body.auditLog.actor, ACTORS[index]);
    assert.equal(response.body.auditLog.taskId, task.id);
    assert.equal(response.body.auditLog.taskTitle, task.title);
    assert.equal(response.body.auditLog.changedAt, response.body.task.updatedAt);
  }
  const logs = (await request(app).get(`/api/tasks/${task.id}/audit-logs`).expect(200)).body.auditLogs;
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map((log: { toStatus: string }) => log.toStatus), ['pending', 'in_progress', 'done']);
  assert.ok(logs.every((log: { changedAt: string }, i: number) => i === 0 || log.changedAt >= logs[i - 1].changedAt));
});

test('same-status requests are idempotent for every status, including done', async () => {
  const task = create();
  for (const [index, status] of STATUSES.entries()) {
    if (index > 0) service.updateStatus(task.id, status, 'john.doe');
    const beforeTask = service.get(task.id);
    const beforeLogs = service.auditLogs(task.id);
    for (let retry = 0; retry < 2; retry++) {
      const response = await request(app).put(`/api/tasks/${task.id}/status`).send({ status, actor: 'jane.smith' }).expect(200);
      assert.equal(response.body.changed, false);
      assert.equal(response.body.auditLog, null);
      assert.deepEqual(response.body.task, beforeTask);
    }
    assert.deepEqual(service.auditLogs(task.id), beforeLogs);
  }
});

test('rejects every skipped or backward transition, leaving both task and logs unchanged', async () => {
  for (const [fromIndex, fromStatus] of STATUSES.entries()) {
    const task = create();
    for (const status of STATUSES.slice(1, fromIndex + 1)) service.updateStatus(task.id, status, 'john.doe');
    const before = service.get(task.id);
    const logs = service.auditLogs(task.id);
    for (const [toIndex, toStatus] of STATUSES.entries()) {
      if (toStatus === fromStatus || toIndex === fromIndex + 1) continue;
      const response = await request(app).put(`/api/tasks/${task.id}/status`).send({ status: toStatus, actor: 'john.doe' }).expect(409);
      assert.equal(response.body.error.code, 'INVALID_TRANSITION');
      assert.deepEqual(service.get(task.id), before);
      assert.deepEqual(service.auditLogs(task.id), logs);
    }
  }
});

test('rejects unknown status or actor, even for a same-status request', async () => {
  const task = create();
  for (const body of [{ status: 'cancelled', actor: 'john.doe' }, { status: 'pending', actor: 'unknown' }, { status: 'to_do', actor: 'unknown' }, { status: 'pending' }, { status: ['pending'], actor: 'john.doe' }]) {
    await request(app).put(`/api/tasks/${task.id}/status`).send(body).expect(400);
  }
  assert.equal(service.get(task.id).status, 'to_do');
  assert.equal(service.auditLogs(task.id).length, 0);
});

test('rolls back the task update when audit insertion fails', () => {
  const task = create();
  const before = service.get(task.id);
  db.exec(`CREATE TRIGGER fail_audit_insert BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'Simulated insert failure'); END;`);
  assert.throws(() => service.updateStatus(task.id, 'pending', 'john.doe'), /Simulated insert failure/);
  assert.deepEqual(service.get(task.id), before);
  assert.deepEqual(service.auditLogs(task.id), []);
});

test('database rejects UPDATE, DELETE, and replacement of audit rows', () => {
  const task = create();
  service.updateStatus(task.id, 'pending', 'john.doe');
  const before = service.auditLogs(task.id);
  assert.throws(() => db.prepare('UPDATE audit_logs SET actor = ? WHERE taskId = ?').run('jane.smith', task.id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM audit_logs WHERE taskId = ?').run(task.id), /immutable/);
  // REPLACE can implicitly delete a row, so it is also blocked at insertion.
  assert.throws(() => db.prepare(`INSERT INTO audit_logs (id, taskId, taskTitle, actor, fromStatus, toStatus, changedAt)
    VALUES (@id, @taskId, @taskTitle, @actor, @fromStatus, @toStatus, @changedAt)
    ON CONFLICT(id) DO UPDATE SET actor = excluded.actor`).run(before[0]), /immutable/);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO audit_logs (sequence, id, taskId, taskTitle, actor, fromStatus, toStatus, changedAt)
    VALUES (@sequence, @id, @taskId, @taskTitle, @actor, @fromStatus, @toStatus, @changedAt)`).run(before[0]), /immutable/);
  assert.deepEqual(service.auditLogs(task.id), before);
});

test('soft delete keeps logs accessible, hides the task, and rejects further status changes', async () => {
  const task = create();
  service.updateStatus(task.id, 'pending', 'john.doe');
  const logs = service.auditLogs(task.id);
  await request(app).delete(`/api/tasks/${task.id}`).expect(204);
  await request(app).delete(`/api/tasks/${task.id}`).expect(204);
  assert.equal(service.list().length, 0);
  const deleted = await request(app).get('/api/tasks?deleted=true').expect(200);
  assert.equal(deleted.body.tasks[0].id, task.id);
  assert.ok(deleted.body.tasks[0].deletedAt);
  const response = await request(app).get(`/api/tasks/${task.id}/audit-logs`).expect(200);
  assert.deepEqual(response.body.auditLogs, logs);
  await request(app).put(`/api/tasks/${task.id}/status`).send({ status: 'in_progress', actor: 'john.doe' }).expect(404);
  assert.throws(() => db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id), /FOREIGN KEY/);
});

test('returns consistent JSON errors for missing tasks, malformed JSON, and unknown endpoints', async () => {
  await request(app).get('/api/tasks/missing/audit-logs').expect(404);
  await request(app).delete('/api/tasks/missing').expect(404);
  await request(app).put('/api/tasks/missing/status').send({ status: 'pending', actor: 'john.doe' }).expect(404);
  const response = await request(app).post('/api/tasks').set('Content-Type', 'application/json').send('{broken').expect(400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
  await request(app).get('/api/unknown').expect(404);
  await request(app).get('/api/tasks?deleted=maybe').expect(400);
});

test('metadata matches valid statuses and actors', async () => {
  const response = await request(app).get('/api/meta').expect(200);
  assert.deepEqual(response.body.statuses, STATUSES);
  assert.deepEqual(response.body.actors, ACTORS);
});

test('rapid duplicate updates create only one audit event', async () => {
  const task = create();
  const responses = await Promise.all(Array.from({ length: 8 }, () => request(app).put(`/api/tasks/${task.id}/status`).send({ status: 'pending', actor: 'john.doe' })));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(responses.filter((response) => response.body.changed).length, 1);
  assert.equal(service.auditLogs(task.id).length, 1);
});

test('task data and immutable logs survive reopening a file database', () => {
  const folder = mkdtempSync(join(tmpdir(), 'mini-task-test-'));
  const filename = join(folder, 'tasks.sqlite');
  let fileDb: Database.Database | undefined;
  try {
    fileDb = openDatabase(filename);
    const first = new TaskService(fileDb);
    const task = first.create({ title: 'Persistent task', description: '' });
    first.updateStatus(task.id, 'pending', 'john.doe');
    const logs = first.auditLogs(task.id);
    fileDb.close();
    fileDb = openDatabase(filename);
    const second = new TaskService(fileDb);
    assert.equal(second.get(task.id).status, 'pending');
    assert.deepEqual(second.auditLogs(task.id), logs);
    assert.throws(() => fileDb!.exec('DELETE FROM audit_logs'), /immutable/);
  } finally {
    if (fileDb?.open) fileDb.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
