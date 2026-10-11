import { connectDatabase, DEFAULT_ADMIN_URI } from '../src/database';
import { configureCollections, provisionAppUser } from '../src/setup-database';

async function main() {
  const name = process.env.MONGO_DB_NAME ?? 'mini_tasks_e2e';
  if (name !== 'mini_tasks_e2e') throw new Error('E2E setup only permits the dedicated mini_tasks_e2e database.');
  const admin = await connectDatabase(process.env.TEST_MONGO_ADMIN_URI ?? DEFAULT_ADMIN_URI, name);
  try {
    await admin.db.dropDatabase();
    await configureCollections(admin.db);
    await provisionAppUser(admin.db, 'mini_app', 'dev_app_password');
  } finally { await admin.client.close(); }
  await import('../src/server');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
