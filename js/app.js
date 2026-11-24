/* =========================================================================
   CBT-TED — Matematika Kelas 9, SMP Negeri 2 Kotagajah
   Versi Supabase (konversi dari file tunggal Firebase).
   Struktur: index.html + css/style.css + js/config.js + js/app.js

   Perbaikan terhadap file asli (lihat README.md):
   1. Firebase (__firebase_config) diganti Supabase — js/config.js.
   2. Roster siswa TIDAK digenerate lagi. Siswa dimuat dari tabel `students`.
      Kalau tabel kosong, login tidak menampilkan nama palsu.
   3. Kunci jawaban TIDAK dikirim ke browser siswa. Soal ujian diambil dari
      view `questions_public` (tanpa answer_idx / explanation). Penilaian
      dilakukan server-side oleh fungsi RPC `submit_exam`.
   4. Password guru TIDAK hardcode lagi. Guru login dengan Supabase Auth
      (email + password, dibuat di Dashboard -> Authentication).
   5. Sesi ujian di-autosave ke localStorage + timer memakai wall-clock
      (endTime), jadi refresh / tab tertutup tidak menghilangkan jawaban.
   6. Toast sukses hanya tampil bila Supabase benar-benar menyimpan hasil.
      Kalau gagal, sesi tetap tersimpan lokal dan bisa dikirim ulang.
   7. Skrip penekan error di file asli dihapus — error kini terlihat.
   ========================================================================= */
'use strict';

/* -------------------------------------------------------------------------
   1. STATE & INISIALISASI SUPABASE
   ------------------------------------------------------------------------- */
const CFG = window.CBT_CONFIG || {};
const SESSION_KEY = 'cbt-ted-session-v1';
const PENDING_KEY = 'cbt-ted-pending-v1';

let supabaseClient = null;
let supabaseReady = false;
let isTeacher = false;

let CLASS_CONFIG = {};        // { '9A': { count, walas }, ... } — dari DB
let STUDENTS_BY_CLASS = {};   // { '9A': [student, ...] }
let ALL_STUDENTS_MAP = {};    // { '9A-01': student }
let QUESTION_BANK_FULL = [];  // hanya untuk guru (tabel questions, ada kunci)
let examResults = {};         // { studentId: resultNormal }
let isExamLocked = false;
let selectedStudent = null;
let currentExamSession = null;
let timerInterval = null;
let currentFontSize = 'text-base';
let activeCertResult = null;
let modalConfirmCallback = null;

function isConfigReady() {
  return Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey &&
    CFG.supabaseAnonKey !== 'PASTE_ANON_KEY_DI_SINI' &&
    !CFG.supabaseAnonKey.includes('PASTE_'));
}

function showSupabaseStatus(message, isError) {
  const el = document.getElementById('supabase-status');
  if (!el) return;
  if (!message) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = message;
  el.className = isError
    ? 'mb-4 p-3.5 rounded-xl bg-rose-50 border border-rose-300 text-rose-900 text-xs sm:text-sm'
    : 'mb-4 p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-xs sm:text-sm';
}

function updateSyncBadge(statusText, isOnline) {
  const badge = document.getElementById('sync-badge');
  const textEl = document.getElementById('sync-text');
  if (!badge || !textEl) return;
  badge.classList.remove('hidden');
  const dot = badge.querySelector('span.rounded-full');
  if (dot) {
    dot.className = isOnline
      ? 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse'
      : 'w-2 h-2 rounded-full bg-amber-400';
  }
  textEl.textContent = statusText;
}

/* Normalisasi satu baris tabel `results` (snake_case) ke bentuk aplikasi. */
function normalizeResult(row) {
  if (!row) return null;
  const submittedAt = row.submitted_at || row.submittedAt || null;
  const ts = row.timestamp || (submittedAt
    ? new Date(submittedAt).toLocaleString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB'
    : '-');
  return {
    studentId: row.student_id || row.studentId,
    absen: row.absen,
    kelas: row.kelas,
    nis: row.nis,
    nisn: row.nisn,
    nama: row.nama,
    walas: row.walas,
    correct: row.correct,
    wrong: row.wrong,
    blank: row.blank,
    score: row.score,
    topicStats: row.topic_stats || row.topicStats || {},
    duration: row.duration,
    timestamp: ts,
    submittedAt: submittedAt ? Date.parse(submittedAt) : (row.submittedAt || null),
    certNo: row.cert_no || row.certNo,
  };
}

function rebuildClassOptions() {
  const sel = document.getElementById('select-kelas');
  if (!sel) return;
  const prev = sel.value;
  const classes = Object.keys(STUDENTS_BY_CLASS).sort();
  if (classes.length === 0) return; // biarkan opsi HTML asli bila DB belum terisi
  sel.innerHTML = '<option value="">-- Kelas --</option>' +
    classes.map(k => `<option value="${k}">Kelas ${k} (${STUDENTS_BY_CLASS[k].length})</option>`).join('');
  if (prev && STUDENTS_BY_CLASS[prev]) sel.value = prev;
}

async function loadStudents() {
  const { data, error } = await supabaseClient
    .from('students').select('id,absen,kelas,nis,nisn,nama,jk,walas')
    .order('kelas').order('absen');
  if (error) throw new Error('Gagal memuat daftar siswa: ' + error.message);
  STUDENTS_BY_CLASS = {};
  ALL_STUDENTS_MAP = {};
  CLASS_CONFIG = {};
  (data || []).forEach(s => {
    (STUDENTS_BY_CLASS[s.kelas] = STUDENTS_BY_CLASS[s.kelas] || []).push(s);
    ALL_STUDENTS_MAP[s.id] = s;
  });
  Object.entries(STUDENTS_BY_CLASS).forEach(([kelas, list]) => {
    CLASS_CONFIG[kelas] = { count: list.length, walas: list[0] ? list[0].walas : '-' };
  });
  rebuildClassOptions();
  return (data || []).length;
}

async function loadResults() {
  const { data, error } = await supabaseClient
    .from('results').select('*').order('submitted_at', { ascending: false });
  if (error) throw new Error('Gagal memuat hasil ujian: ' + error.message);
  examResults = {};
  (data || []).forEach(row => {
    const r = normalizeResult(row);
    if (r && r.studentId) examResults[r.studentId] = r;
  });
  return Object.keys(examResults).length;
}

async function loadExamSettings() {
  const { data, error } = await supabaseClient
    .from('exam_settings').select('is_locked').eq('id', 1).maybeSingle();
  if (error) throw new Error('Gagal memuat status ujian: ' + error.message);
  isExamLocked = Boolean(data && data.is_locked);
  updateExamLockUI();
}

