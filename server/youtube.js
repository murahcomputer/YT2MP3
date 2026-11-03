'use strict';

/**
 * Interface ke yt-dlp: validasi URL YouTube, ambil info video, dan konversi
 * ke MP3. Semua jalur yang menyentuh YouTube memakai PO Token dari poToken.js
 * dengan strategi retry:
 *   1. pakai token dari cache
 *   2. gagal karena token -> buat token baru, coba lagi
 *   3. masih gagal -> coba tanpa PO token (klien yt-dlp yang tidak wajib token)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const poToken = require('./poToken');

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * Ekstrak ID video dari berbagai bentuk URL YouTube.
 * Mendukung: /watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/
 * @returns {string|null}
 */
function parseVideoId(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0] || '';
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  const watchId = parsed.searchParams.get('v');
  if (parsed.pathname === '/watch' && VIDEO_ID_RE.test(watchId || '')) return watchId;

  const match = parsed.pathname.match(/^\/(?:shorts|embed|live|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
  return match ? match[1] : null;
}

/** URL resmi tunggal agar playlist/parameter aneh tidak ikut terunduh. */
function canonicalUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Susun nilai --extractor-args untuk yt-dlp.
 * Format resmi: youtube:po_token=CLIENT.CONTEXT+TOKEN;visitor_data=...
 * (prefix "youtube:" WAJIB ada — tanpa itu yt-dlp menolak seluruh argumen).
 */
function buildExtractorArgs(token) {
  if (!token) return '';
  const parts = [`po_token=${config.poClient}+${token.poToken}`];
  parts.push(`visitor_data=${token.visitorData}`);
  if (config.playerSkip) parts.push(`player_skip=${config.playerSkip}`);
  return `youtube:${parts.join(';')}`;
}

function baseArgs(token) {
  const args = ['--no-warnings', '--no-playlist', '--user-agent', config.userAgent];
  const extractorArgs = buildExtractorArgs(token);
  if (extractorArgs) args.push('--extractor-args', extractorArgs);
  // Hanya pass --ffmpeg-location bila berupa path nyata; jika hanya nama
  // command ("ffmpeg"), biarkan yt-dlp mencari sendiri di PATH.
  if (config.ffmpegPath.includes('/') || config.ffmpegPath.includes('\\')) {
    args.push('--ffmpeg-location', config.ffmpegPath);
  }
  return args;
}

/** Jalankan yt-dlp dan kumpulkan output baris per baris. */
function runYtDlp(args, { onLine, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* sudah mati */
      }
    }, timeoutMs || config.downloadTimeoutMs);

    const handleChunk = (target, chunk) => {
      const text = chunk.toString();
      if (target === 'stdout') stdout += text;
      else stderr += text;
      if (!onLine) return;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine(line, target);
      }
    };

    child.stdout.on('data', (chunk) => handleChunk('stdout', chunk));
    child.stderr.on('data', (chunk) => handleChunk('stderr', chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Gagal menjalankan "${config.ytdlpPath}": ${err.message}. Pastikan yt-dlp terinstal dan PATH sudah benar.`
        )
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const err = new Error('Waktu proses habis (timeout).');
        err.timeout = true;
        err.output = stderr + stdout;
        reject(err);
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Jalankan yt-dlp; lempar error bila exit code != 0. */
async function runChecked(args, options = {}) {
  const { code, stdout, stderr } = await runYtDlp(args, options);
  if (code !== 0) {
    const err = new Error(extractYtdlpError(stderr || stdout));
    err.output = `${stderr}\n${stdout}`;
    err.exitCode = code;
    throw err;
  }
  return { stdout, stderr };
}

/** Ambil pesan ERROR paling akhir dari output yt-dlp. */
function extractYtdlpError(output) {
  const matches = String(output || '').match(/\[.*?\]\s*ERROR:\s*(.+)/gi);
  if (matches && matches.length) {
    return matches[matches.length - 1].replace(/^\[.*?\]\s*ERROR:\s*/i, '').trim();
  }
  const text = String(output || '').trim().split(/\r?\n/).filter(Boolean).pop();
  return text || 'yt-dlp gagal tanpa pesan error.';
}

/** Deteksi kegagalan yang berkaitan dengan PO Token / pemblokiran bot. */
function isTokenRelated(err) {
  const text = String(err?.output || err?.message || err);
  return /po.?token|Missing required Visitor Data|not a bot|Sign in to confirm|HTTP Error 403|HTTP Error 429/i.test(
    text
  );
}

/**
 * Jalankan operasi YouTube dengan PO Token + strategi retry.
 * @param {(token: {visitorData:string, poToken:string}|null) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPoToken(fn) {
  try {
    return await fn(await poToken.getPoToken());
  } catch (err) {
    if (!isTokenRelated(err)) throw err;

    // Percobaan kedua: token segar.
    console.warn('[yt-dlp] Kemungkinan masalah PO Token, membuat token baru...', err.message);
    poToken.invalidate();
    try {
      return await fn(await poToken.getPoToken({ force: true }));
    } catch (err2) {
      // Percobaan ketiga: tanpa PO token sama sekali (klien default yt-dlp
      // yang saat ini tidak wajib token). Lebih baik tetap melayani user
      // daripada gagal total.
      console.warn('[yt-dlp] Masih gagal, mencoba tanpa PO Token...', err2.message);
      return await fn(null);
    }
  }
}

/** Ambil metadata video (tanpa mengunduh). */
async function fetchInfo(videoId) {
  const url = canonicalUrl(videoId);
  return withPoToken(async (token) => {
    const args = baseArgs(token);
    args.push('--dump-json', '--skip-download', url);
    const { stdout } = await runChecked(args, { timeoutMs: config.infoTimeoutMs });

    const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
    if (!line) throw new Error('YouTube tidak mengembalikan info video.');
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      throw new Error('Gagal membaca info video dari YouTube.');
    }

    return {
      id: data.id || videoId,
      title: String(data.title || '').slice(0, 300) || 'Audio tanpa judul',
      duration: Number.isFinite(data.duration) ? Math.round(data.duration) : 0,
      uploader: String(data.uploader || data.channel || '').slice(0, 150),
      thumbnail:
        typeof data.thumbnail === 'string' && data.thumbnail.startsWith('https://')
          ? data.thumbnail
          : `https://i.ytimg.com/vi/${data.id || videoId}/hqdefault.jpg`,
      viewCount: Number.isFinite(data.view_count) ? data.view_count : null,
      isLive: Boolean(data.is_live || data.live_status === 'is_live'),
      webpageUrl: canonicalUrl(videoId),
    };
  });
}

