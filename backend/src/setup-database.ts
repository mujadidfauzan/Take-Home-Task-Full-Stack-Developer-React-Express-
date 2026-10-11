import type { Db } from 'mongodb';
import { connectDatabase, DEFAULT_ADMIN_URI, localMongoUri } from './database';
import { ACTORS, STATUSES } from './domain';

export async function configureCollections(db: Db): Promise<void> {
  const schemas = {
    tasks: {
      bsonType: 'object', additionalProperties: false,
      required: ['_id', 'id', 'title', 'description', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'version'],
      properties: {
        _id: { bsonType: 'string' }, id: { bsonType: 'string' },
        title: { bsonType: 'string', minLength: 1, maxLength: 120 },
        description: { bsonType: 'string', maxLength: 2000 },
        status: { enum: [...STATUSES] },
        createdAt: { bsonType: 'string' }, updatedAt: { bsonType: 'string' },
        deletedAt: { bsonType: ['null', 'string'] }, version: { bsonType: ['int', 'long'], minimum: 0 }
      }
    },
    audit_logs: {
      bsonType: 'object', additionalProperties: false,
      required: ['_id', 'id', 'sequence', 'taskId', 'taskTitle', 'actor', 'fromStatus', 'toStatus', 'changedAt'],
      properties: {
        _id: { bsonType: 'string' }, id: { bsonType: 'string' },
        sequence: { bsonType: ['int', 'long'], minimum: 1 },
        taskId: { bsonType: 'string' }, taskTitle: { bsonType: 'string' },
        actor: { enum: [...ACTORS] }, fromStatus: { enum: [...STATUSES] }, toStatus: { enum: [...STATUSES] },
        changedAt: { bsonType: 'string' }
      }
    }
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const validator = name === 'audit_logs'
      ? { $and: [{ $jsonSchema: schema }, { $expr: { $or: STATUSES.slice(1).map((status, index) => ({ $and: [{ $eq: ['$fromStatus', STATUSES[index]] }, { $eq: ['$toStatus', status] }] })) } }] }
      : { $jsonSchema: schema };
    if (await db.listCollections({ name }).hasNext()) {
      await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    } else {
      await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
    }
  }
  await db.collection('tasks').createIndex({ id: 1 }, { unique: true });
  await db.collection('tasks').createIndex({ deletedAt: 1, createdAt: -1 });
  await db.collection('audit_logs').createIndex({ taskId: 1, sequence: 1 }, { unique: true });
  await db.collection('audit_logs').createIndex({ id: 1 }, { unique: true });
}

export async function provisionAppUser(db: Db, username: string, password: string): Promise<void> {
  const role = 'miniTaskApp';
  const privileges = [
    { resource: { db: db.databaseName, collection: 'tasks' }, actions: ['find', 'insert', 'update'] },
    { resource: { db: db.databaseName, collection: 'audit_logs' }, actions: ['find', 'insert'] }
  ];
  const roles = await db.command({ rolesInfo: role });
  await db.command(roles.roles.length ? { updateRole: role, privileges, roles: [] } : { createRole: role, privileges, roles: [] });
  const users = await db.command({ usersInfo: username });
  await db.command(users.users.length
    ? { updateUser: username, pwd: password, roles: [{ role, db: db.databaseName }] }
    : { createUser: username, pwd: password, roles: [{ role, db: db.databaseName }] });
}

async function main() {
  const uri = process.env.MONGO_SETUP_URI ?? (process.env.MONGO_HOST
    ? localMongoUri(process.env.MONGO_HOST, 'admin', process.env.MONGO_ADMIN_USER ?? 'mini_admin', process.env.MONGO_ADMIN_PASSWORD ?? 'dev_admin_password', 'admin')
    : DEFAULT_ADMIN_URI);
  const connection = await connectDatabase(uri, process.env.MONGO_DB_NAME ?? 'mini_tasks');
  try {
    await configureCollections(connection.db);
    if (process.env.MONGO_SETUP_CREATE_USER !== 'false') {
      await provisionAppUser(connection.db, process.env.MONGO_APP_USER ?? 'mini_app', process.env.MONGO_APP_PASSWORD ?? 'dev_app_password');
    }
    console.log(`MongoDB schema and indexes ready: ${connection.db.databaseName}`);
  } finally { await connection.client.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