async function initSupabase() {
  if (!window.supabase || !window.supabase.createClient) {
    showSupabaseStatus('Library Supabase gagal dimuat (CDN tidak terjangkau). Periksa koneksi internet, lalu muat ulang halaman.', true);
    updateSyncBadge('Supabase tidak terjangkau', false);
    return;
  }
  if (!isConfigReady()) {
    showSupabaseStatus('Supabase belum dikonfigurasi: isi supabaseAnonKey di js/config.js dengan anon key project cbt-ted (Settings → API). Lihat README.md langkah 2.', true);
    updateSyncBadge('Supabase belum dikonfigurasi', false);
    return;
  }
  try {
    supabaseClient = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    const { data: sess } = await supabaseClient.auth.getSession();
    isTeacher = Boolean(sess && sess.session);

    const totalStudents = await loadStudents();
    const doneCount = await loadResults();
    await loadExamSettings();
    supabaseReady = true;

    if (totalStudents === 0) {
      showSupabaseStatus('Supabase terhubung, tapi tabel students masih kosong. Import roster asli Pak Tedy dulu (lihat README.md langkah 4) — nama siswa tidak digenerate lagi.', true);
    } else {
      showSupabaseStatus('');
      updateSyncBadge(`Supabase Aktif • ${doneCount}/${totalStudents} Selesai`, true);
    }

    // Realtime: perubahan hasil / kunci ujian dari perangkat lain.
    supabaseClient.channel('cbt-ted')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results' }, async () => {
        await loadResults();
        refreshLoginDropdowns();
        if (!document.getElementById('view-teacher').classList.contains('hidden')) {
          updateTeacherStats(); renderTeacherTable();
        }
        const total = Object.keys(ALL_STUDENTS_MAP).length;
        updateSyncBadge(`Supabase Aktif • ${Object.keys(examResults).length}/${total} Selesai`, true);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_settings' }, async () => {
        await loadExamSettings();
      })
      .subscribe();

    restoreSession();
    // Kirim ulang hasil yang sempat gagal tersimpan (pending) bila ada.
    await flushPendingResults();
  } catch (err) {
    console.error('Supabase init error:', err);
    showSupabaseStatus('Gagal terhubung ke Supabase: ' + err.message + ' Periksa anon key di js/config.js dan pastikan schema.sql sudah dijalankan.', true);
    updateSyncBadge('Koneksi Supabase Terbatas', false);
  }
}

function refreshLoginDropdowns() {
  const kelas = document.getElementById('select-kelas') ? document.getElementById('select-kelas').value : '';
  if (kelas) {
    const prevSiswa = document.getElementById('select-siswa') ? document.getElementById('select-siswa').value : '';
    handleClassChange(kelas);
    if (prevSiswa && document.getElementById('select-siswa')) {
      document.getElementById('select-siswa').value = prevSiswa;
      handleStudentChange(prevSiswa);
    }
  }
  const lookupKelas = document.getElementById('cert-lookup-kelas') ? document.getElementById('cert-lookup-kelas').value : '';
  if (lookupKelas) handleCertLookupClassChange(lookupKelas);
}

async function saveExamLockToCloud(lockedState) {
  isExamLocked = lockedState;
  updateExamLockUI();
  if (!supabaseClient || !isTeacher) return;
  const { error } = await supabaseClient
    .from('exam_settings').upsert({ id: 1, is_locked: lockedState });
  if (error) {
    console.error('Gagal menyimpan status kunci ujian:', error);
    showToast('Gagal menyimpan status kunci ke Supabase.', 'error');
  }
}

async function deleteStudentResultFromCloud(studentId) {
  delete examResults[studentId];
  if (!supabaseClient || !isTeacher) return;
  const { error } = await supabaseClient.from('results').delete().eq('student_id', studentId);
  if (error) console.error('Gagal menghapus data siswa:', error);
}

async function deleteAllResultsFromCloud() {
  const ids = Object.keys(examResults);
  examResults = {};
  if (!supabaseClient || !isTeacher) return;
  // Hapus per baris agar RLS/policy tetap dipatuhi; 352 baris masih ringan.
  for (const id of ids) {
    const { error } = await supabaseClient.from('results').delete().eq('student_id', id);
    if (error) { console.error('Gagal mereset:', id, error); break; }
  }
}

/* -------------------------------------------------------------------------
   2. UI HELPERS: TOAST, MODAL, NAVIGASI VIEW, & STATUS KUNCI UJIAN
   ------------------------------------------------------------------------- */
function showToast(message, type) {
  type = type || 'info';
  const container = document.getElementById('toast-container');
  if (!container) return;
  const colors = {
    success: 'bg-emerald-600 text-white border-emerald-700',
    warning: 'bg-amber-500 text-slate-950 border-amber-600',
    error: 'bg-rose-600 text-white border-rose-700',
    info: 'bg-brand-800 text-white border-brand-900'
  };
  const icons = {
    success: 'fa-circle-check',
    warning: 'fa-triangle-exclamation',
    error: 'fa-circle-xmark',
    info: 'fa-circle-info'
  };
  const toast = document.createElement('div');
  toast.className = 'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl border text-xs sm:text-sm font-bold transition-all transform translate-y-0 opacity-100 ' + (colors[type] || colors.info);
  const span = document.createElement('span');
  span.textContent = message;
  const icon = document.createElement('i');
  icon.className = 'fa-solid ' + (icons[type] || icons.info) + ' text-base';
  toast.appendChild(icon); toast.appendChild(span);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px)';
    setTimeout(() => toast.remove(), 300);
  }, 3600);
}

function openModal(opts) {
  opts = opts || {};
  const modal = document.getElementById('custom-modal');
  document.getElementById('modal-title').innerHTML = opts.title || 'Konfirmasi';
  document.getElementById('modal-message').innerHTML = opts.message || '';
  const inputWrap = document.getElementById('modal-input-wrapper');
  const emailWrap = document.getElementById('modal-email-wrapper');
  const inputEl = document.getElementById('modal-input');
  const emailEl = document.getElementById('modal-email');
  const errEl = document.getElementById('modal-error');
  const confirmBtn = document.getElementById('modal-confirm-btn');

  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (opts.showEmail) {
    emailWrap.classList.remove('hidden');
    emailEl.value = '';
  } else {
    emailWrap.classList.add('hidden');
  }
  if (opts.showInput) {
    inputWrap.classList.remove('hidden');
    inputEl.value = '';
    inputEl.type = 'password';
    document.getElementById('eye-icon').className = 'fa-solid fa-eye';
  } else {
    inputWrap.classList.add('hidden');
  }

  confirmBtn.textContent = opts.confirmText || 'Lanjutkan';
  confirmBtn.className = 'px-5 py-2 rounded-xl text-sm font-semibold text-white shadow-sm transition ' + (opts.confirmClass || 'bg-brand-600 hover:bg-brand-700');
  modalConfirmCallback = opts.onConfirm || null;

  confirmBtn.onclick = () => {
    if (typeof modalConfirmCallback === 'function') {
      if (opts.showEmail) modalConfirmCallback({ email: emailEl.value.trim(), password: inputEl.value });
      else modalConfirmCallback(opts.showInput ? inputEl.value : true);
    } else {
      closeModal();
    }
  };

  inputEl.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
  };

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  if (opts.showInput || opts.showEmail) setTimeout(() => (opts.showEmail ? emailEl : inputEl).focus(), 60);
}

