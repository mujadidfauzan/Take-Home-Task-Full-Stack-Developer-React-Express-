# Mini Task Manager

Aplikasi task untuk tim internal menggunakan React + TypeScript, Express + TypeScript, MongoDB, dan Redis. Setiap perubahan status mengikuti aturan domain dan memiliki audit log yang mencatat task, actor, status awal, status tujuan, serta waktu perubahan.

Update status dan penambahan audit log disimpan dalam satu transaksi MongoDB. Redis Pub/Sub dan Server-Sent Events (SSE) meneruskan notifikasi perubahan ke browser lain.

## Menjalankan frontend dan backend

### Docker

Prasyarat: Docker Engine/Docker Desktop dengan Docker Compose.

```bash
docker compose up -d --build
```

Aplikasi tersedia di **http://localhost:8080**. Frontend hasil build dan API dilayani oleh Express pada origin yang sama. Health check tersedia di http://localhost:8080/api/health.

Compose menjalankan MongoDB 8 sebagai replica set, Redis 7, inisialisasi database, dan aplikasi. Data MongoDB disimpan dalam named volume sehingga bertahan setelah container dibuat ulang.

```bash
# Melihat status dan log aplikasi
docker compose ps
docker compose logs -f app

# Menghentikan layanan tanpa menghapus volume data
docker compose down
```

Nilai development tersedia di [.env.example](.env.example). Compose memakai nilai default jika tidak ada file `.env`. Credential contoh hanya digunakan untuk development lokal. Port MongoDB dan Redis hanya diekspos ke loopback host.

### Development dengan Node.js

Prasyarat: Node.js **22.13 atau lebih baru**, npm, dan Docker Compose.

Jalankan seluruh perintah berikut dari direktori root:

```bash
npm ci
npm run infra:up
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:4000/api
- Health check: http://localhost:4000/api/health

`infra:up` membangun image untuk inisialisasi database dan menjalankan MongoDB/Redis. `dev` menjalankan frontend dan backend secara bersamaan dengan hot reload. Keduanya juga dapat dijalankan secara terpisah:

```bash
# Terminal pertama
npm run dev -w backend

# Terminal kedua
npm run dev -w frontend
```

Vite meneruskan request `/api`, termasuk SSE, ke backend. Jika port frontend terpakai, gunakan URL yang dicetak Vite. Port backend dapat diubah melalui `PORT`; sesuaikan `API_TARGET` pada proses frontend.

```bash
PORT=4001 npm run dev -w backend
API_TARGET=http://127.0.0.1:4001 npm run dev -w frontend
```

Environment variable untuk proses Node dibaca dari environment terminal; file `.env` hanya dimuat oleh Docker Compose.

| Variable          | Fungsi                                                     |
| ----------------- | ---------------------------------------------------------- |
| `MONGODB_URI`     | URI MongoDB dengan credential akun aplikasi                |
| `MONGO_DB_NAME`   | Nama database; default `mini_tasks`                        |
| `REDIS_URL`       | URI Redis; default development `redis://127.0.0.1:6379`    |
| `PORT`            | Port Express; default development `4000`                   |
| `API_TARGET`      | Target proxy Vite; default `http://127.0.0.1:4000`         |
| `MONGO_SETUP_URI` | URI akun administrasi untuk setup schema dan izin database |

Default development menggunakan akun `mini_app` yang diprovisikan oleh Compose. Jika credential Compose diubah, proses Node juga perlu memakai URI yang sesuai. Credential administrator hanya digunakan oleh proses setup, bukan server aplikasi.

`npm run build` menjalankan TypeScript check dan build frontend/backend. Dockerfile menggunakan hasil build tersebut untuk container production, dengan dependency development dikeluarkan dan proses berjalan sebagai user `node`.

## Fitur dan model data

- Create task dengan judul wajib (1-120 karakter setelah trim) dan deskripsi opsional (maksimal 2000 karakter).
- Daftar task aktif, status yang jelas, dan tombol untuk langkah berikutnya.
- Actor dipilih dari `john.doe`, `jane.smith`, atau `alex.chen`.
- Riwayat perubahan per task, termasuk task yang telah dihapus.
- Pembaruan daftar dan riwayat di browser lain tanpa refresh manual.
- Soft delete dengan akses ke task melalui tab **Terhapus**.

```text
to_do -> pending -> in_progress -> done
```

Task: `id`, `title`, `description`, `status`, `createdAt`, `updatedAt`, `deletedAt`, `version`.

