'use strict';

/**
 * Pengelola PO Token (Proof of Origin) untuk YouTube.
 *
 * Token dibuat oleh server/generatePoToken.js yang dijalankan sebagai
 * SUBPROCESS terpisah (bukan di dalam proses server) dengan alasan:
 *   - generator asli bisa loop tak berhenti & OOM bila format token berubah;
 *   - dengan subprocess + timeout & batas memori, kegagalan hanya memengaruhi
 *     satu request, tidak menjatuhkan seluruh website.
 *
 * Hasil { visitorData, poToken } di-cache dan dipakai ulang selama
 * config.poTokenTtlMs. Jika download gagal karena token, panggil invalidate()
 * lalu getPoToken({ force: true }) untuk memaksa pembuatan baru.
 */

const { spawn } = require('child_process');
const path = require('path');
const { config } = require('./config');

const GENERATOR_SCRIPT = path.join(__dirname, 'generatePoToken.js');
const GENERATOR_TIMEOUT_MS = 70 * 1000;
const GENERATOR_MEMORY_MB = 768;

/** @type {{ visitorData: string, poToken: string, createdAt: number } | null} */
let cache = null;

/** Promise generate yang sedang berjalan (supaya tidak dobel). */
let inflight = null;

/** Error terakhir saat generate (untuk /api/health). */
let lastError = null;

/** Jalankan generator sebagai subprocess node. */
function runGenerator() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${GENERATOR_MEMORY_MB}`, GENERATOR_SCRIPT], {
      env: process.env, // HTTPS_PROXY/HTTP_PROXY ikut terbawa ke generator
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* sudah mati */
      }
      reject(new Error('Timeout: pembuatan PO token melebihi 70 detik.'));
    }, GENERATOR_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `Generator PO token berhenti dengan kode ${code}.`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (!parsed.visitorData || !parsed.poToken) {
          throw new Error('field visitorData/poToken tidak ada');
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Output generator tidak terbaca: ${err.message}`));
      }
    });
  });
}

function isFresh(token) {
  return Boolean(token) && Date.now() - token.createdAt < config.poTokenTtlMs;
}

/**
 * Ambil pasangan { visitorData, poToken } yang masih berlaku.
 * @param {{ force?: boolean }} [options] force=true -> abaikan cache, buat baru.
 */
async function getPoToken(options = {}) {
  if (!options.force && isFresh(cache)) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { visitorData, poToken } = await runGenerator();
      cache = { visitorData, poToken, createdAt: Date.now() };
      lastError = null;
      console.log(
        `[po-token] Token baru dibuat (poToken=${poToken.length} char, ` +
          `berlaku ${Math.round(config.poTokenTtlMs / 60000)} menit)`
      );
      return cache;
    } catch (err) {
      lastError = err;
      console.error('[po-token] Gagal membuat token:', err.message);
      throw err;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Buang cache token (dipanggil saat download gagal karena token). */
function invalidate() {
  cache = null;
}

/** Status untuk /api/health. */
function status() {
  return {
    ready: isFresh(cache),
    ageSeconds: cache ? Math.round((Date.now() - cache.createdAt) / 1000) : null,
    ttlSeconds: Math.round(config.poTokenTtlMs / 1000),
    client: config.poClient,
    lastError: lastError ? String(lastError.message || lastError) : null,
  };
}

/** Panaskan token saat server start supaya request pertama pengguna cepat. */
function warmUp() {
  getPoToken().catch((err) => {
    console.warn('[po-token] Gagal panas-panas awal (akan dicoba lagi otomatis):', err.message);
  });
}

module.exports = { getPoToken, invalidate, status, warmUp };