function closeModal() {
  const modal = document.getElementById('custom-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  modalConfirmCallback = null;
}

function togglePasswordVisibility() {
  const inputEl = document.getElementById('modal-input');
  const iconEl = document.getElementById('eye-icon');
  if (!inputEl || !iconEl) return;
  if (inputEl.type === 'password') {
    inputEl.type = 'text';
    iconEl.className = 'fa-solid fa-eye-slash';
  } else {
    inputEl.type = 'password';
    iconEl.className = 'fa-solid fa-eye';
  }
}

function switchView(viewId) {
  ['view-login', 'view-exam', 'view-certificate', 'view-teacher'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const target = document.getElementById(viewId);
  if (target) target.classList.remove('hidden');
  // Keluar dari dashboard guru = logout Supabase Auth.
  if (viewId === 'view-login' && isTeacher && supabaseClient) {
    isTeacher = false;
    supabaseClient.auth.signOut().catch(() => {});
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateExamLockUI() {
  const closedBanner = document.getElementById('exam-closed-banner');
  const startBtn = document.getElementById('btn-start-exam');
  const lockBtn = document.getElementById('btn-toggle-exam-lock');
  const lockIcon = document.getElementById('icon-exam-lock');
  const lockText = document.getElementById('text-exam-lock');

  if (closedBanner) {
    if (isExamLocked) closedBanner.classList.remove('hidden');
    else closedBanner.classList.add('hidden');
  }
  if (lockBtn && lockIcon && lockText) {
    if (isExamLocked) {
      lockBtn.className = 'px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs sm:text-sm shadow flex items-center gap-2 transition';
      lockIcon.className = 'fa-solid fa-lock';
      lockText.textContent = 'Status Ujian: DITUTUP / DIKUNCI';
    } else {
      lockBtn.className = 'px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm shadow flex items-center gap-2 transition';
      lockIcon.className = 'fa-solid fa-lock-open';
      lockText.textContent = 'Status Ujian: DIBUKA';
    }
  }
  if (startBtn) {
    const alreadyDone = selectedStudent && Boolean(examResults[selectedStudent.id]);
    startBtn.disabled = !selectedStudent || alreadyDone || isExamLocked || !supabaseReady;
  }
}

/* -------------------------------------------------------------------------
   3. LOGIKA LOGIN & VERIFIKASI PESERTA UJIAN (roster dari tabel students)
   ------------------------------------------------------------------------- */
function handleClassChange(kelas) {
  const selectSiswa = document.getElementById('select-siswa');
  const verifyCard = document.getElementById('student-verify-card');
  const doneBanner = document.getElementById('already-done-banner');
  const startBtn = document.getElementById('btn-start-exam');

  selectedStudent = null;
  verifyCard.classList.add('hidden');
  doneBanner.classList.add('hidden');
  startBtn.disabled = true;

  if (!kelas || !STUDENTS_BY_CLASS[kelas]) {
    selectSiswa.innerHTML = '<option value="">-- Pilih Kelas Terlebih Dahulu --</option>';
    selectSiswa.disabled = true;
    return;
  }
  const list = STUDENTS_BY_CLASS[kelas];
  selectSiswa.innerHTML = '<option value="">-- Pilih Nama Lengkap Anda --</option>' +
    list.map(s => {
      const isDone = Boolean(examResults[s.id]);
      return `<option value="${s.id}">${String(s.absen).padStart(2, '0')}. ${s.nama}${isDone ? ' ✓ (Sudah Ujian)' : ''}</option>`;
    }).join('');
  selectSiswa.disabled = false;
}

function handleStudentChange(studentId) {
  const verifyCard = document.getElementById('student-verify-card');
  const doneBanner = document.getElementById('already-done-banner');
  const startBtn = document.getElementById('btn-start-exam');

  if (!studentId || !ALL_STUDENTS_MAP[studentId]) {
    selectedStudent = null;
    verifyCard.classList.add('hidden');
    doneBanner.classList.add('hidden');
    startBtn.disabled = true;
    return;
  }
  selectedStudent = ALL_STUDENTS_MAP[studentId];
  document.getElementById('verify-absen').textContent = 'No. Absen: ' + selectedStudent.absen;
  document.getElementById('verify-nis').textContent = selectedStudent.nis;
  document.getElementById('verify-nisn').textContent = selectedStudent.nisn;
  document.getElementById('verify-jk').textContent = selectedStudent.jk;
  document.getElementById('verify-walas').textContent = selectedStudent.walas;
  verifyCard.classList.remove('hidden');

  const existing = examResults[studentId];
  if (existing) {
    doneBanner.classList.remove('hidden');
    startBtn.disabled = true;
  } else {
    doneBanner.classList.add('hidden');
    startBtn.disabled = isExamLocked || !supabaseReady;
  }
  updateExamLockUI();
}

function viewExistingCertificate() {
  if (!selectedStudent) return;
  const res = examResults[selectedStudent.id];
  if (!res) { showToast('Data sertifikat tidak ditemukan.', 'warning'); return; }
  renderCertificate(res, false);
}

/* -------------------------------------------------------------------------
   4. MESIN UJIAN — soal dari questions_public, autosave, timer wall-clock
   ------------------------------------------------------------------------- */
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function saveSession() {
  if (!currentExamSession) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentExamSession));
  } catch (e) { /* penyimpanan penuh / privat — ujian tetap jalan di memori */ }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
  if (!saved || !saved.student || !Array.isArray(saved.questions)) return;
  if (!ALL_STUDENTS_MAP[saved.student.id]) return;
  if (examResults[saved.student.id]) { clearSession(); return; } // sudah terkumpul
  if (saved.endTime && saved.endTime <= Date.now()) {
    // Waktu habis saat tab tertutup — kumpulkan apa adanya.
    currentExamSession = saved;
    selectedStudent = saved.student;
    showToast('Waktu ujian sudah habis saat halaman tertutup. Jawaban dikumpulkan otomatis.', 'warning');
    finalizeAndSubmitExam();
    return;
  }
  currentExamSession = saved;
  selectedStudent = saved.student;
  document.getElementById('exam-avatar').textContent = selectedStudent.kelas;
  document.getElementById('exam-student-name').textContent = selectedStudent.nama;
  document.getElementById('exam-student-meta').textContent =
    'Kelas ' + selectedStudent.kelas + ' • Absen ' + selectedStudent.absen + ' • NIS: ' + selectedStudent.nis;
  switchView('view-exam');
  renderExamQuestion();
  renderQuestionGrid();
  startExamTimer();
  showToast('Sesi ujian dipulihkan — jawaban Anda yang tersimpan kembali.', 'success');
}

async function fetchQuestionsPublic() {
  const { data, error } = await supabaseClient
    .from('questions_public').select('id,topic,diff,q,options').order('id');
  if (error) throw new Error('Gagal memuat soal: ' + error.message + ' (pastikan schema.sql + seed-questions.sql sudah dijalankan)');
  if (!data || data.length === 0) throw new Error('Tabel questions masih kosong. Jalankan seed-questions.sql di SQL Editor Supabase.');
  return data;
}

async function handleStartExam(event) {
  if (event) event.preventDefault();
  if (!supabaseReady) { showToast('Supabase belum siap. Periksa konfigurasi di js/config.js.', 'error'); return; }
  if (!selectedStudent) { showToast('Silakan pilih kelas dan nama siswa terlebih dahulu.', 'warning'); return; }
  if (isExamLocked) { showToast('Sesi ujian saat ini sedang dikunci oleh guru.', 'error'); return; }
  if (examResults[selectedStudent.id]) { showToast('Anda sudah menyelesaikan ujian ini.', 'warning'); return; }

  // Sesi tersimpan untuk siswa ini? Lanjutkan, jangan acak ulang.
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (saved && saved.student && saved.student.id === selectedStudent.id && Array.isArray(saved.questions)) {
      restoreSession();
      return;
    }
  } catch (e) {}

  let bank;
  try {
    bank = await fetchQuestionsPublic();
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  const durationMs = (CFG.examDurationMinutes || 90) * 60 * 1000;
  const shuffledQuestions = shuffleArray(bank).map(qItem => {
    const optionObjs = (qItem.options || []).map((text, idx) => ({ text: text, origIdx: idx }));
    const shuffledOpts = shuffleArray(optionObjs);
    return { id: qItem.id, topic: qItem.topic, diff: qItem.diff, q: qItem.q, shuffledOptions: shuffledOpts };
  });

  currentExamSession = {
    student: selectedStudent,
    questions: shuffledQuestions,
    answers: new Array(shuffledQuestions.length).fill(null),
    doubts: new Array(shuffledQuestions.length).fill(false),
    currentIndex: 0,
    startTime: Date.now(),
    endTime: Date.now() + durationMs,
  };
  saveSession();

  document.getElementById('exam-avatar').textContent = selectedStudent.kelas;
  document.getElementById('exam-student-name').textContent = selectedStudent.nama;
  document.getElementById('exam-student-meta').textContent =
    'Kelas ' + selectedStudent.kelas + ' • Absen ' + selectedStudent.absen + ' • NIS: ' + selectedStudent.nis;

  switchView('view-exam');
  renderExamQuestion();
  renderQuestionGrid();
  startExamTimer();
  showToast('Selamat mengerjakan ujian, ' + selectedStudent.nama + '!', 'success');
}

function startExamTimer() {
  if (timerInterval) clearInterval(timerInterval);
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    if (!currentExamSession) { clearInterval(timerInterval); return; }
    // Simpan berkala supaya refresh di detik-detik akhir tetap aman.
    if (Date.now() % 5000 < 1100) saveSession();
    updateTimerDisplay();
    if (Date.now() >= currentExamSession.endTime) {
      clearInterval(timerInterval);
      showToast('Waktu ujian telah habis! Jawaban dikumpulkan otomatis.', 'warning');
      finalizeAndSubmitExam();
    }
  }, 1000);
}