Audit log: `id`, `sequence`, `taskId`, `taskTitle`, `actor`, `fromStatus`, `toStatus`, `changedAt`.

ID menggunakan UUID. Timestamp berasal dari backend dalam ISO 8601 UTC dan ditampilkan dalam waktu lokal browser. `version` meningkat pada perubahan task. `sequence` mengurutkan audit log per task, termasuk jika timestamp sama. Judul task disimpan sebagai snapshot di dalam log.

## Arsitektur

```text
frontend/src/
  App.tsx             Form, actor, daftar aktif/terhapus, dan refresh data
  TaskItem.tsx        Aksi per task dan tampilan audit log
  api.ts              Komunikasi HTTP dan penanganan error
  useRealtime.ts      SSE, reconnect, dan rekonsiliasi data
backend/src/
  app.ts              Route HTTP, SSE, static frontend, dan error handler
  domain.ts           Tipe domain, validasi input, dan aturan transisi
  task-service.ts     Operasi MongoDB dan transaksi task + audit
  database.ts         Koneksi MongoDB dan pemeriksaan replica set
  setup-database.ts   Validator, index, dan izin akun database
  realtime.ts         Redis publisher/subscriber
  server.ts           Startup dan graceful shutdown
infra/init-mongo.js    Inisialisasi replica set development
scripts/deploy-gcp.sh  Build dan deployment image ke Cloud Run
```

Alur perubahan status:

1. Route memvalidasi body, status, dan actor.
2. Transaksi membaca task terbaru dan memeriksa aturan transisi.
3. Status dan versi task diperbarui, lalu audit log ditambahkan dalam transaksi yang sama.
4. Setelah commit, notifikasi dipublikasikan ke Redis.
5. Setiap instance Express yang menerima notifikasi meneruskannya melalui SSE. Browser mengambil ulang data dari API.

Transaksi memakai `withTransaction`, snapshot read concern, dan majority write concern. Driver melakukan retry pada write conflict. Filter versi memastikan update memakai versi task yang telah dibaca. Transaksi MongoDB membutuhkan replica set atau sharded cluster. [Dokumentasi transaksi MongoDB](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)

Jika status tujuan sama dengan status saat ini, response berisi `changed: false` dan `auditLog: null`. Timestamp, versi task, dan log lama tidak berubah; notifikasi perubahan juga tidak dikirim. Actor tetap harus valid.

Redis bukan sumber data task maupun audit log. Jika notifikasi gagal dikirim, perubahan yang sudah commit tetap berhasil. Browser mengambil ulang data saat koneksi pulih, tab mendapat fokus, dan setiap 30 detik. Pembaruan latar belakang mempertahankan form serta riwayat yang sedang dibuka.

## API

| Method | Endpoint                    | Hasil                                  |
| ------ | --------------------------- | -------------------------------------- |
| GET    | `/api/health`               | Status koneksi MongoDB dan Redis       |
| GET    | `/api/meta`                 | Actor dan urutan status                |
| GET    | `/api/tasks`                | Task aktif                             |
| GET    | `/api/tasks?deleted=true`   | Task terhapus                          |
| POST   | `/api/tasks`                | Create task; HTTP 201                  |
| PUT    | `/api/tasks/:id/status`     | Update atau no-op; HTTP 200            |
| DELETE | `/api/tasks/:id`            | Soft delete; HTTP 204                  |
| GET    | `/api/tasks/:id/audit-logs` | Riwayat berurutan                      |
| GET    | `/api/events`               | Koneksi SSE untuk notifikasi perubahan |

```json
{ "title": "Prepare Invoice", "description": "Invoice untuk Oktober" }
```

Body update status:

```json
{ "status": "pending", "actor": "john.doe" }
```

Error menggunakan bentuk `{ "error": { "code": "...", "message": "..." } }`. HTTP 400 menandakan input invalid, 404 task/endpoint tidak ditemukan, 409 pelanggaran transisi atau konflik task, dan 413 body terlalu besar. Health check mengembalikan 503 jika dependency tidak tersedia.

## Asumsi

