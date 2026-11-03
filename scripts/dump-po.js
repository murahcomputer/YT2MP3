'use strict';

/**
 * Dump isi poToken yang dihasilkan untuk analisis format baru.
 * Jalankan: node scripts/dump-po.js
 */

const fs = require('fs/promises');
const path = require('path');

const pkgDir = path.dirname(require.resolve('youtube-po-token-generator/package.json'));
const { JSDOM, VirtualConsole } = require(require.resolve('jsdom', { paths: [pkgDir] }));
const { userAgent, url } = require(path.join(pkgDir, 'lib', 'consts.js'));
const { fetchVisitorData } = require(path.join(pkgDir, 'lib', 'workflow.js'));

(async () => {
  const visitorData = await fetchVisitorData();
  console.log('visitorData:', visitorData.slice(0, 40) + '...');

  const domContent = await fs.readFile(path.join(pkgDir, 'vendor', 'index.html'), 'utf-8');
  const baseContent = await fs.readFile(path.join(pkgDir, 'vendor', 'base.js'), 'utf-8');
  const appendContent = await fs.readFile(path.join(pkgDir, 'lib', 'inject.js'), 'utf-8');

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  const { window } = new JSDOM(domContent, {
    url,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    virtualConsole,
  });
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, writable: false });
  window.visitorData = visitorData;

  const collected = [];
  window.onPoToken = (token) => collected.push(token);

  window.eval(
    baseContent.replace(/}\s*\)\(_yt_player\);\s*$/, (matched) => `;${appendContent};${matched}`)
  );

  await new Promise((r) => setTimeout(r, 8000));

  console.log('jumlah token terkumpul:', collected.length);
  collected.forEach((token, i) => {
    console.log(`\n--- token #${i + 1} (panjang ${token.length}) ---`);
    console.log('head   :', token.slice(0, 160));
    console.log('tail   :', token.slice(-80));
    console.log('ada "poToken"?', /potoken/i.test(token));
    console.log('ada "error"?', /error|denied|blocked/i.test(token));
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      console.log('base64 decode head:', decoded.slice(0, 300));
      try {
        const json = JSON.parse(decoded);
        console.log('JSON keys:', Object.keys(json));
        if (json.bytes) console.log('bytes length:', json.bytes.length, 'head:', String(json.bytes).slice(0, 100));
      } catch {
        /* bukan JSON */
      }
    } catch {
      /* bukan base64 */
    }
  });

  process.exit(0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
