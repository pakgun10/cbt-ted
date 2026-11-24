-- =========================================================================
-- CBT-TED — Schema Supabase (project: cbt-ted)
-- Cara pakai: Supabase Dashboard -> SQL Editor -> New query -> tempel
-- seluruh isi file ini -> Run. Jalankan SEKALI, lalu jalankan
-- seed-questions.sql, lalu import roster siswa (lihat README.md).
-- Idempotent: aman dijalankan ulang (IF NOT EXISTS / OR REPLACE).
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. TABEL
-- -------------------------------------------------------------------------
create table if not exists public.students (
  id    text primary key,          -- contoh: '9A-01' (kelas + nomor absen)
  absen int  not null,
  kelas text not null,             -- '9A' .. '9K'
  nis   text not null,
  nisn  text not null,
  nama  text not null,
  jk    text not null,             -- 'Laki-laki' / 'Perempuan'
  walas text not null
);

create table if not exists public.questions (
  id          int primary key,
  topic       text not null,       -- SPLDV / Bangun Ruang Sisi Datar / Lingkaran / BRSL
  diff        text not null,       -- Mudah / Sedang / Sulit
  q           text not null,
  options     text[] not null,     -- 4 opsi, urutan ASLI (sebelum diacak di browser)
  answer_idx  int  not null,       -- 0..3, posisi jawaban benar di `options`
  explanation text not null
);

create table if not exists public.results (
  student_id  text primary key references public.students(id) on delete cascade,
  absen       int  not null,
  kelas       text not null,
  nis         text not null,
  nisn        text not null,
  nama        text not null,
  walas       text not null,
  correct     int  not null,
  wrong       int  not null,
  blank       int  not null,
  score       int  not null,       -- 0..100
  topic_stats jsonb not null default '{}'::jsonb,
  duration    text not null,       -- contoh: '42 menit 10 detik'
  cert_no     text not null,
  submitted_at timestamptz not null default now()
);

