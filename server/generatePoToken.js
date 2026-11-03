'use strict';

/**
 * Pembangkit PO Token — dijalankan sebagai SUBPROCESS oleh server/poToken.js.
 *
 * Mengapa subprocess?
 *  -------------------
 * Package asli `youtube-po-token-generator` menyimpan token di dalam loop:
 *
 *     while (true) { ... if (poToken.length === 164) return { poToken } }
 *
 * Sejak YouTube mengubah format/behavior, fungsi yang di-hook bisa mengembalikan:
 *   1. string error (base64 berisi "DFO:Invalid::Error" + stack trace), atau
 *   2. token berformat BARU yang panjangnya bukan 164 (mis. 692 karakter).
 * Akibatnya loop tidak pernah berakhir -> JavaScript heap out of memory dan
 * proses mati. Dengan subprocess + batas memori & waktu, kegagalan di sini
 * TIDAK menjatuhkan server utama.
 *
 * Skrip ini memakai file vendor + inject.js dari package tersebut (lisensi MIT,
 * https://github.com/YunzheZJU/youtube-po-token-generator) — hanya orkestrasi
 * dan validasinya yang diperbaiki:
 *   - ada batas percobaan & timeout,
 *   - polyfill API browser yang hilang di jsdom (performance.timing dkk.)
 *     agar BotGuard tidak error,
 *   - token divalidasi: string error ditolak, kandidat token asli diterima
 *     berapa pun panjangnya.
 *
 * Keluaran stdout (satu baris JSON):
 *   sukses : {"visitorData":"...","poToken":"..."}
 *   gagal  : (exit code 1) {"error":"pesan"} di stderr
 */

const fs = require('fs');
const path = require('path');

const pkgDir = path.dirname(require.resolve('youtube-po-token-generator/package.json'));
const { JSDOM, VirtualConsole } = require(require.resolve('jsdom', { paths: [pkgDir] }));
const { userAgent, url } = require(path.join(pkgDir, 'lib', 'consts.js'));
const { fetchVisitorData } = require(path.join(pkgDir, 'lib', 'workflow.js'));

const MAX_ATTEMPTS = 6;
const ATTEMPT_TIMEOUT_MS = 12_000;
const TOTAL_TIMEOUT_MS = 55_000;

