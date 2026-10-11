import { MongoClient, type Db } from 'mongodb';

export interface DatabaseConnection {
  client: MongoClient;
  db: Db;
}

export const DEFAULT_MONGO_URI = 'mongodb://mini_app:dev_app_password@127.0.0.1:27017/mini_tasks?authSource=mini_tasks&replicaSet=rs0&directConnection=true';
export const DEFAULT_ADMIN_URI = 'mongodb://mini_admin:dev_admin_password@127.0.0.1:27017/admin?replicaSet=rs0&directConnection=true';

export function localMongoUri(host: string, name: string, username: string, password: string, authSource = name): string {
  const uri = new URL(`mongodb://${host}/${encodeURIComponent(name)}`);
  uri.username = username; uri.password = password;
  uri.searchParams.set('authSource', authSource);
  uri.searchParams.set('replicaSet', 'rs0');
  uri.searchParams.set('directConnection', 'true');
  return uri.toString();
}

export async function connectDatabase(uri: string, name: string): Promise<DatabaseConnection> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      throw new Error('MongoDB must run as a replica set or sharded cluster for atomic task/audit transactions.');
    }
    return { client, db: client.db(name) };
  } catch (error) {
    await client.close();
    throw error;
  }
}
