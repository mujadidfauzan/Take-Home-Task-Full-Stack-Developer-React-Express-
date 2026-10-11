# Mini Task Manager

Mini Task Manager adalah aplikasi untuk tim internal yang menggunakan React + TypeScript, Express + TypeScript, dan SQLite untuk mengelola task dan menelusuri perubahan statusnya.

Fokus solusi ini adalah memastikan setiap perubahan status mengikuti alur yang ditentukan dan memiliki riwayat yang menjelaskan siapa yang mengubahnya, status sebelum dan sesudah perubahan, serta waktunya. Status task dan audit log disimpan dalam satu transaksi agar keduanya tetap konsisten.

## Menjalankan proyek

Prasyarat: Node.js **22.12 atau lebih baru**, npm, dan terminal. Disarankan Node.js 22 LTS. SQLite berjalan sebagai file lokal; tidak perlu memasang server database.

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:4000/api
- Health check: http://localhost:4000/api/health

Vite meneruskan request `/api` ke backend sehingga frontend tidak memerlukan konfigurasi CORS. Jika port frontend sudah terpakai, ikuti URL yang dicetak Vite. Port backend dapat diubah lewat `PORT`; sesuaikan `API_TARGET` pada proses frontend.

Menjalankan secara terpisah, dari direktori root:

```bash
# Terminal pertama
npm run dev -w backend

# Terminal kedua
npm run dev -w frontend
```

Build dan mencoba hasil build:

```bash
npm run build

# Terminal pertama
npm run start -w backend

# Terminal kedua
npm run preview -w frontend
```

Preview frontend biasanya tersedia di http://localhost:4173 dan tetap memakai proxy `/api`. Vite preview digunakan untuk pemeriksaan lokal, bukan sebagai server production. Deployment production memerlukan static hosting untuk hasil build frontend dan reverse proxy `/api` ke Express.

Database dibuat otomatis di `backend/data/tasks.sqlite`. Data bertahan setelah restart dan file database tidak dimasukkan ke Git. `DB_PATH` dapat digunakan untuk lokasi alternatif. Environment variable dibaca dari proses; tidak ada pemuatan `.env` otomatis.

```bash
PORT=4001 DB_PATH=/tmp/my-tasks.sqlite npm run dev -w backend
API_TARGET=http://127.0.0.1:4001 npm run dev -w frontend
```

Dependency `better-sqlite3` memakai native binding. Jika platform tidak memiliki binary siap pakai, instalasinya memerlukan toolchain C/C++ dan Python untuk node-gyp. Versi dependency yang diuji tercatat dalam `package-lock.json`; setelah checkout gunakan `npm ci` untuk instalasi yang konsisten.

## Fitur dan model data

- Membuat task dengan judul wajib (1-120 karakter setelah trim) dan deskripsi opsional (maksimal 2000 karakter).
- Daftar task aktif dengan status dan tombol untuk status berikutnya.
- Actor dipilih dari `john.doe`, `jane.smith`, dan `alex.chen`.
- Riwayat per task menunjukkan judul task, actor, status awal, status tujuan, dan waktu.
- Menghapus task dari daftar aktif. Tab **Terhapus** tetap memberikan akses ke riwayat.

Alur status:

```text
to_do -> pending -> in_progress -> done
```

Task: `id`, `title`, `description`, `status`, `createdAt`, `updatedAt`, `deletedAt`.

Audit log: `sequence`, `id`, `taskId`, `taskTitle`, `actor`, `fromStatus`, `toStatus`, `changedAt`.

ID menggunakan UUID. Timestamp dibuat backend dalam ISO 8601 UTC; frontend menampilkannya dalam waktu lokal browser. `sequence` adalah nomor urut database dan menjadi pengurutan riwayat, termasuk jika dua log memiliki timestamp yang sama. Timestamp perubahan per task dijaga agar tidak mundur ketika jam server mundur.

## Arsitektur

Backend memisahkan route HTTP, aturan domain, operasi data, dan konfigurasi database agar alur perubahan status mudah diperiksa. Frontend menggunakan modul API terpisah, sementara aksi dan riwayat per task ditempatkan pada komponen `TaskItem`.

