import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../src/app';
import { connectDatabase, DEFAULT_ADMIN_URI, type DatabaseConnection } from '../src/database';
import { ACTORS, STATUSES } from '../src/domain';
import { configureCollections, provisionAppUser } from '../src/setup-database';
import { RealtimeBus, type TaskEvent } from '../src/realtime';
import { TaskService, type AuditDocument } from '../src/task-service';

const databaseName = `mini_tasks_test_${randomUUID().replaceAll('-', '')}`;
const adminUri = process.env.TEST_MONGO_ADMIN_URI ?? DEFAULT_ADMIN_URI;
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const channel = `mini-task:${databaseName}:events`;
let admin: DatabaseConnection;
let connection: DatabaseConnection;
let service: TaskService;
let realtime: RealtimeBus;
let app: ReturnType<typeof createApp>;
let appUri: string;

before(async () => {
  admin = await connectDatabase(adminUri, databaseName);
  await configureCollections(admin.db);
  await provisionAppUser(admin.db, 'mini_app', 'test_app_password');
  const url = new URL(adminUri);
  url.username = 'mini_app'; url.password = 'test_app_password'; url.pathname = `/${databaseName}`;
  url.searchParams.set('authSource', databaseName);
  appUri = url.toString();
  connection = await connectDatabase(appUri, databaseName);
  service = new TaskService(connection);
  realtime = new RealtimeBus(redisUrl, channel);
  await realtime.connect();
  app = createApp(service, realtime);
});
beforeEach(async () => {
  await admin.db.collection('audit_logs').deleteMany({});
  await admin.db.collection('tasks').deleteMany({});
});
after(async () => {
  realtime?.close();
  await connection?.client.close();
  if (admin) {
    await admin.db.command({ dropAllUsersFromDatabase: 1 });
    await admin.db.command({ dropAllRolesFromDatabase: 1 });
    await admin.db.dropDatabase();
    await admin.client.close();
  }
});
const create = () => service.create({ title: 'Prepare Invoice', description: 'Invoice for October' });

test('creates a trimmed task in to_do, without a status-change log', async () => {
  const response = await request(app).post('/api/tasks').send({ title: '  Prepare Invoice  ', description: ' Details ' }).expect(201);
  assert.equal(response.body.task.title, 'Prepare Invoice');
  assert.equal(response.body.task.description, 'Details');
  assert.equal(response.body.task.status, 'to_do');
  assert.equal(response.body.task.deletedAt, null);
  assert.equal(response.body.task.version, 0);
  const list = await request(app).get('/api/tasks').expect(200);
  assert.equal(list.body.tasks.length, 1);
  assert.deepEqual(await service.auditLogs(response.body.task.id), []);
});

test('rejects invalid create bodies at the API boundary', async () => {
  for (const body of [{}, { title: '   ' }, { title: 123 }, { title: 'a'.repeat(121) }, { title: 'Valid', description: false }, { title: 'Valid', description: 'a'.repeat(2001) }, []]) {
    const response = await request(app).post('/api/tasks').send(body).expect(400);
    assert.equal(response.body.error.code, 'INVALID_INPUT');
  }
  assert.equal((await service.list()).length, 0);
});

test('records all forward transitions with actor, task snapshot, and chronological order', async () => {
  const task = await create();
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
  const task = await create();
  for (const [index, status] of STATUSES.entries()) {
    if (index > 0) await service.updateStatus(task.id, status, 'john.doe');
    const beforeTask = await service.get(task.id);
    const beforeLogs = await service.auditLogs(task.id);
    for (let retry = 0; retry < 2; retry++) {
      const response = await request(app).put(`/api/tasks/${task.id}/status`).send({ status, actor: 'jane.smith' }).expect(200);
      assert.equal(response.body.changed, false);
      assert.equal(response.body.auditLog, null);
      assert.deepEqual(response.body.task, beforeTask);
    }
    assert.deepEqual(await service.auditLogs(task.id), beforeLogs);
  }
});

