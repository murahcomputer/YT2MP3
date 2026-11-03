'use strict';

/**
 * Diagnostik: mengapa youtube-po-token-generator bisa hang/OOM?
 * Meniru logika lib/task.js tapi dengan logging & batas percobaan.
 *
 * Jalankan: node scripts/debug-po.js
 */

const fs = require('fs/promises');
const path = require('path');

// jsdom terpasang nested di dalam youtube-po-token-generator (ada shrinkwrap),
// jadi resolve dari direktori package-nya lebih aman.
const pkgDir = path.dirname(require.resolve('youtube-po-token-generator/package.json'));
const { JSDOM, VirtualConsole } = require(require.resolve('jsdom', { paths: [pkgDir] }));

const root = pkgDir;
const { userAgent, url } = require(path.join(root, 'lib', 'consts.js'));
const { fetchVisitorData } = require(path.join(root, 'lib', 'workflow.js'));

const MAX_ATTEMPTS = 10;
const ATTEMPT_TIMEOUT_MS = 20000;
const TOTAL_TIMEOUT_MS = 90000;

(async () => {
  console.log('1) fetch visitorData dari YouTube...');
  const visitorData = await fetchVisitorData();
  console.log(`   OK, visitorData length = ${visitorData.length}`);

  const domContent = await fs.readFile(path.join(root, 'vendor', 'index.html'), 'utf-8');
  const baseContent = await fs.readFile(path.join(root, 'vendor', 'base.js'), 'utf-8');
  const appendContent = await fs.readFile(path.join(root, 'lib', 'inject.js'), 'utf-8');
  console.log(
    `2) vendor siap: index.html=${domContent.length}B base.js=${baseContent.length}B inject.js=${appendContent.length}B`
  );

  const startedAt = Date.now();
  const totalTimer = setTimeout(() => {
    console.log(`TIMEOUT total ${TOTAL_TIMEOUT_MS / 1000}s tercapai`);
    process.exit(2);
  }, TOTAL_TIMEOUT_MS);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const t0 = Date.now();
    let poToken = null;
    let error = null;

    try {
      poToken = await new Promise((resolve, reject) => {
        const virtualConsole = new VirtualConsole();
        virtualConsole.on('jsdomError', (err) => console.log('   [jsdomError]', err.message));
        virtualConsole.on('error', (...args) =>
          console.log('   [console.error]', args.map(String).join(' ').slice(0, 300))
        );
        virtualConsole.on('warn', (...args) =>
          console.log('   [console.warn]', args.map(String).join(' ').slice(0, 300))
        );

        const { window } = new JSDOM(domContent, {
          url,
          pretendToBeVisual: true,
          runScripts: 'dangerously',
          virtualConsole,
        });
        Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, writable: false });
        window.visitorData = visitorData;
        window.onPoToken = (token) => resolve(token);

        const attemptTimer = setTimeout(() => {
          try {
            window.close();
          } catch {
            /* abaikan */
          }
          reject(new Error('timeout: onPoToken tidak pernah dipanggil'));
        }, ATTEMPT_TIMEOUT_MS);

        try {
          window.eval(
            baseContent.replace(/}\s*\)\(_yt_player\);\s*$/, (matched) => `;${appendContent};${matched}`)
          );
        } catch (err) {
          clearTimeout(attemptTimer);
          reject(err);
          return;
        }

        // Bersihkan timer bila token diterima lebih dulu.
        window.onPoToken = (token) => {
          clearTimeout(attemptTimer);
          resolve(token);
        };
      });
    } catch (err) {
      error = err;
    }

    const elapsed = Date.now() - startedAt;
    console.log(
      `   percobaan #${attempt}: ${error ? `ERROR "${error.message}"` : `poToken length = ${poToken.length}`}` +
        ` (${elapsed}ms total)`
    );

    if (poToken && poToken.length === 164) {
      console.log('SUCCESS: token valid (164 karakter).');
      clearTimeout(totalTimer);
      process.exit(0);
    }
  }

  clearTimeout(totalTimer);
  console.log(`GAGAL: token tidak pernah 164 karakter dalam ${MAX_ATTEMPTS} percobaan.`);
  process.exit(1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