```text
frontend/src/
  App.tsx           Form, daftar task, actor, dan pilihan aktif/terhapus
  TaskItem.tsx      Aksi per task dan tampilan audit log
  api.ts            Komunikasi HTTP dan penanganan error
  types.ts          Kontrak data dan label status
backend/src/
  app.ts            Route HTTP, validasi input, dan error handler
  domain.ts         Tipe domain, actor, dan aturan transisi
  task-service.ts   Operasi data dan transaksi status + log
  database.ts       Schema, constraint, index, dan trigger SQLite
  server.ts         Database, HTTP server, dan shutdown
backend/test/       Pengujian integrasi HTTP dan database
e2e/                Pengujian alur pengguna desktop dan mobile
```

Alur update: route memvalidasi body dan actor, service membuka transaksi `BEGIN IMMEDIATE`, membaca task terbaru, memvalidasi transisi, memperbarui status, lalu menambahkan log. Kedua write berhasil bersama, atau keduanya dibatalkan jika terjadi error. Transaksi bersifat sinkron dan tidak mengandung `await`.

Jika status tujuan sama dengan status saat ini, service mengembalikan `changed: false` dan `auditLog: null`. Timestamp task dan log lama tidak berubah. Actor tetap harus valid, termasuk pada request idempotent.

## API

| Method | Endpoint                    | Hasil                                            |
| ------ | --------------------------- | ------------------------------------------------ |
| GET    | `/api/health`               | Health check                                     |
| GET    | `/api/meta`                 | Actor dan urutan status yang diizinkan           |
| GET    | `/api/tasks`                | Task aktif                                       |
| GET    | `/api/tasks?deleted=true`   | Task terhapus                                    |
| POST   | `/api/tasks`                | Membuat task; HTTP 201                           |
| PUT    | `/api/tasks/:id/status`     | Perubahan status atau hasil idempotent; HTTP 200 |
| DELETE | `/api/tasks/:id`            | Soft delete; HTTP 204                            |
| GET    | `/api/tasks/:id/audit-logs` | Riwayat berurutan, termasuk task terhapus        |

Contoh body create:

```json
{ "title": "Prepare Invoice", "description": "Invoice untuk Oktober" }
```

Contoh body update status:

```json
{ "status": "pending", "actor": "john.doe" }
```