/**
 * Konversi video YouTube menjadi MP3 pada bitrate yang dipilih.
 * @param {{jobId:string, videoId:string, quality:number, onProgress?:(p:{stage?:string,percent?:number})=>void}} options
 * @returns {Promise<{filePath:string}>}
 */
async function downloadMp3({ jobId, videoId, quality, onProgress }) {
  if (!fs.existsSync(config.tempDir)) {
    fs.mkdirSync(config.tempDir, { recursive: true });
  }

  const url = canonicalUrl(videoId);
  const outTemplate = path.join(config.tempDir, `${jobId}.%(ext)s`);

  const result = await withPoToken(async (token) => {
    const args = baseArgs(token);
    args.push(
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      `${quality}K`,
      '--newline',
      '--no-mtime',
      '--progress-template',
      'download:__PROGRESS__%(progress._percent_str)s',
      '-o',
      outTemplate,
      url
    );

    return runChecked(args, {
      timeoutMs: config.downloadTimeoutMs,
      onLine: (line) => {
        const match = line.match(/__PROGRESS__\s*([\d.]+)%/) || line.match(/\[download\]\s+([\d.]+)%/);
        if (match) {
          const pct = Math.min(89, Math.round(parseFloat(match[1]) * 0.89));
          onProgress?.({ stage: 'downloading', percent: pct });
          return;
        }
        if (/\[(?:ExtractAudio|Merger|ffmpeg|FixupM4a|FixupStsd|FixupTs)/i.test(line)) {
          onProgress?.({ stage: 'converting', percent: 92 });
        }
      },
    });
  });

  // File final mengikuti output template: <jobId>.mp3
  const filePath = findOutputFile(jobId);
  if (!filePath) {
    throw new Error(`Konversi selesai tetapi file MP3 tidak ditemukan. ${result ? '' : ''}`.trim());
  }
  onProgress?.({ stage: 'converting', percent: 98 });
  return { filePath };
}

/** Cari file hasil konversi untuk sebuah job. */
function findOutputFile(jobId) {
  let entries;
  try {
    entries = fs.readdirSync(config.tempDir);
  } catch {
    return null;
  }
  const exact = entries.find((name) => name === `${jobId}.mp3`);
  if (exact) return path.join(config.tempDir, exact);
  const any = entries.find((name) => name.startsWith(`${jobId}.`));
  return any ? path.join(config.tempDir, any) : null;
}

/** Hapus semua file sementara milik sebuah job. */
function cleanupJobFiles(jobId) {
  try {
    for (const name of fs.readdirSync(config.tempDir)) {
      if (name.startsWith(`${jobId}.`)) {
        try {
          fs.unlinkSync(path.join(config.tempDir, name));
        } catch {
          /* abaikan */
        }
      }
    }
  } catch {
    /* folder mungkin belum ada */
  }
}

/** Bersihkan nama file agar aman di semua OS. */
function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 150)
    .trim();
  return cleaned || 'audio';
}

