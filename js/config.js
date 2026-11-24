// =========================================================================
// CBT-TED — Konfigurasi Supabase
// Project: cbt-ted (pakgun10's Org, Singapore)
// URL sudah terverifikasi dari dashboard Supabase.
// Anon key: ambil di Supabase Dashboard -> Settings -> API -> anon public.
//   JANGAN pakai service_role key di file ini. Itu kunci master dan
//   tidak boleh terlihat oleh siswa / di-commit ke repo publik.
// =========================================================================
window.CBT_CONFIG = {
  supabaseUrl: 'https://jqbsnxqjgrmziteItppn.supabase.co',
  // Ganti 'PASTE_ANON_KEY_DI_SINI' dengan anon key project cbt-ted.
  supabaseAnonKey: 'sb_publishable_sLUIaDff2M0JSOPdOc7KIg_ANDw6MXC',

  // Durasi ujian (menit) dan KKM — samakan dengan schema.sql bila diubah.
  examDurationMinutes: 90,
  kkm: 75,
};