function updateTimerDisplay() {
  if (!currentExamSession) return;
  const secs = Math.max(0, Math.ceil((currentExamSession.endTime - Date.now()) / 1000));
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  const timerEl = document.getElementById('exam-timer');
  const timerBox = document.getElementById('timer-box');
  if (timerEl) timerEl.textContent = String(mins).padStart(2, '0') + ':' + String(remSecs).padStart(2, '0');
  if (timerBox && secs <= 300) {
    timerBox.className = 'flex items-center gap-2 px-3.5 py-2 rounded-xl bg-rose-100 border border-rose-300 text-rose-900 font-mono font-extrabold text-sm sm:text-base animate-pulse';
  }
}

function setFontSize(sizeClass) {
  currentFontSize = sizeClass;
  const qText = document.getElementById('question-text');
  if (qText) { qText.classList.remove('text-sm', 'text-base', 'text-lg'); qText.classList.add(sizeClass); }
  document.querySelectorAll('.font-btn').forEach(btn => {
    btn.classList.remove('bg-white', 'shadow-sm', 'text-brand-700');
  });
  renderExamQuestion();
}

function toggleMobileNav() {
  const sidebar = document.getElementById('nav-sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('hidden');
}

function renderExamQuestion() {
  if (!currentExamSession) return;
  const idx = currentExamSession.currentIndex;
  const qObj = currentExamSession.questions[idx];
  const letters = ['A', 'B', 'C', 'D'];

  document.getElementById('current-q-num').textContent = idx + 1;
  document.getElementById('q-topic-badge').textContent = qObj.topic;

  const diffBadge = document.getElementById('q-diff-badge');
  diffBadge.textContent = qObj.diff;
  diffBadge.className = qObj.diff === 'Mudah'
    ? 'px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-900 text-xs font-bold'
    : qObj.diff === 'Sedang'
      ? 'px-2.5 py-1 rounded-lg bg-amber-100 text-amber-900 text-xs font-bold'
      : 'px-2.5 py-1 rounded-lg bg-rose-100 text-rose-900 text-xs font-bold';

  const qText = document.getElementById('question-text');
  qText.className = 'text-slate-900 font-medium leading-relaxed mb-6 ' + currentFontSize + ' bg-slate-50/80 p-4 sm:p-5 rounded-2xl border border-slate-200/90';
  qText.textContent = qObj.q;

  const selectedOpt = currentExamSession.answers[idx];
  const optionsContainer = document.getElementById('options-container');
  optionsContainer.innerHTML = qObj.shuffledOptions.map((opt, oIdx) => {
    const isSelected = selectedOpt === oIdx;
    return `
      <button type="button" onclick="selectOption(${oIdx})" class="w-full text-left p-3.5 sm:p-4 rounded-2xl border-2 transition flex items-center gap-3.5 ${isSelected ? 'border-brand-600 bg-brand-50/90 shadow-sm' : 'border-slate-200 bg-white hover:border-blue-300 hover:bg-slate-50'}">
        <span class="w-9 h-9 rounded-xl shrink-0 flex items-center justify-center font-extrabold text-sm ${isSelected ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 border border-slate-300'}">${letters[oIdx]}</span>
        <span class="${currentFontSize} font-semibold ${isSelected ? 'text-brand-950' : 'text-slate-800'}">${opt.text}</span>
      </button>`;
  }).join('');

  document.getElementById('checkbox-ragu').checked = currentExamSession.doubts[idx];
  document.getElementById('btn-prev').disabled = idx === 0;

  const nextBtn = document.getElementById('btn-next');
  if (idx === currentExamSession.questions.length - 1) {
    nextBtn.innerHTML = '<span>Selesai</span> <i class="fa-solid fa-check"></i>';
    nextBtn.onclick = confirmFinishExam;
  } else {
    nextBtn.innerHTML = '<span>Selanjutnya</span> <i class="fa-solid fa-chevron-right"></i>';
    nextBtn.onclick = nextQuestion;
  }
}

function selectOption(optionIdx) {
  if (!currentExamSession) return;
  currentExamSession.answers[currentExamSession.currentIndex] = optionIdx;
  saveSession();
  renderExamQuestion();
  renderQuestionGrid();
}

function toggleDoubt() {
  if (!currentExamSession) return;
  const checked = document.getElementById('checkbox-ragu').checked;
  currentExamSession.doubts[currentExamSession.currentIndex] = checked;
  saveSession();
  renderQuestionGrid();
}

function prevQuestion() {
  if (!currentExamSession || currentExamSession.currentIndex <= 0) return;
  currentExamSession.currentIndex--;
  saveSession();
  renderExamQuestion(); renderQuestionGrid();
}

function nextQuestion() {
  if (!currentExamSession || currentExamSession.currentIndex >= currentExamSession.questions.length - 1) return;
  currentExamSession.currentIndex++;
  saveSession();
  renderExamQuestion(); renderQuestionGrid();
}

function jumpToQuestion(index) {
  if (!currentExamSession) return;
  currentExamSession.currentIndex = index;
  saveSession();
  renderExamQuestion(); renderQuestionGrid();
}

function renderQuestionGrid() {
  if (!currentExamSession) return;
  const grid = document.getElementById('question-grid');
  const answeredCount = currentExamSession.answers.filter(a => a !== null).length;
  document.getElementById('answered-counter').textContent = answeredCount + ' / ' + currentExamSession.questions.length + ' Terjawab';
  grid.innerHTML = currentExamSession.questions.map((_, idx) => {
    const isCurrent = idx === currentExamSession.currentIndex;
    const isDoubt = currentExamSession.doubts[idx];
    const isAnswered = currentExamSession.answers[idx] !== null;
    let btnClass = 'bg-slate-200 text-slate-700 hover:bg-slate-300';
    if (isDoubt) btnClass = 'bg-amber-400 text-slate-950 font-extrabold';
    else if (isAnswered) btnClass = 'bg-emerald-600 text-white font-extrabold';
    if (isCurrent) btnClass += ' ring-2 ring-offset-1 ring-brand-600 border-2 border-brand-700';
    return `<button type="button" onclick="jumpToQuestion(${idx})" class="h-9 rounded-xl text-xs font-bold transition ${btnClass}">${idx + 1}</button>`;
  }).join('');
}

function confirmFinishExam() {
  if (!currentExamSession) return;
  const total = currentExamSession.questions.length;
  const answered = currentExamSession.answers.filter(a => a !== null).length;
  const unanswered = total - answered;
  openModal({
    title: '<i class="fa-solid fa-paper-plane"></i> Konfirmasi Kumpulkan Jawaban',
    message: unanswered > 0
      ? `Anda telah menjawab <strong>${answered}</strong> dari ${total} soal. Masih ada <strong>${unanswered} soal belum dijawab</strong>. Apakah Anda yakin ingin mengakhiri ujian dan mengirim nilai sekarang?`
      : `Seluruh <strong>${total} soal</strong> telah terjawab! Apakah Anda yakin ingin mengumpulkan jawaban dan melihat sertifikat nilai Anda?`,
    confirmText: 'Ya, Kumpulkan Sekarang',
    confirmClass: 'bg-emerald-600 hover:bg-emerald-700',
    onConfirm: () => { closeModal(); finalizeAndSubmitExam(); }
  });
}

function queuePendingResult(payload) {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    list.push(payload);
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch (e) {}
}

async function flushPendingResults() {
  if (!supabaseClient) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch (e) {}
  if (!list.length) return;
  const remaining = [];
  for (const p of list) {
    const { error } = await supabaseClient.rpc('submit_exam', p);
    if (error) remaining.push(p);
  }
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(remaining)); } catch (e) {}
  if (remaining.length < list.length) {
    await loadResults();
    showToast('Hasil ujian yang sempat tertunda berhasil dikirim ke Supabase.', 'success');
  }
}