// ---------------------------------------------------------------------------
// Proxy (opsional) — sama dengan perilaku bin/cli.mjs package asli.
// ---------------------------------------------------------------------------
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  try {
    require('global-agent/bootstrap.js');
    if (global.GLOBAL_AGENT) {
      global.GLOBAL_AGENT.HTTPS_PROXY ||= process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    }
  } catch (err) {
    console.error(`[gen-po] global-agent tidak tersedia: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Polyfill lingkungan jsdom
// ---------------------------------------------------------------------------

/**
 * YouTube/BotGuard membaca performance.timing.responseStart; jsdom tidak
 * menyediakannya sehingga program BotGuard melempar "DFO:Invalid::Error".
 */
function applyPolyfills(window) {
  const navigationStart = Date.now() - 800;
  const timing = {
    navigationStart,
    unloadEventStart: 0,
    unloadEventEnd: 0,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart: navigationStart + 5,
    domainLookupStart: navigationStart + 6,
    domainLookupEnd: navigationStart + 8,
    connectStart: navigationStart + 8,
    connectEnd: navigationStart + 25,
    secureConnectionStart: navigationStart + 10,
    requestStart: navigationStart + 26,
    responseStart: navigationStart + 70,
    responseEnd: navigationStart + 95,
    domLoading: navigationStart + 110,
    domInteractive: navigationStart + 180,
    domContentLoadedEventStart: navigationStart + 190,
    domContentLoadedEventEnd: navigationStart + 210,
    domComplete: navigationStart + 700,
    loadEventStart: 0,
    loadEventEnd: 0,
  };

  const define = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { value, configurable: true, writable: true });
    } catch {
      /* sudah ada / tidak bisa diubah — abaikan */
    }
  };

  define(window.performance, 'timing', timing);
  define(window.performance, 'navigation', { type: 0, redirectCount: 0 });

  define(window.screen, 'width', 1920);
  define(window.screen, 'height', 1080);
  define(window.screen, 'availWidth', 1920);
  define(window.screen, 'availHeight', 1040);
  define(window.screen, 'colorDepth', 24);
  define(window.screen, 'pixelDepth', 24);
  define(window, 'devicePixelRatio', 1);

  // Beberapa skrip YouTube memakai API ini; jsdom tidak menyediakannya.
  if (typeof window.requestIdleCallback !== 'function') {
    define(window, 'requestIdleCallback', (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1));
    define(window, 'cancelIdleCallback', (id) => clearTimeout(id));
  }
}

// ---------------------------------------------------------------------------
// Validasi token
// ---------------------------------------------------------------------------

/**
 * Tolak string error (biasanya base64 yang decode-nya berisi pesan error)
 * dan terima kandidat token asli berapa pun panjangnya.
 */
function looksLikeToken(token) {
  if (typeof token !== 'string') return false;
  if (token.length < 80 || token.length > 8192) return false;
  if (!/^[A-Za-z0-9_\-+/=]+$/.test(token)) return false;

  // Error dari BotGuard, mis. base64("DFO:Invalid::Error\n at new qj ...")
  if (/Error|Invalid::|Cannot read|is not defined/.test(token)) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch {
    /* bukan base64 — biarkan */
  }
  if (/Error|Invalid::|Cannot read|is not defined|undefined/.test(decoded)) return false;

  // Token asli tampak seperti byte acak (bukan teks ASCII panjang).
  const printable = decoded.replace(/[^\x20-\x7e]/g, '');
  if (decoded.length > 0 && printable.length > decoded.length * 0.9 && decoded.length > 100) {
    return false; // hasil decode hanyalah teks -> bukan token
  }

  return true;
}

// ---------------------------------------------------------------------------
// Loop pembuatan token
// ---------------------------------------------------------------------------

function runAttempt({ domContent, baseContent, appendContent, visitorData }) {
  return new Promise((resolve) => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {
      /* error jsdom dari skrip YouTube: abaikan, kita tangani lewat timeout */
    });

    const { window } = new JSDOM(domContent, {
      url,
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      virtualConsole,
    });

    applyPolyfills(window);
    Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, writable: false });
    window.visitorData = visitorData;

    let settled = false;
    const finish = (token) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        window.close();
      } catch {
        /* abaikan */
      }
      resolve(token);
    };

    const timer = setTimeout(() => finish(null), ATTEMPT_TIMEOUT_MS);

    // Hook menangkap SEMUA hasil (termasuk string error) — pilih yang valid.
    window.onPoToken = (token) => {
      if (looksLikeToken(token)) finish(token);
    };

    try {
      window.eval(
        baseContent.replace(/}\s*\)\(_yt_player\);\s*$/, (matched) => `;${appendContent};${matched}`)
      );
    } catch {
      finish(null);
    }
  });
}

async function main() {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  const visitorData = await fetchVisitorData();
  if (!visitorData || visitorData.length < 10) {
    throw new Error('visitorData tidak valid');
  }

  const domContent = fs.readFileSync(path.join(pkgDir, 'vendor', 'index.html'), 'utf8');
  const baseContent = fs.readFileSync(path.join(pkgDir, 'vendor', 'base.js'), 'utf8');
  const appendContent = fs.readFileSync(path.join(pkgDir, 'lib', 'inject.js'), 'utf8');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() > deadline) break;

    const poToken = await runAttempt({ domContent, baseContent, appendContent, visitorData });
    if (poToken) {
      process.stdout.write(JSON.stringify({ visitorData, poToken }));
      return;
    }
    console.error(`[gen-po] percobaan ${attempt} tidak menghasilkan token valid`);
  }

  throw new Error(`token tidak valid setelah ${MAX_ATTEMPTS} percobaan`);
}

main().catch((err) => {
  process.stderr.write(String(err && err.message ? err.message : err));
  process.exit(1);
});