test('rejects every skipped or backward transition without changing task or logs', async () => {
  for (const [fromIndex, fromStatus] of STATUSES.entries()) {
    const task = await create();
    for (const status of STATUSES.slice(1, fromIndex + 1)) await service.updateStatus(task.id, status, 'john.doe');
    const beforeTask = await service.get(task.id);
    const logs = await service.auditLogs(task.id);
    for (const [toIndex, toStatus] of STATUSES.entries()) {
      if (toStatus === fromStatus || toIndex === fromIndex + 1) continue;
      const response = await request(app).put(`/api/tasks/${task.id}/status`).send({ status: toStatus, actor: 'john.doe' }).expect(409);
      assert.equal(response.body.error.code, 'INVALID_TRANSITION');
      assert.deepEqual(await service.get(task.id), beforeTask);
      assert.deepEqual(await service.auditLogs(task.id), logs);
    }
  }
});

test('rejects unknown status or actor, even for a same-status request', async () => {
  const task = await create();
  for (const body of [{ status: 'cancelled', actor: 'john.doe' }, { status: 'pending', actor: 'unknown' }, { status: 'to_do', actor: 'unknown' }, { status: 'pending' }, { status: ['pending'], actor: 'john.doe' }]) {
    await request(app).put(`/api/tasks/${task.id}/status`).send(body).expect(400);
  }
  assert.equal((await service.get(task.id)).status, 'to_do');
  assert.equal((await service.auditLogs(task.id)).length, 0);
});

test('rolls back the task update when the audit collection rejects insertion', async () => {
  const task = await create();
  const beforeTask = await service.get(task.id);
  await admin.db.command({ collMod: 'audit_logs', validator: { $expr: { $eq: [1, 0] } } });
  try {
    await assert.rejects(service.updateStatus(task.id, 'pending', 'john.doe'), { code: 121 });
    assert.deepEqual(await service.get(task.id), beforeTask);
    assert.deepEqual(await service.auditLogs(task.id), []);
  } finally { await configureCollections(admin.db); }
});

test('application database account cannot update, delete, replace, or drop audit logs', async () => {
  const task = await create();
  await service.updateStatus(task.id, 'pending', 'john.doe');
  const beforeLogs = await service.auditLogs(task.id);
  const logs = connection.db.collection<AuditDocument>('audit_logs');
  await assert.rejects(logs.updateOne({ taskId: task.id }, { $set: { actor: 'jane.smith' } }), { code: 13 });
  await assert.rejects(logs.deleteMany({ taskId: task.id }), { code: 13 });
  await assert.rejects(logs.replaceOne({ _id: beforeLogs[0].id }, { _id: beforeLogs[0].id, ...beforeLogs[0] }), { code: 13 });
  await assert.rejects(logs.drop(), { code: 13 });
  assert.deepEqual(await service.auditLogs(task.id), beforeLogs);
});

test('database validators reject invalid transitions and duplicate audit sequences', async () => {
  const task = await create();
  await service.updateStatus(task.id, 'pending', 'john.doe');
  const logs = await service.auditLogs(task.id);
  const collection = connection.db.collection<AuditDocument>('audit_logs');
  const invalidId = randomUUID();
  await assert.rejects(collection.insertOne({ ...logs[0], _id: invalidId, id: invalidId, sequence: 10, toStatus: 'done' }), { code: 121 });
  const duplicateId = randomUUID();
  await assert.rejects(collection.insertOne({ ...logs[0], _id: duplicateId, id: duplicateId }), { code: 11000 });
  assert.deepEqual(await service.auditLogs(task.id), logs);
});