async function finalizeAndSubmitExam() {
  if (!currentExamSession) return;
  if (timerInterval) clearInterval(timerInterval);

  const session = currentExamSession;
  const answersPayload = session.questions.map((qItem, idx) => ({
    question_id: qItem.id,
    selected: session.answers[idx] === null ? null : qItem.shuffledOptions[session.answers[idx]].origIdx,
  }));
  const rpcArgs = {
    p_student_id: session.student.id,
    p_answers: answersPayload,
    p_started_at: new Date(session.startTime).toISOString(),
  };

  // Penilaian di server (RPC submit_exam) — kunci jawaban tidak pernah
  // dikirim ke browser, jadi tidak bisa dilihat lewat View Source.
  const { data, error } = await supabaseClient.rpc('submit_exam', rpcArgs);

  if (error || !data) {
    console.error('submit_exam error:', error);
    queuePendingResult(rpcArgs);
    saveSession(); // sesi tetap ada — siswa bisa menekan Kumpulkan lagi
    showToast('Gagal menyimpan ke Supabase (' + (error ? error.message : 'tidak ada balasan') + '). Jawaban tersimpan di perangkat ini dan akan dikirim ulang otomatis. Jangan tutup halaman sebelum ada konfirmasi sukses.', 'error');
    // Jalankan lagi timernya HANYA bila waktu belum habis — kalau sudah
    // habis, jangan loop finalize tiap detik.
    if (session.endTime && Date.now() < session.endTime) startExamTimer();
    return;
  }

  const resultRecord = normalizeResult(data);
  if (!resultRecord || !resultRecord.studentId) {
    console.error('submit_exam balasan tidak dikenal:', data);
    queuePendingResult(rpcArgs);
    showToast('Supabase membalas format yang tidak dikenal. Jawaban tersimpan lokal, hubungi guru.', 'error');
    return;
  }

  currentExamSession = null;
  clearSession();
  try {
    const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
      .filter(p => p.p_student_id !== session.student.id);
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch (e) {}
  examResults[resultRecord.studentId] = resultRecord;
  const total = Object.keys(ALL_STUDENTS_MAP).length;
  updateSyncBadge(`Supabase Aktif • ${Object.keys(examResults).length}/${total} Selesai`, true);
  showToast('Jawaban berhasil dikirim dan tersimpan di Supabase!', 'success');
  renderCertificate(resultRecord, false);
}

/* -------------------------------------------------------------------------
   5. PORTAL SERTIFIKAT & UNDUH PDF 1 LEMBAR UTUH
   ------------------------------------------------------------------------- */
function getPredicate(score) {
  if (score >= 90) return 'SANGAT BAIK (A)';
  if (score >= 80) return 'BAIK (B)';
  if (score >= (CFG.kkm || 75)) return 'CUKUP / TUNTAS (C)';
  return 'PERLU BIMBINGAN (D)';
}

function openCertificateLookupView() {
  switchView('view-certificate');
  document.getElementById('cert-lookup-panel').classList.remove('hidden');
  document.getElementById('cert-lookup-empty').classList.add('hidden');
  if (!activeCertResult) {
    document.getElementById('cert-action-bar').classList.add('hidden');
    document.getElementById('print-area').classList.add('hidden');
  }
}

function handleCertLookupClassChange(kelas) {
  const siswaSelect = document.getElementById('cert-lookup-siswa');
  const emptyBanner = document.getElementById('cert-lookup-empty');
  emptyBanner.classList.add('hidden');
  if (!kelas || !STUDENTS_BY_CLASS[kelas]) {
    siswaSelect.innerHTML = '<option value="">-- Pilih Kelas Terlebih Dahulu --</option>';
    siswaSelect.disabled = true;
    return;
  }
  const list = STUDENTS_BY_CLASS[kelas];
  siswaSelect.innerHTML = '<option value="">-- Pilih Nama Siswa --</option>' +
    list.map(s => {
      const isDone = Boolean(examResults[s.id]);
      return `<option value="${s.id}">${String(s.absen).padStart(2, '0')}. ${s.nama} ${isDone ? '— [Nilai: ' + examResults[s.id].score + ']' : '(Belum Ujian)'}</option>`;
    }).join('');
  siswaSelect.disabled = false;
}

function handleCertLookupStudentChange(studentId) {
  const emptyBanner = document.getElementById('cert-lookup-empty');
  if (!studentId) return;
  const res = examResults[studentId];
  if (!res) {
    emptyBanner.classList.remove('hidden');
    document.getElementById('cert-action-bar').classList.add('hidden');
    document.getElementById('print-area').classList.add('hidden');
    return;
  }
  emptyBanner.classList.add('hidden');
  renderCertificate(res, true);
}

function renderCertificate(resultData, keepLookupVisible) {
  keepLookupVisible = keepLookupVisible || false;
  activeCertResult = resultData;
  switchView('view-certificate');

  const lookupPanel = document.getElementById('cert-lookup-panel');
  if (keepLookupVisible) lookupPanel.classList.remove('hidden');
  else lookupPanel.classList.add('hidden');

  document.getElementById('cert-action-bar').classList.remove('hidden');
  document.getElementById('print-area').classList.remove('hidden');

  document.getElementById('top-cert-no').textContent = resultData.certNo;
  document.getElementById('cert-code-badge').textContent = 'NO: ' + resultData.certNo;
  document.getElementById('cert-student-name').textContent = resultData.nama;
  document.getElementById('cert-student-detail').textContent =
    'Kelas: ' + resultData.kelas + ' (Absen ' + resultData.absen + ') • NIS: ' + resultData.nis + ' • NISN: ' + resultData.nisn + ' • Wali Kelas: ' + (resultData.walas || '-');
  document.getElementById('cert-score').textContent = resultData.score;
  document.getElementById('cert-grade-badge').textContent = 'PREDIKAT: ' + getPredicate(resultData.score);
  document.getElementById('cert-stats').textContent =
    'Benar: ' + resultData.correct + ' | Salah: ' + resultData.wrong + ' | Kosong: ' + resultData.blank;
  document.getElementById('cert-timestamp').textContent = resultData.timestamp;
  document.getElementById('cert-duration').textContent = resultData.duration;

  // Tanggal sertifikat = tanggal ujian yang tersimpan, BUKAN tanggal hari ini
  // saat sertifikat dibuka kembali.
  const certDate = resultData.submittedAt
    ? new Date(resultData.submittedAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('cert-date-place').textContent = 'Kotagajah, ' + certDate;

  const tbody = document.getElementById('cert-topic-tbody');
  const topics = resultData.topicStats || {};
  tbody.innerHTML = Object.entries(topics).map(([topicName, st]) => {
    const pct = st.total > 0 ? Math.round((st.correct / st.total) * 100) : 0;
    return `
      <tr>
        <td class="py-1.5 px-3 font-semibold text-slate-800">${topicName}</td>
        <td class="py-1.5 px-2 text-center">${st.total}</td>
        <td class="py-1.5 px-2 text-center font-bold text-emerald-700">${st.correct}</td>
        <td class="py-1.5 px-3 text-right font-extrabold ${pct >= 75 ? 'text-emerald-700' : 'text-amber-700'}">${pct}%</td>
      </tr>`;
  }).join('');
}

async function downloadCertificatePDF() {
  if (!activeCertResult) return;
  const element = document.getElementById('print-area');
  const btn = document.getElementById('btn-download-pdf');
  const origHtml = btn.innerHTML;
  try {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Memproses PDF...</span>';
    element.classList.add('pdf-single-page');
    const safeName = activeCertResult.nama.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = 'Sertifikat_CBT_MTK9_' + activeCertResult.kelas + '_' + safeName + '.pdf';
    const opt = {
      margin: 0.2,
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape' }
    };
    if (typeof html2pdf !== 'undefined') {
      await html2pdf().set(opt).from(element).save();
      showToast('Sertifikat PDF berhasil diunduh!', 'success');
    } else {
      window.print();
    }
  } catch (err) {
    console.error('PDF generation error:', err);
    window.print();
  } finally {
    element.classList.remove('pdf-single-page');
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

/* -------------------------------------------------------------------------
   6. PORTAL & DASHBOARD TOOL GURU — Supabase Auth (bukan password hardcode)
   ------------------------------------------------------------------------- */
function openTeacherLogin() {
  if (!supabaseReady) { showToast('Supabase belum siap. Periksa konfigurasi di js/config.js.', 'error'); return; }
  openModal({
    title: '<i class="fa-solid fa-lock"></i> Login Tool Guru Mata Pelajaran',
    message: 'Masuk dengan akun guru yang dibuat di Supabase Dashboard → Authentication → Users. Akun ini yang boleh melihat kunci jawaban, mereset siswa, dan mengunci ujian.',
    showEmail: true,
    showInput: true,
    confirmText: 'Masuk Dashboard Guru',
    onConfirm: async (creds) => {
      if (!creds.email || !creds.password) {
        const errEl = document.getElementById('modal-error');
        errEl.textContent = 'Isi email dan password guru.';
        errEl.classList.remove('hidden');
        return;
      }
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: creds.email, password: creds.password,
      });
      if (error || !data.session) {
        const errEl = document.getElementById('modal-error');
        errEl.textContent = 'Login gagal: ' + (error ? error.message : 'periksa email/password.');
        errEl.classList.remove('hidden');
        return;
      }
      isTeacher = true;
      closeModal();
      switchView('view-teacher');
      updateExamLockUI();
      updateTeacherStats();
      renderTeacherTable();
      await renderTeacherBank();
      showToast('Berhasil masuk ke Dashboard Tool Guru.', 'success');
    }
  });
}

async function toggleExamLockStatus() {
  if (!isTeacher) { showToast('Masuk dulu sebagai guru.', 'warning'); return; }
  const nextState = !isExamLocked;
  await saveExamLockToCloud(nextState);
  showToast(
    nextState ? 'Ujian berhasil DITUTUP / DIKUNCI untuk semua perangkat.' : 'Ujian berhasil DIBUKA untuk semua perangkat.',
    nextState ? 'warning' : 'success'
  );
}

function switchTeacherTab(tabId) {
  document.getElementById('tab-rekap').classList.add('hidden');
  document.getElementById('tab-bank').classList.add('hidden');
  document.getElementById(tabId).classList.remove('hidden');
  document.querySelectorAll('.teacher-tab-btn').forEach(btn => {
    btn.className = 'teacher-tab-btn px-4 py-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 font-bold text-xs sm:text-sm flex items-center gap-2 transition';
  });
  const activeBtn = document.getElementById(tabId === 'tab-rekap' ? 'btn-tab-rekap' : 'btn-tab-bank');
  if (activeBtn) {
    activeBtn.className = 'teacher-tab-btn px-4 py-2.5 rounded-xl bg-brand-700 text-white font-bold text-xs sm:text-sm shadow-sm flex items-center gap-2 transition';
  }
}

function updateTeacherStats() {
  const allList = Object.values(ALL_STUDENTS_MAP);
  const completedList = Object.values(examResults);
  const total = allList.length;
  const doneCount = completedList.length;
  const pct = total > 0 ? ((doneCount / total) * 100).toFixed(1) : '0.0';

  document.getElementById('stat-total-students').textContent = total;
  document.getElementById('stat-completed').textContent = doneCount;
  document.getElementById('stat-completed-pct').textContent = pct + '% dari total peserta';

  if (doneCount === 0) {
    document.getElementById('stat-avg-score').textContent = '0.0';
    document.getElementById('stat-max-score').textContent = '0';
    document.getElementById('stat-top-student').textContent = 'Belum ada data';
    return;
  }
  const sum = completedList.reduce((acc, r) => acc + Number(r.score || 0), 0);
  const avg = (sum / doneCount).toFixed(1);
  let topRec = completedList[0];
  completedList.forEach(r => { if (Number(r.score) > Number(topRec.score)) topRec = r; });

  document.getElementById('stat-avg-score').textContent = avg;
  document.getElementById('stat-max-score').textContent = topRec.score;
  document.getElementById('stat-top-student').textContent = topRec.nama + ' (' + topRec.kelas + ')';
}

function renderTeacherTable() {
  const kelasFilter = document.getElementById('filter-teacher-kelas').value;
  const statusFilter = document.getElementById('filter-teacher-status').value;
  const searchQuery = document.getElementById('filter-teacher-search').value.trim().toLowerCase();

  let rows = Object.values(ALL_STUDENTS_MAP);
  if (kelasFilter !== 'ALL') rows = rows.filter(s => s.kelas === kelasFilter);
  if (statusFilter === 'DONE') rows = rows.filter(s => Boolean(examResults[s.id]));
  else if (statusFilter === 'PENDING') rows = rows.filter(s => !examResults[s.id]);
  if (searchQuery) {
    rows = rows.filter(s =>
      s.nama.toLowerCase().includes(searchQuery) ||
      String(s.nis).includes(searchQuery) ||
      String(s.nisn).includes(searchQuery)
    );
  }

  const tbody = document.getElementById('teacher-rekap-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="py-8 text-center text-slate-500 font-semibold">Tidak ada data siswa yang sesuai filter.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((s, idx) => {
    const res = examResults[s.id];
    if (res) {
      const pred = getPredicate(res.score);
      const isPass = res.score >= (CFG.kkm || 75);
      return `
        <tr class="hover:bg-blue-50/40 transition">
          <td class="py-2.5 px-3 font-semibold text-slate-600">${idx + 1}</td>
          <td class="py-2.5 px-3 font-extrabold text-brand-800">${s.kelas}</td>
          <td class="py-2.5 px-3 font-mono text-xs text-slate-600">${s.nis} / ${s.nisn}</td>
          <td class="py-2.5 px-3 font-bold text-slate-900">${s.nama}</td>
          <td class="py-2.5 px-3 text-center"><span class="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-xs">Selesai</span></td>
          <td class="py-2.5 px-3 text-center font-bold text-slate-700">${res.correct}/40</td>
          <td class="py-2.5 px-3 text-center font-black text-base ${isPass ? 'text-emerald-700' : 'text-rose-600'}">${res.score}</td>
          <td class="py-2.5 px-3 text-center text-xs font-bold text-slate-700">${pred}</td>
          <td class="py-2.5 px-3 text-center">
            <div class="inline-flex items-center gap-1.5">
              <button type="button" onclick="viewStudentCertFromTeacher('${s.id}')" class="px-2.5 py-1 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs transition" title="Lihat Sertifikat"><i class="fa-solid fa-award"></i></button>
              <button type="button" onclick="resetSingleStudent('${s.id}')" class="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs transition" title="Reset Ujian"><i class="fa-solid fa-rotate-left"></i></button>
            </div>
          </td>
        </tr>`;
    }
    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-2.5 px-3 font-semibold text-slate-500">${idx + 1}</td>
        <td class="py-2.5 px-3 font-bold text-slate-700">${s.kelas}</td>
        <td class="py-2.5 px-3 font-mono text-xs text-slate-500">${s.nis} / ${s.nisn}</td>
        <td class="py-2.5 px-3 font-semibold text-slate-700">${s.nama}</td>
        <td class="py-2.5 px-3 text-center"><span class="px-2.5 py-0.5 rounded-full bg-slate-200 text-slate-700 font-bold text-xs">Belum Ujian</span></td>
        <td class="py-2.5 px-3 text-center text-slate-400">-</td>
        <td class="py-2.5 px-3 text-center text-slate-400">-</td>
        <td class="py-2.5 px-3 text-center text-slate-400">-</td>
        <td class="py-2.5 px-3 text-center text-xs text-slate-400">Menunggu</td>
      </tr>`;
  }).join('');
}

function viewStudentCertFromTeacher(studentId) {
  const res = examResults[studentId];
  if (!res) return;
  renderCertificate(res, false);
}

function resetSingleStudent(studentId) {
  const res = examResults[studentId];
  if (!res) return;
  openModal({
    title: '<i class="fa-solid fa-rotate-left"></i> Reset Status Ujian Siswa',
    message: `Apakah Anda yakin ingin mereset hasil ujian atas nama <strong>${res.nama}</strong> (Kelas ${res.kelas})? Siswa tersebut akan diizinkan mengerjakan ujian kembali di perangkat mana pun.`,
    confirmText: 'Ya, Reset Siswa',
    confirmClass: 'bg-amber-600 hover:bg-amber-700',
    onConfirm: async () => {
      await deleteStudentResultFromCloud(studentId);
      closeModal();
      updateTeacherStats();
      renderTeacherTable();
      if (selectedStudent && selectedStudent.id === studentId) handleStudentChange(studentId);
      showToast('Data ujian ' + res.nama + ' berhasil direset.', 'success');
    }
  });
}

function confirmResetAllResults() {
  openModal({
    title: '<i class="fa-solid fa-triangle-exclamation"></i> Reset Seluruh Data Nilai',
    message: 'Tindakan ini akan menghapus <strong>SELURUH</strong> hasil ujian siswa dari semua kelas (9A–9K) di Supabase. Pastikan Anda sudah mengunduh file CSV sebelum mereset!',
    confirmText: 'Hapus & Reset Semua',
    confirmClass: 'bg-rose-600 hover:bg-rose-700',
    onConfirm: async () => {
      await deleteAllResultsFromCloud();
      closeModal();
      updateTeacherStats();
      renderTeacherTable();
      showToast('Seluruh data hasil ujian berhasil dikosongkan.', 'warning');
    }
  });
}

function exportResultsCSV() {
  const kelasFilter = document.getElementById('filter-teacher-kelas').value;
  let rows = Object.values(ALL_STUDENTS_MAP);
  if (kelasFilter !== 'ALL') rows = rows.filter(s => s.kelas === kelasFilter);

  const headers = ['No', 'Kelas', 'No Absen', 'NIS', 'NISN', 'Nama Siswa', 'Status', 'Benar', 'Salah', 'Kosong', 'Nilai Akhir', 'Predikat', 'Waktu Selesai'];
  const csvLines = [headers.join(',')];
  rows.forEach((s, idx) => {
    const res = examResults[s.id];
    if (res) {
      csvLines.push([
        idx + 1, s.kelas, s.absen, '"' + s.nis + '"', '"' + s.nisn + '"', '"' + s.nama + '"',
        'Selesai', res.correct, res.wrong, res.blank, res.score,
        '"' + getPredicate(res.score) + '"', '"' + res.timestamp + '"'
      ].join(','));
    } else {
      csvLines.push([
        idx + 1, s.kelas, s.absen, '"' + s.nis + '"', '"' + s.nisn + '"', '"' + s.nama + '"',
        'Belum Ujian', '', '', '', '', '', ''
      ].join(','));
    }
  });
  const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Rekap_Nilai_CBT_MTK9_' + kelasFilter + '_SMPN2_Kotagajah.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('File CSV rekap nilai berhasil diunduh.', 'success');
}

async function renderTeacherBank() {
  const letters = ['A', 'B', 'C', 'D'];
  const listEl = document.getElementById('teacher-bank-list');
  const qArea = document.getElementById('printable-questions-area');
  if (!supabaseClient || !isTeacher) {
    listEl.innerHTML = '<p class="text-sm text-slate-600">Masuk sebagai guru untuk melihat kunci jawaban.</p>';
    return;
  }
  const { data, error } = await supabaseClient.from('questions').select('*').order('id');
  if (error) {
    listEl.innerHTML = '<p class="text-sm text-rose-700">Gagal memuat bank soal: ' + error.message + '</p>';
    return;
  }
  QUESTION_BANK_FULL = data || [];
  listEl.innerHTML = QUESTION_BANK_FULL.map((q, idx) => `
    <div class="p-4 rounded-2xl border border-slate-200 bg-slate-50/70">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span class="px-2.5 py-0.5 rounded-lg bg-brand-800 text-white font-bold text-xs">Soal No. ${idx + 1}</span>
        <span class="text-xs font-bold text-brand-700">${q.topic} • Tingkat: ${q.diff}</span>
      </div>
      <p class="font-semibold text-slate-900 text-sm mb-2">${q.q}</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs mb-2.5">
        ${(q.options || []).map((opt, oIdx) => `
          <div class="px-3 py-1.5 rounded-lg border ${oIdx === q.answer_idx ? 'bg-emerald-100 border-emerald-400 font-extrabold text-emerald-950' : 'bg-white border-slate-200 text-slate-700'}">
            ${letters[oIdx]}. ${opt} ${oIdx === q.answer_idx ? '✓' : ''}
          </div>`).join('')}
      </div>
      <div class="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950">
        <strong>Kunci: ${letters[q.answer_idx]}</strong> — <em>Pembahasan:</em> ${q.explanation || '-'}
      </div>
    </div>`).join('');

  qArea.innerHTML = `
    <div class="p-4">
      <h2 class="text-lg font-extrabold text-center uppercase mb-1">Naskah Soal Penilaian Sumatif Matematika Kelas IX</h2>
      <p class="text-xs text-center text-slate-600 mb-4">SMP Negeri 2 Kotagajah • Tahun Pelajaran 2026/2027</p>
      <div class="space-y-3 text-xs">
        ${QUESTION_BANK_FULL.map((q, idx) => `
          <div>
            <p class="font-bold">${idx + 1}. ${q.q}</p>
            <div class="grid grid-cols-2 gap-1 pl-4 mt-1">
              ${(q.options || []).map((opt, oIdx) => `<span>${letters[oIdx]}. ${opt}</span>`).join('')}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

function printTeacherDocument(mode) {
  const qArea = document.getElementById('printable-questions-area');
  const sArea = document.getElementById('printable-solutions-area');
  if (mode === 'questions') {
    qArea.classList.remove('hidden');
    qArea.classList.add('active-print');
    if (sArea) sArea.classList.remove('active-print');
    window.print();
    qArea.classList.remove('active-print');
    qArea.classList.add('hidden');
  } else {
    if (sArea) sArea.classList.add('active-print');
    qArea.classList.remove('active-print');
    window.print();
    if (sArea) sArea.classList.remove('active-print');
  }
}

/* -------------------------------------------------------------------------
   7. EKSPOS FUNGSI KE GLOBAL WINDOW (UNTUK ONCLICK HTML) & INISIALISASI
   ------------------------------------------------------------------------- */
window.closeModal = closeModal;
window.togglePasswordVisibility = togglePasswordVisibility;
window.switchView = switchView;
window.openCertificateLookupView = openCertificateLookupView;
window.openTeacherLogin = openTeacherLogin;
window.handleClassChange = handleClassChange;
window.handleStudentChange = handleStudentChange;
window.handleStartExam = handleStartExam;
window.viewExistingCertificate = viewExistingCertificate;
window.setFontSize = setFontSize;
window.toggleMobileNav = toggleMobileNav;
window.prevQuestion = prevQuestion;
window.nextQuestion = nextQuestion;
window.toggleDoubt = toggleDoubt;
window.selectOption = selectOption;
window.jumpToQuestion = jumpToQuestion;
window.confirmFinishExam = confirmFinishExam;
window.handleCertLookupClassChange = handleCertLookupClassChange;
window.handleCertLookupStudentChange = handleCertLookupStudentChange;
window.downloadCertificatePDF = downloadCertificatePDF;
window.toggleExamLockStatus = toggleExamLockStatus;
window.switchTeacherTab = switchTeacherTab;
window.renderTeacherTable = renderTeacherTable;
window.exportResultsCSV = exportResultsCSV;
window.confirmResetAllResults = confirmResetAllResults;
window.viewStudentCertFromTeacher = viewStudentCertFromTeacher;
window.resetSingleStudent = resetSingleStudent;
window.printTeacherDocument = printTeacherDocument;

document.addEventListener('DOMContentLoaded', initSupabase);
