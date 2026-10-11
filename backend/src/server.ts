import { resolve } from 'node:path';
import { createApp } from './app';
import { openDatabase } from './database';

const port = Number(process.env.PORT ?? 4000);
const db = openDatabase(process.env.DB_PATH ?? resolve(__dirname, '../data/tasks.sqlite'));
const server = createApp(db).listen(port, '127.0.0.1', () => {
  console.log(`API ready at http://localhost:${port}/api`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
