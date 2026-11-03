'use strict';

/**
 * Frontend YT2MP3: analisis link -> pilih kualitas -> konversi dengan progres
 * live via Server-Sent Events (fallback ke polling bila SSE terputus).
 */

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#analyze-form'),
  urlInput: $('#url-input'),
  analyzeBtn: $('#analyze-btn'),
  errorBox: $('#error-box'),
  card: $('#video-card'),
  thumb: $('#thumb'),
  title: $('#video-title'),
  sub: $('#video-sub'),
  duration: $('#badge-duration'),
  convertBtn: $('#convert-btn'),
  progress: $('#progress-block'),
  barFill: $('#bar-fill'),
  stageLabel: $('#stage-label'),
  percentLabel: $('#percent-label'),
  done: $('#done-block'),
  downloadBtn: $('#download-btn'),
  fileInfo: $('#file-info'),
  againBtn: $('#again-btn'),
};

const state = {
  info: null,
  jobId: null,
  source: null,
  pollTimer: null,
  autoDownloaded: false,
};

const STAGE_LABELS = {
  queued: 'Menunggu giliran…',
  preparing: 'Menyiapkan PO Token…',
  downloading: 'Mengunduh audio…',
  converting: 'Mengonversi ke MP3…',
  done: 'Selesai — file siap diunduh!',
  error: 'Terjadi kesalahan',
};

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
}

function clearError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = '';
}

async function api(pathname, options = {}) {
  const res = await fetch(pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* body bukan JSON */
  }

  if (!res.ok) {
    throw new Error((data && data.error) || `Permintaan gagal (HTTP ${res.status}).`);
  }
  return data;
}

function selectedQuality() {
  const checked = document.querySelector('input[name="quality"]:checked');
  return checked ? Number(checked.value) : 192;
}

// ---------------------------------------------------------------------------
// Langkah 1: analisis link
// ---------------------------------------------------------------------------

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const url = els.urlInput.value.trim();
  if (!url) return;

  const originalLabel = els.analyzeBtn.textContent;
  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = 'Menganalisis…';

  try {
    const info = await api('/api/info', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });

    state.info = info;
    renderInfo(info);

    els.card.hidden = false;
    resetConvertState();
    els.card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(err.message);
    els.card.hidden = true;
  } finally {
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.textContent = originalLabel;
  }
});

function renderInfo(info) {
  // Thumbnail diambil dari ID video (dipastikan aman oleh server juga).
  els.thumb.src = info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;
  els.thumb.alt = info.title;
  els.title.textContent = info.title;
  els.sub.textContent = info.uploader || 'Tanpa keterangan channel';
  els.duration.textContent = formatDuration(info.duration);
}

// ---------------------------------------------------------------------------
// Langkah 2: konversi
// ---------------------------------------------------------------------------

els.convertBtn.addEventListener('click', startConvert);
els.againBtn.addEventListener('click', () => {
  resetConvertState();
  els.convertBtn.focus();
});

function resetConvertState() {
  closeStream();
  state.jobId = null;
  state.autoDownloaded = false;

  els.convertBtn.hidden = false;
  els.convertBtn.disabled = false;
  els.convertBtn.textContent = 'Konversi ke MP3';

  els.progress.hidden = true;
  els.done.hidden = true;
  els.barFill.classList.remove('indeterminate');
  setProgress(0, STAGE_LABELS.preparing);
}

async function startConvert() {
  if (!state.info) return;
  clearError();

  // Sembunyikan tombol, tampilkan progres sebagai gantinya.
  els.convertBtn.hidden = true;
  els.progress.hidden = false;
  els.done.hidden = true;
  setProgress(2, STAGE_LABELS.queued);

  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        url: state.info.webpageUrl,
        quality: selectedQuality(),
        title: state.info.title,
      }),
    });

    state.jobId = job.id;
    state.autoDownloaded = false;
    openStream(job.id);
  } catch (err) {
    showError(err.message);
    resetConvertState();
  }
}

function setProgress(percent, label) {
  const value = Math.max(0, Math.min(100, Math.round(percent || 0)));
  els.barFill.style.width = `${value}%`;
  els.percentLabel.textContent = `${value}%`;
  if (label) els.stageLabel.textContent = label;
}

// ---------------------------------------------------------------------------
// Live update (SSE) + fallback polling
// ---------------------------------------------------------------------------

function openStream(jobId) {
  closeStream();

  const source = new EventSource(`/api/jobs/${jobId}/events`);
  state.source = source;

  source.addEventListener('update', (event) => {
    try {
      handleJobUpdate(JSON.parse(event.data));
    } catch {
      /* abaikan data rusak */
    }
  });

  source.onerror = () => {
    // Bila koneksi SSE mati permanen, beralih ke polling sederhana.
    if (source.readyState === EventSource.CLOSED) {
      closeStream();
      startPolling(jobId);
    }
  };
}

function startPolling(jobId) {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      handleJobUpdate(job);
    } catch {
      /* biarkan mencoba lagi */
    }
  }, 1500);
}

function closeStream() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function handleJobUpdate(job) {
  if (!job || job.id !== state.jobId) return;

  if (job.status === 'error') {
    closeStream();
    showError(job.error || 'Konversi gagal.');
    resetConvertState();
    return;
  }

  if (job.status === 'done') {
    closeStream();
    renderDone(job);
    return;
  }

  // Masih berjalan.
  const label = STAGE_LABELS[job.stage] || 'Memproses…';
  els.barFill.classList.toggle('indeterminate', job.stage === 'preparing');
  setProgress(job.progress, label);
}

function renderDone(job) {
  const url = `/api/jobs/${job.id}/file`;

  els.convertBtn.hidden = true;
  els.progress.hidden = true;
  els.done.hidden = false;

  els.downloadBtn.href = url;
  els.downloadBtn.textContent = '⬇ Unduh MP3';

  const parts = [`${job.quality} kbps`];
  if (job.fileSize) parts.push(formatSize(job.fileSize));
  if (job.title) parts.push(job.title);
  els.fileInfo.textContent = parts.join(' • ');

  // Unduh otomatis sekali; tombol tetap tersedia untuk unduh ulang.
  if (!state.autoDownloaded) {
    state.autoDownloaded = true;
    try {
      els.downloadBtn.click();
    } catch {
      /* browser mungkin memblokir — tombol tetap bisa diklik manual */
    }
  }
}

// Tutup koneksi saat halaman ditutup.
window.addEventListener('beforeunload', closeStream);