1. Task baru dimulai dari `to_do`; status hanya bisa maju satu langkah.
2. Audit log mencatat perubahan status. Create dan delete tidak membuat status-change log; penghapusan dicatat melalui `deletedAt`.
3. Task terhapus tidak dapat diubah, tetapi data dan log tetap tersedia. Delete berulang menghasilkan 204 tanpa perubahan tambahan.
4. Actor adalah pilihan identitas untuk demonstrasi; aplikasi tidak menyediakan autentikasi pengguna.
5. Edit judul/deskripsi, undo status, dan restore task berada di luar scope.
6. Idempotensi berlaku ketika status tujuan sama dengan status yang sedang tersimpan. Retry dari langkah lama setelah task maju lagi ditolak; belum ada idempotency key untuk replay lintas perubahan.
7. Replica set satu node pada Compose digunakan untuk development. Production memerlukan deployment MongoDB dengan tingkat ketersediaan yang sesuai.

## Trade-off

| Pilihan                     | Alasan dan konsekuensi                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| MongoDB dengan transaksi    | Memenuhi kebutuhan integrasi MongoDB dan menjaga status/log atomik; setup membutuhkan replica set dan koneksi eksternal.   |
| Redis Pub/Sub + SSE         | Mendukung notifikasi antarinstance dan browser melalui koneksi satu arah; tidak menyediakan penyimpanan atau replay event. |
| Refetch setelah notifikasi  | UI menggunakan data terbaru dari sumber utama; jumlah request meningkat ketika perubahan sering terjadi.                   |
| Soft delete                 | Mempertahankan task dan riwayat; penyimpanan terus bertambah.                                                              |
| Driver MongoDB langsung     | Query dan transaksi terlihat jelas tanpa ODM; service masih terkait dengan API driver.                                     |
| Satu image frontend/backend | Deployment memakai satu origin dan satu service; keduanya belum dapat dirilis atau diskalakan secara terpisah.             |

Redis Pub/Sub memiliki delivery at-most-once. Notifikasi dapat terlewat jika subscriber terputus atau proses berhenti setelah commit sebelum publish. Rekonsiliasi browser mengurangi data stale, tetapi bukan jaminan pengiriman event. [Dokumentasi Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)

## Jawaban teknis

### Bagaimana memastikan audit log tidak termodifikasi?

API hanya menyediakan pembacaan audit log dan service hanya menambahkan log baru. Akun MongoDB aplikasi memakai custom role dengan izin berikut:

| Collection   | Izin akun aplikasi         |
| ------------ | -------------------------- |
| `tasks`      | `find`, `insert`, `update` |
| `audit_logs` | `find`, `insert`           |

Akun tersebut tidak mempunyai izin update, delete, replace, drop collection, atau perubahan schema untuk audit log. Index unik mencegah duplikasi ID dan sequence per task. Validator database memeriksa struktur, actor, dan pasangan transisi yang valid.

