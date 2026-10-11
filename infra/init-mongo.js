const uri = 'mongodb://' + encodeURIComponent(process.env.MONGO_ADMIN_USER) + ':' + encodeURIComponent(process.env.MONGO_ADMIN_PASSWORD) + '@mongo:27017/admin?directConnection=true';
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const admin = new Mongo(uri).getDB('admin');
    const hello = admin.runCommand({ hello: 1 });
    if (!hello.setName) {
      const result = admin.runCommand({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] } });
      if (!result.ok && result.codeName !== 'AlreadyInitialized') throw new Error('Replica set initialization failed.');
    }
    if (admin.runCommand({ hello: 1 }).isWritablePrimary) { ready = true; break; }
  } catch { /* Retry while MongoDB finishes its first startup. */ }
  sleep(1000);
}
if (!ready) throw new Error('MongoDB primary was not ready within 60 seconds.');
print('MongoDB replica set ready.');