/** Ubah error teknis menjadi pesan ramah pengguna (Bahasa Indonesia). */
function humanizeError(err) {
  const text = String(err?.output || err?.message || err);
  const rules = [
    [/Sign in to confirm you'?re not a bot|not a bot/i, 'YouTube mendeteksi server sebagai bot dan memblokir permintaan. Coba lagi beberapa menit lagi.'],
    [/Private video|members-only|This video is private/i, 'Video ini bersifat privat atau khusus member.'],
    [/Video unavailable|not available|has been removed/i, 'Video tidak tersedia, dibatasi wilayah, atau sudah dihapus.'],
    [/age.?restricted|confirm your age/i, 'Video ini memiliki batasan usia.'],
    [/Live event will begin|is live/i, 'Video sedang live streaming dan tidak bisa dikonversi.'],
    [/Unsupported URL|invalid URL/i, 'URL YouTube tidak dikenali.'],
    [/Missing required Visitor Data/i, 'Gagal memvalidasi sesi ke YouTube. Silakan coba lagi.'],
    [/HTTP Error 403/i, 'YouTube menolak permintaan (403). Coba lagi atau gunakan kualitas lain.'],
    [/HTTP Error 429|rate.?limit/i, 'Terlalu banyak permintaan ke YouTube. Tunggu beberapa menit lalu coba lagi.'],
    [/timeout|Waktu proses habis/i, 'Proses terlalu lama dan dibatalkan. Coba lagi.'],
    [/ffmpeg|ffprobe/i, 'Server tidak memiliki ffmpeg untuk konversi audio.'],
    [/Gagal menjalankan/i, text.slice(0, 300)],
  ];
  for (const [pattern, message] of rules) {
    if (pattern.test(text)) return message;
  }
  return `Gagal memproses video: ${String(err?.message || 'kesalahan tidak diketahui').slice(0, 200)}`;
}

module.exports = {
  parseVideoId,
  canonicalUrl,
  fetchInfo,
  downloadMp3,
  cleanupJobFiles,
  sanitizeFilename,
  humanizeError,
  findOutputFile,
};
