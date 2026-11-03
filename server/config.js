'use strict';

const fs = require('fs');
const path = require('path');

/** Muat file .env sederhana tanpa dependensi ekstra. */
function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

loadDotEnv();

const SUPPORTED_QUALITIES = [128, 192, 256, 320];

/**
 * User-Agent yang SAMA PERSIS dengan yang dipakai youtube-po-token-generator
 * saat membuat poToken (lihat lib/consts.js pada package tersebut).
 * Karena poToken terikat ke user-agent, yt-dlp juga harus memakai UA ini
 * agar token diterima YouTube.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';

function intEnv(name, fallback) {
  const value = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function minutesEnv(name, fallbackMinutes) {
  return Math.max(1, intEnv(name, fallbackMinutes)) * 60 * 1000;
}

const config = {
  port: intEnv('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Binary eksternal
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',

  // Folder kerja untuk file sementara hasil konversi
  tempDir: process.env.TEMP_DIR || path.join(__dirname, '..', 'tmp'),

  // --- PO Token ---
  poClient: process.env.PO_CLIENT || 'web.gvs',
  poTokenTtlMs: minutesEnv('PO_TOKEN_TTL_MINUTES', 20),
  // Saat visitor_data eksternal dipakai, yt-dlp menyarankan skip permintaan
  // halaman agar cookie VISITOR_INFO1_LIVE tidak ikut campur.
  playerSkip:
    process.env.PLAYER_SKIP === undefined ? 'webpage,configs' : process.env.PLAYER_SKIP.trim(),
  userAgent: process.env.YTDLP_USER_AGENT || DEFAULT_USER_AGENT,
  proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',

  // --- Batas daya & timeout ---
  maxConcurrentJobs: Math.max(1, intEnv('MAX_CONCURRENT_JOBS', 3)),
  jobTtlMs: minutesEnv('JOB_TTL_MINUTES', 30),
  infoTimeoutMs: intEnv('INFO_TIMEOUT_MS', 90 * 1000),
  downloadTimeoutMs: intEnv('DOWNLOAD_TIMEOUT_MS', 15 * 60 * 1000),

  rateLimit: {
    windowMs: intEnv('RATE_LIMIT_WINDOW_MS', 60 * 1000),
    infoMax: Math.max(1, intEnv('RATE_LIMIT_INFO', 20)),
    jobMax: Math.max(1, intEnv('RATE_LIMIT_JOBS', 8)),
  },

  supportedQualities: SUPPORTED_QUALITIES,
};

module.exports = { config, SUPPORTED_QUALITIES, DEFAULT_USER_AGENT };
