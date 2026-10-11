import { resolve } from 'node:path';
import { createApp } from './app';
import { connectDatabase, DEFAULT_MONGO_URI, localMongoUri } from './database';
import { RealtimeBus } from './realtime';
import { TaskService } from './task-service';

async function main() {
  if (process.env.NODE_ENV === 'production' && ((!process.env.MONGODB_URI && !(process.env.MONGO_HOST && process.env.MONGO_APP_USER && process.env.MONGO_APP_PASSWORD)) || !process.env.REDIS_URL)) {
    throw new Error('Production requires MongoDB credentials and REDIS_URL.');
  }
  const port = Number(process.env.PORT ?? 4000);
  const dbName = process.env.MONGO_DB_NAME ?? 'mini_tasks';
  const uri = process.env.MONGODB_URI ?? (process.env.MONGO_HOST
    ? localMongoUri(process.env.MONGO_HOST, dbName, process.env.MONGO_APP_USER ?? 'mini_app', process.env.MONGO_APP_PASSWORD ?? 'dev_app_password')
    : DEFAULT_MONGO_URI);
  const connection = await connectDatabase(uri, dbName);
  const realtime = new RealtimeBus(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', `mini-task:${dbName}:events`);
  try { await realtime.connect(); }
  catch (error) { await connection.client.close(); throw error; }
  const staticDir = process.env.NODE_ENV === 'production' ? resolve(__dirname, '../../frontend/dist') : undefined;
  const server = createApp(new TaskService(connection), realtime, staticDir).listen(port, '0.0.0.0', () => {
    console.log(`Task Manager ready at http://localhost:${port}`);
  });

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      realtime.close();
      await connection.client.close();
      clearTimeout(deadline);
    });
    server.closeAllConnections();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