test('soft delete keeps logs accessible, hides tasks, and rejects further changes', async () => {
  const task = await create();
  await service.updateStatus(task.id, 'pending', 'john.doe');
  const logs = await service.auditLogs(task.id);
  await request(app).delete(`/api/tasks/${task.id}`).expect(204);
  await request(app).delete(`/api/tasks/${task.id}`).expect(204);
  assert.equal((await service.list()).length, 0);
  const deleted = await request(app).get('/api/tasks?deleted=true').expect(200);
  assert.equal(deleted.body.tasks[0].id, task.id);
  assert.ok(deleted.body.tasks[0].deletedAt);
  const response = await request(app).get(`/api/tasks/${task.id}/audit-logs`).expect(200);
  assert.deepEqual(response.body.auditLogs, logs);
  await request(app).put(`/api/tasks/${task.id}/status`).send({ status: 'in_progress', actor: 'john.doe' }).expect(404);
  await assert.rejects(connection.db.collection('tasks').deleteOne({ id: task.id }), { code: 13 });
});

test('returns JSON errors for missing tasks, malformed JSON, and unknown endpoints', async () => {
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

test('concurrent duplicate updates create only one log across independent connections', async () => {
  const peer = await connectDatabase(appUri, databaseName);
  try {
    const task = await create();
    const secondService = new TaskService(peer);
    const results = await Promise.all(Array.from({ length: 8 }, (_value, index) => (index % 2 ? secondService : service).updateStatus(task.id, 'pending', 'john.doe')));
    assert.equal(results.filter((result) => result.changed).length, 1);
    assert.equal((await service.auditLogs(task.id)).length, 1);
    assert.equal((await service.get(task.id)).version, 1);
  } finally { await peer.client.close(); }
});

test('task data and immutable logs survive reconnecting the database client', async () => {
  const task = await create();
  await service.updateStatus(task.id, 'pending', 'john.doe');
  const logs = await service.auditLogs(task.id);
  await connection.client.close();
  connection = await connectDatabase(appUri, databaseName);
  service = new TaskService(connection);
  app = createApp(service, realtime);
  assert.equal((await service.get(task.id)).status, 'pending');
  assert.deepEqual(await service.auditLogs(task.id), logs);
  await assert.rejects(connection.db.collection('audit_logs').deleteMany({}), { code: 13 });
});

test('Redis broadcasts committed updates across application instances and ignores no-ops', async () => {
  const peer = new RealtimeBus(redisUrl, channel);
  await peer.connect();
  const events: TaskEvent[] = [];
  const unsubscribe = peer.subscribe((event) => events.push(event));
  try {
    const task = await create();
    await request(app).put(`/api/tasks/${task.id}/status`).send({ status: 'pending', actor: 'john.doe' }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'task.updated');
    assert.equal(events[0].taskId, task.id);
    assert.equal((await service.auditLogs(task.id)).length, 1);
    await request(app).put(`/api/tasks/${task.id}/status`).send({ status: 'pending', actor: 'jane.smith' }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(events.length, 1);
  } finally { unsubscribe(); peer.close(); }
});

test('SSE exposes connection state and committed status events to a browser client', async () => {
  const task = await create();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let data = decoder.decode((await reader.read()).value);
    assert.match(data, /event: connection/);
    await request(app).put(`/api/tasks/${task.id}/status`).send({ status: 'pending', actor: 'john.doe' }).expect(200);
    while (!data.includes('event: task-change')) data += decoder.decode((await reader.read()).value);
    assert.match(data, /task.updated/);
    assert.ok(data.includes(task.id));
    assert.equal((await service.auditLogs(task.id)).length, 1);
    await reader.cancel();
  } finally {
    clearTimeout(deadline); controller.abort();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

test('Redis unavailability does not undo or fail a committed status change', async () => {
  const task = await create();
  realtime.close();
  try {
    await request(app).put(`/api/tasks/${task.id}/status`).send({ status: 'pending', actor: 'john.doe' }).expect(200);
    assert.equal((await service.get(task.id)).status, 'pending');
    assert.equal((await service.auditLogs(task.id)).length, 1);
    const health = await request(app).get('/api/health').expect(503);
    assert.equal(health.body.redis, 'unavailable');
  } finally {
    realtime = new RealtimeBus(redisUrl, channel);
    await realtime.connect();
    app = createApp(service, realtime);
  }
});