Respons error konsisten:

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Cannot change status from to_do to done. Only the next status is allowed."
  }
}
```

HTTP 400 untuk input invalid, 404 untuk task/endpoint tidak ditemukan, 409 untuk transisi yang melanggar aturan, dan 413 untuk body terlalu besar. Update terhadap task terhapus menghasilkan 404. Delete berulang terhadap task yang sama menghasilkan 204 tanpa perubahan tambahan.

## Asumsi

1. Data task terdiri dari judul, deskripsi opsional, status, dan timestamp, dengan UUID sebagai identitasnya.
2. Task baru selalu dimulai dari `to_do`. Tidak ada edit judul/deskripsi, undo status, restore task, atau auth karena tidak diminta.
3. Audit log mencatat **perubahan status**. Create dan delete tidak membuat status-change log; penghapusan direkam di `deletedAt`.
4. Delete menggunakan soft delete supaya konteks task dan audit log tetap tersedia. Task terhapus tidak bisa diubah lagi.
5. Actor adalah identitas pilihan untuk demonstrasi, bukan bukti identitas terautentikasi.
6. Request berulang ke status yang sedang tersimpan dianggap no-op. Retry lama setelah task sudah maju lagi akan ditolak sebagai transisi mundur; belum ada idempotency key untuk replay lintas perubahan.
7. Penggunaan awal adalah tim kecil pada satu server dengan database lokal.

## Trade-off

- **SQLite dibanding JSON file:** transaksi, foreign key, dan trigger memberikan konsistensi serta perlindungan log yang jelas. Biayanya adalah dependency native dan sedikit SQL. Tidak diperlukan server database terpisah.
- **SQLite dibanding PostgreSQL:** setup lebih sederhana untuk take-home dan tim kecil, tetapi write terserialisasi dan file lokal tidak cocok untuk banyak instance di mesin berbeda.
- **Query sinkron:** membuat transaksi pendek mudah diperiksa dan menghindari interleaving di tengah operasi. Query yang besar akan memblokir event loop, sehingga perlu ditinjau untuk beban tinggi.
- **Soft delete:** menjaga log dan konteksnya, dengan konsekuensi data terus tumbuh. Tidak ada cascade delete audit log.
- **Validasi di backend:** aturan tetap berlaku saat API dipanggil tanpa UI. UI mengambil urutan status dari backend dan menyediakan tombol untuk langkah berikutnya.
- **Kontrak frontend/backend:** tipe API kecil ditulis pada kedua sisi tanpa generator atau shared build package. Jika kontrak berkembang, duplikasi ini perlu diganti dengan schema/API contract bersama.
- **UI sederhana:** form, daftar, dan expandable history cukup untuk kebutuhan inti; pagination dan realtime belum ditambahkan.

## Jawaban teknis

### Bagaimana memastikan audit log tidak termodifikasi?

API audit log hanya menyediakan operasi baca. Service menambahkan log baru melalui `INSERT`. Database memiliki trigger yang menolak `UPDATE`, `DELETE`, dan penggantian record lewat `INSERT OR REPLACE`/upsert. Foreign key menggunakan `ON DELETE RESTRICT`, dan penghapusan task dilakukan secara soft delete. Log menyimpan snapshot judul task.

Pengujiannya mencoba manipulasi SQL langsung, menguji log lama tetap sama setelah update/delete task, dan membuktikan status di-rollback ketika insert log gagal.

Batas jaminan ini adalah API dan schema yang dipakai aplikasi. Pemilik mesin/file SQLite tetap bisa menghapus file atau mengganti schema/trigger. Untuk produksi, perlindungan tambahan perlu berupa akses database terbatas, backup, dan penyimpanan audit eksternal dengan kebijakan immutable. Solusi ini tidak mengklaim perlindungan absolut terhadap administrator database.

### Bagian paling berisiko jika dipakai banyak user?

Write SQLite terserialisasi dan query `better-sqlite3` bersifat sinkron, sehingga banyak request atau query besar dapat menunda event loop. Daftar task/log juga belum dipaginasi. Frontend bisa menampilkan data lama jika user lain sudah mengubah task; backend selalu memvalidasi status terbaru, tetapi UI belum memiliki realtime update atau version check. Pilihan actor tanpa auth juga memungkinkan impersonation.

Prioritas perbaikan untuk penggunaan oleh banyak user adalah pengukuran beban, pagination, pemeriksaan versi task untuk mendeteksi konflik antaruser, serta identitas dari auth.

### Apa yang direfactor dulu jika menjadi sistem besar?

Refactor pertama adalah memisahkan operasi persistensi dari `TaskService` ke repository yang menangani akses database dan transaksi. Pemisahan ini memungkinkan perubahan database tanpa mengubah aturan domain dan kontrak API.

PostgreSQL dapat menggantikan SQLite ketika aplikasi memerlukan banyak instance atau kapasitas write yang lebih besar. Migrasi harus mempertahankan transaksi status dan audit log, aturan append-only, serta pengujian integritas. Prioritas berikutnya adalah kontrak API bersama dan migrasi schema berversi.

## Pengujian

```bash
# Integrasi HTTP dan database, tanpa server eksternal
npm test

# Type checking dan production build frontend/backend
npm run build

# Pengujian browser: instal Chromium satu kali
npx playwright install chromium
npm run test:e2e
```

Backend test menggunakan database terisolasi di memory dan file sementara untuk uji restart. E2E otomatis menjalankan backend di port 4100 dengan database memory, serta frontend di port 5174. Pastikan kedua port kosong. E2E tidak mengubah database aplikasi utama.

Pengujian mencakup: create dan validasi input; semua transisi valid/invalid; idempotensi semua status; actor invalid; rollback saat insert log gagal; immutable log; soft delete dan akses riwayat; error HTTP; request duplikat; persistensi saat database dibuka ulang; serta alur create-update-history-delete pada desktop/mobile dan konten panjang. Screenshot browser tersimpan di `test-results/` setelah E2E berjalan.

Hasil validasi implementasi: **13 backend test lulus**, **6 browser test lulus** (3 skenario pada desktop dan mobile), dan **production build frontend/backend berhasil**. Browser test juga memeriksa pemulihan setelah request daftar task gagal dan tidak adanya overflow horizontal pada konten panjang.

## Jika ada waktu lebih

- Menambahkan pagination, filter status, dan pencarian untuk memudahkan pengelolaan daftar task yang lebih besar.
- Menambahkan pemeriksaan versi task dan strategi refresh UI agar konflik antaruser lebih jelas.
- Menambahkan migrasi schema berversi dan prosedur backup/restore database.
- Menambahkan CI untuk menjalankan build, backend test, dan browser test pada setiap perubahan.
- Mengganti actor pilihan dengan identitas terautentikasi jika aplikasi digunakan di lingkungan production.

## Penggunaan AI

AI digunakan untuk membantu implementasi kode dari arsitektur yang sudah ditentukan oleh saya, lalu AI juga membantu untuk menyusun pengujian yang dilakukan oleh saya sendiri.
