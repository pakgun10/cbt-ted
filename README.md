# CBT-TED — CBT Matematika Kelas 9, SMP Negeri 2 Kotagajah

Aplikasi CBT satu halaman yang dipisah menjadi file-file kecil, dan
database-nya dipindah dari Firebase (file asli) ke **Supabase**
(project `cbt-ted`, Singapura).

```
cbt-ted/
├── index.html                  → struktur halaman saja
├── css/style.css               → semua CSS (dulu <style> di HTML)
├── js/config.js                → URL + anon key Supabase (ISI DULU)
├── js/app.js                   → semua logika (dulu <script type="module">)
├── supabase/schema.sql         → tabel + RLS + fungsi penilaian
├── supabase/seed-questions.sql → 40 soal (kunci sudah diacak A/B/C/D)
├── supabase/students-template.csv → contoh format roster siswa
└── README.md                   → file ini
```

## Yang berubah dari file asli

| Masalah di file asli | Perbaikan di versi ini |
|---|---|
| Firebase pakai `__firebase_config` yang hanya ada di AI Studio — di luar itu hasil hanya di memori | Supabase, URL + anon key di `js/config.js` |
| Daftar 352 siswa digenerate dari array nama (NIS/NISN palsu) | Siswa dimuat dari tabel `students`. Tabel kosong = login kosong, tidak ada nama palsu |
| Kunci jawaban + pembahasan ikut terkirim ke browser siswa | Soal ujian diambil dari view `questions_public` (tanpa kunci). Penilaian server-side lewat RPC `submit_exam` |
| Semua soal berkunci A (`answer: 0` × 40) | Opsi di seed diputar — kunci tersebar 10 A, 10 B, 10 C, 10 D (isi soal sama) |
| Password guru hardcode di file | Guru login Supabase Auth (email + password). Tidak ada password di kode |
| Refresh = jawaban hilang, timer hanya `setInterval` | Autosave ke `localStorage` + timer wall-clock (`endTime`). Refresh memulihkan sesi |
| Toast "tersimpan ke server" muncul walau cloud gagal | Sukses hanya bila RPC berhasil. Gagal = sesi tetap tersimpan lokal + antre kirim ulang otomatis |
| Skrip penekan error di awal file | Dihapus — error kini terlihat di console |
| Tanggal sertifikat = tanggal hari ini saat dibuka | Tanggal sertifikat = tanggal ujian yang tersimpan |

## Langkah setup (sekali saja, urut)

### 1. Jalankan schema.sql
Supabase Dashboard → **SQL Editor** → **New query** → tempel isi
`supabase/schema.sql` → **Run**. Ini membuat tabel `students`,
`questions`, `results`, `exam_settings`, view `questions_public`,
policy RLS, dan fungsi `submit_exam`.

### 2. Isi anon key di js/config.js
Dashboard → **Settings → API** → salin **Project URL** dan
**anon public key**. URL sudah terisi
(`https://jqbsnxqjgrmziteItppn.supabase.co`).
Ganti `PASTE_ANON_KEY_DI_SINI` dengan anon key tersebut.

> Jangan pernah pakai **service_role key** di file ini. Itu kunci master.

### 3. Jalankan seed-questions.sql
Di **SQL Editor** yang sama, tempel isi
`supabase/seed-questions.sql` → **Run**. 40 soal masuk ke tabel
`questions`. Cek dengan: `select count(*) from questions;` → harus 40.

### 4. Import roster siswa ASLI
Dashboard → **Table Editor** → tabel `students` → **Insert** →
**Import data from CSV**. Pakai format di
`supabase/students-template.csv` (header: `id,absen,kelas,nis,nisn,nama,jk,walas`).
`id` = kelas + nomor absen, contoh `9A-01`. Hapus 2 baris contoh sebelum
import, ganti dengan data asli 9A–9K.

### 5. Buat akun guru
Dashboard → **Authentication → Users → Add user** → isi email + password
guru (mis. Pak Teddy). **Matikan** "Send email confirmation" bila tidak
mau kirim email verifikasi, atau biarkan dan konfirmasi lewat email.
Akun inilah yang dipakai di tombol **Tool Guru**. Akun ini juga yang
boleh melihat kunci jawaban, mereset siswa, dan mengunci ujian.

### 6. Jalankan / hosting
File ini **bukan** satu file lagi — harus dijalankan sebagai satu folder.

- **Paling gampang (tanpa server):** hosting statis gratis — seret folder
  ini ke [Netlify Drop](https://app.netlify.com/drop), atau push ke
  GitHub lalu aktifkan GitHub Pages / Netlify.
- **Tes lokal:** dari dalam folder ini jalankan
  `python3 -m http.server 8000` lalu buka `http://localhost:8000`.
  Jangan hanya double-click `index.html` — beberapa browser membatasi
  script saat dibuka lewat `file://`.

## Alur tes sebelum dipakai ujian

1. Buka halaman, pilih kelas + nama (harus dari roster asli).
2. Kerjakan 2–3 soal, **refresh** halaman — jawaban harus kembali.
3. Kumpulkan, cek sertifikat muncul dan nilai benar.
4. Coba login lagi dengan siswa yang sama — harus muncul banner
   "Sudah Ujian" dan tombol mulai nonaktif.
5. Login Tool Guru dengan email/password langkah 5, cek rekap,
   export CSV, dan tombol Reset satu siswa.
6. Cek di Supabase **Table Editor → results**: harus ada 1 baris.

## Catatan keamanan (jujur)

- Portal sertifikat memang dirancang terbuka (siswa bisa mencari
  sertifikat dengan memilih kelas + nama, seperti file asli). Kalau
  Pak Tedy mau sertifikat hanya bisa dibuka pemiliknya, perlu login
  siswa — itu pengembangan berikutnya, bukan di versi ini.
- Anon key memang boleh terlihat di browser (itu desain Supabase),
  tapi yang melindunginya adalah RLS + RPC: anon **tidak bisa**
  membaca tabel `questions` (kunci), **tidak bisa** INSERT langsung
  ke `results` (nilai hanya lewat `submit_exam`), dan **tidak bisa**
  menghapus hasil atau mengubah kunci ujian — itu hanya guru login.
- Jangan commit `service_role key` atau data siswa asli ke repo publik.
  Repo `pakgun10/cbt-ted` sebaiknya **privat**.

## File asli

File tunggal Firebase yang dikonversi:
`cbt_matematikakelas9smpnegeri2kotagajah.html` (2.232 baris, 123 KB).
Soal dan pembahasan di seed diverifikasi 40/40 cocok dengan file asli.