Proses setup memakai credential administratif secara terpisah. Pada MongoDB Atlas, custom role harus dikonfigurasi melalui Atlas UI/API/CLI; akun runtime tidak diberi tambahan role `readWrite`. [Dokumentasi custom role Atlas](https://www.mongodb.com/docs/atlas/security-add-mongodb-roles/)

Pengujian mencoba update, delete, replace, dan drop melalui akun aplikasi, serta membuktikan rollback status ketika insert audit ditolak. Jaminan ini berlaku pada API dan izin akun runtime. Administrator database tetap memiliki kemampuan mengubah data atau izin; kebutuhan perlindungan terhadap administrator memerlukan penyimpanan audit eksternal dan kebijakan immutable.

### Bagian paling berisiko jika digunakan oleh banyak user?

Setiap browser mempertahankan koneksi SSE dan melakukan refetch setelah notifikasi. Tanpa pagination atau pembatasan frekuensi notifikasi, banyak user dan perubahan dapat meningkatkan koneksi, traffic API, dan query MongoDB. Write conflict juga dapat menambah retry transaksi.

Notifikasi Redis belum memakai durable outbox. Identitas actor belum terautentikasi, sehingga belum dapat dipakai sebagai bukti identitas yang dipercaya. Prioritas perbaikan adalah pagination, pengukuran latency/retry, observability koneksi realtime, dan autentikasi sesuai kebutuhan penggunaan.

### Bagian yang direfactor terlebih dahulu jika menjadi sistem besar?

Publikasi event setelah commit menjadi prioritas pertama untuk dipindahkan ke transactional outbox. Event disimpan bersama perubahan task dan audit dalam transaksi MongoDB, lalu worker mengirimkannya dengan retry. Hal ini menutup celah kehilangan notifikasi ketika proses berhenti di antara commit dan publish.

Berikutnya, akses MongoDB dipisahkan dari `TaskService` ke repository agar aturan domain lebih mudah diuji, disertai kontrak API bersama serta migrasi schema berversi.

## Pengujian

```bash
npm run infra:up
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Backend test memakai MongoDB replica set dan Redis sungguhan. Database test menggunakan nama acak dan akun dengan izin yang sama seperti aplikasi; credential administrator hanya digunakan untuk menyiapkan/membersihkan fixture. Endpoint dependency test dapat diubah melalui `TEST_MONGO_ADMIN_URI` dan `TEST_REDIS_URL`.

E2E menjalankan server di port 4100 dan frontend di port 5174. Database `mini_tasks_e2e` di-reset pada awal setiap run; database aplikasi `mini_tasks` tidak disentuh. Pastikan kedua port tersedia.

Validasi terakhir: **17 backend test lulus**, **8 browser test lulus** (4 skenario pada desktop/mobile), **build Docker berhasil**, dan container production memiliki health check MongoDB/Redis yang sehat. Pengujian mencakup transisi, idempotensi, rollback, izin audit, update bersamaan dari dua koneksi database, Redis antarinstance, SSE, kegagalan Redis, serta perubahan lintas browser.

## Migrasi data SQLite

Data versi SQLite dapat dipindahkan tanpa mengubah file sumber:

```bash
npm run migrate:sqlite -w backend
```

Script membaca `backend/data/tasks.sqlite` dalam mode read-only dan menyalin task beserta log dalam satu transaksi MongoDB. ID, sequence, actor, judul, status, dan timestamp asli dipertahankan. `version` ditambahkan pada task untuk melanjutkan urutan perubahan. Lokasi sumber alternatif dapat diberikan melalui `SQLITE_PATH`.

Migrasi tidak menimpa data. Jika ID sudah ada, transaksi dibatalkan seluruhnya. Perintah ini hanya diperlukan satu kali untuk data versi lama.

## Deployment Docker di GCP

Image disiapkan untuk **Cloud Run**: Express mendengarkan pada `0.0.0.0:$PORT`, melayani frontend hasil build, API, dan SSE. MongoDB serta Redis berjalan sebagai layanan eksternal, bukan volume di container Cloud Run.

Prasyarat deployment:

- Project GCP dengan billing aktif, Google Cloud CLI, dan akun deploy dengan izin build/deploy serta pengaturan IAM.
- Service account Cloud Build memiliki izin menulis image ke Artifact Registry dan menyimpan log build.
- MongoDB replica set/Atlas dan akun runtime dengan custom role audit seperti di atas.
- Schema/index sudah diprovisikan. Untuk Atlas, jalankan `db:setup` dengan `MONGO_SETUP_URI` dari akun setup dan `MONGO_SETUP_CREATE_USER=false`; user/role dibuat melalui Atlas.
- Redis yang dapat diakses Cloud Run, menggunakan URI TLS untuk layanan publik atau jaringan VPC untuk Memorystore.
- Secret Manager berisi `mini-task-mongodb-uri` dan `mini-task-redis-url`, masing-masing dengan versi aktif. Secret MongoDB berisi URI akun aplikasi, bukan administrator.
- Akses jaringan MongoDB/Redis sudah disesuaikan dengan egress Cloud Run.

```bash
gcloud auth login
PROJECT_ID=your-project-id npm run deploy:gcp
```

Script mengaktifkan API yang dibutuhkan, menyiapkan Artifact Registry dan service account runtime, memberikan akses ke dua secret, membangun image melalui Cloud Build, lalu melakukan deployment Cloud Run. Region default `asia-southeast2`.

Service bersifat private secara default. Untuk demo publik, `PUBLIC_DEMO=true` mengaktifkan akses tanpa IAM; aplikasi tetap tidak menyediakan auth pengguna. Jika Redis berada di VPC, sertakan `GCP_NETWORK` dan `GCP_SUBNET`. Nama secret, region, service, dan repository dapat diubah melalui environment variable di script.

**Status deployment GCP:** konfigurasi tersedia; deployment ke project GCP belum dilakukan. Build serta runtime Docker telah diverifikasi secara lokal.

## Jika ada waktu lebih

- Transactional outbox untuk retry pengiriman event.
- Pagination, filter status, pencarian, dan pembatasan refetch.
- Auth pengguna untuk menggantikan actor pilihan.
- Kontrak API bersama, migration runner, dan backup/restore MongoDB.
- CI untuk build, pengujian database, dan E2E.

## Penggunaan AI

AI digunakan untuk membantu implementasi kode dari arsitektur yang sudah ditentukan oleh saya, lalu AI juga membantu untuk menyusun pengujian yang dilakukan oleh saya sendiri.