create table if not exists public.exam_settings (
  id         int primary key,
  is_locked  boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.exam_settings (id, is_locked) values (1, false)
  on conflict (id) do nothing;

-- -------------------------------------------------------------------------
-- 2. VIEW PUBLIK SOAL — tanpa kunci jawaban & pembahasan.
--    Inilah yang dibaca browser siswa. View ini sengaja security definer
--    (default Postgres): anon boleh SELECT view ini, tapi TIDAK boleh
--    SELECT tabel questions langsung (lihat policy di bawah).
-- -------------------------------------------------------------------------
create or replace view public.questions_public as
  select id, topic, diff, q, options
  from public.questions;

-- -------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
--    - students : siapa pun (anon) boleh baca — dipakai untuk login siswa.
--    - questions: HANYA guru login (authenticated) boleh baca — kunci aman.
--    - questions_public: anon + authenticated boleh baca.
--    - results  : anon boleh BACA (portal sertifikat, seperti desain asli),
--                 tapi TIDAK boleh INSERT langsung — nilai hanya masuk
--                 lewat fungsi submit_exam di bawah. Hapus hanya guru login.
--    - exam_settings: anon boleh baca status kunci; ubah hanya guru login.
-- -------------------------------------------------------------------------
alter table public.students      enable row level security;
alter table public.questions     enable row level security;
alter table public.results       enable row level security;
alter table public.exam_settings enable row level security;

drop policy if exists "students readable by anon" on public.students;
create policy "students readable by anon"
  on public.students for select to anon, authenticated using (true);

drop policy if exists "questions readable by teacher only" on public.questions;
create policy "questions readable by teacher only"
  on public.questions for select to authenticated using (true);

drop policy if exists "results readable by anon" on public.results;
create policy "results readable by anon"
  on public.results for select to anon, authenticated using (true);

drop policy if exists "results deletable by teacher only" on public.results;
create policy "results deletable by teacher only"
  on public.results for delete to authenticated using (true);

drop policy if exists "exam_settings readable by anon" on public.exam_settings;
create policy "exam_settings readable by anon"
  on public.exam_settings for select to anon, authenticated using (true);

drop policy if exists "exam_settings writable by teacher only" on public.exam_settings;
create policy "exam_settings writable by teacher only"
  on public.exam_settings for all to authenticated using (true) with check (true);

grant select on public.questions_public to anon, authenticated;

-- -------------------------------------------------------------------------
-- 4. FUNGSI PENILAIAN SERVER-SIDE — submit_exam
--    Dipanggil dari js/app.js: supabase.rpc('submit_exam', {...})
--    - Menolak bila siswa tidak ada, sudah pernah submit, atau ujian dikunci.
--    - Menghitung benar/salah/kosong + capaian per materi dari tabel
--      questions (kunci TIDAK pernah keluar dari server).
--    - Mengembalikan satu baris results sebagai jsonb.
--    SECURITY DEFINER: fungsi ini boleh INSERT ke results meski anon
--    tidak punya policy INSERT langsung (mencegah pemalsuan nilai).
-- -------------------------------------------------------------------------
create or replace function public.submit_exam(
  p_student_id text,
  p_answers    jsonb,   -- [{question_id: int, selected: int|null}, ...]
  p_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student students%rowtype;
  v_locked  boolean;
  v_total   int;
  v_correct int := 0;
  v_wrong   int := 0;
  v_blank   int := 0;
  v_score   int;
  v_stats   jsonb;
  v_elapsed int;
  v_duration text;
  v_cert_no text;
  v_row     results%rowtype;
begin
  select * into v_student from students where id = p_student_id;
  if not found then
    raise exception 'Siswa tidak ditemukan: %', p_student_id;
  end if;

  if exists (select 1 from results where student_id = p_student_id) then
    raise exception 'Siswa sudah menyelesaikan ujian';
  end if;

  select is_locked into v_locked from exam_settings where id = 1;
  if coalesce(v_locked, false) then
    raise exception 'Ujian sedang dikunci guru';
  end if;

  select count(*) into v_total from questions;

  -- Hitung benar / salah / kosong dari jawaban yang dikirim.
  select
    coalesce(sum(case when a.selected is null then 1 else 0 end), 0),
    coalesce(sum(case when a.selected is not null and a.selected = q.answer_idx then 1 else 0 end), 0),
    coalesce(sum(case when a.selected is not null and a.selected <> q.answer_idx then 1 else 0 end), 0)
  into v_blank, v_correct, v_wrong
  from (
    select (elem->>'question_id')::int as question_id,
           (elem->>'selected')::int   as selected
    from jsonb_array_elements(p_answers) as elem
  ) a
  join questions q on q.id = a.question_id;

  -- Capaian per materi.
  select jsonb_object_agg(topic, jsonb_build_object('total', total, 'correct', correct))
  into v_stats
  from (
    select q.topic as topic,
           count(*) as total,
           coalesce(sum(case when a.selected = q.answer_idx then 1 else 0 end), 0) as correct
    from (
      select (elem->>'question_id')::int as question_id,
             (elem->>'selected')::int   as selected
      from jsonb_array_elements(p_answers) as elem
    ) a
    join questions q on q.id = a.question_id
    group by q.topic
  ) s;
  v_stats := coalesce(v_stats, '{}'::jsonb);

  v_score := case when v_total > 0
    then round(v_correct::numeric / v_total * 100)::int else 0 end;
  v_elapsed := greatest(1, extract(epoch from (now() - p_started_at))::int);
  v_duration := (v_elapsed / 60)::text || ' menit ' || (v_elapsed % 60)::text || ' detik';
  v_cert_no := 'CBT-MTK9/' || v_student.kelas || '/' || v_student.nis || '/' || extract(year from now())::text;

  insert into results (
    student_id, absen, kelas, nis, nisn, nama, walas,
    correct, wrong, blank, score, topic_stats, duration, cert_no
  ) values (
    v_student.id, v_student.absen, v_student.kelas, v_student.nis, v_student.nisn,
    v_student.nama, v_student.walas,
    v_correct, v_wrong, v_blank, v_score, v_stats, v_duration, v_cert_no
  )
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

grant execute on function public.submit_exam(text, jsonb, timestamptz) to anon, authenticated;
