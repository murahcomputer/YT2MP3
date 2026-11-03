'use strict';

/**
 * Server utama: Express + API konversi YouTube -> MP3 + file statis frontend.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { config, SUPPORTED_QUALITIES } = require('./config');
const poToken = require('./poToken');
const youtube = require('./youtube');
const jobs = require('./jobs');

const app = express();
app.set('trust proxy', 1); // di belakang nginx: pakai X-Forwarded-For untuk rate limit
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// ---------------------------------------------------------------------------
// Rate limit sederhana per IP (tanpa dependensi ekstra)
// ---------------------------------------------------------------------------
const rateLimitStores = new Set();

function createRateLimiter(getMax) {
  const hits = new Map(); // ip -> number[] (timestamp)
  rateLimitStores.add(hits);
  return (req, res, next) => {
    const now = Date.now();
    const windowMs = config.rateLimit.windowMs;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= getMax()) {
      hits.set(ip, list);
      res.status(429).json({
        error: 'Terlalu banyak permintaan dari IP Anda. Coba lagi dalam satu menit.',
      });
      return;
    }
    list.push(now);
    hits.set(ip, list);
    next();
  };
}

const infoLimiter = createRateLimiter(() => config.rateLimit.infoMax);
const jobLimiter = createRateLimiter(() => config.rateLimit.jobMax);

// Bersihkan peta rate limit berkala agar tidak tumbuh tanpa batas.
setInterval(() => {
  const now = Date.now();
  for (const hits of rateLimitStores) {
    for (const [ip, list] of hits) {
      const kept = list.filter((t) => now - t < config.rateLimit.windowMs * 2);
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    }
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Endpoint API
// ---------------------------------------------------------------------------

/** Analisis URL YouTube -> metadata video. */
app.post('/api/info', infoLimiter, async (req, res) => {
  const videoId = youtube.parseVideoId(req.body?.url);
  if (!videoId) {
    res.status(400).json({
      error: 'URL YouTube tidak valid. Contoh yang didukung: https://www.youtube.com/watch?v=... , https://youtu.be/...',
    });
    return;
  }

  try {
    const info = await youtube.fetchInfo(videoId);
    if (info.isLive) {
      res.status(422).json({ error: 'Video sedang live streaming dan tidak bisa dikonversi.' });
      return;
    }
    res.json(info);
  } catch (err) {
    console.error('[info] gagal:', err?.output || err?.message || err);
    res.status(502).json({ error: youtube.humanizeError(err) });
  }
});

/** Mulai job konversi. */
app.post('/api/jobs', jobLimiter, (req, res) => {
  const videoId = youtube.parseVideoId(req.body?.url);
  if (!videoId) {
    res.status(400).json({ error: 'URL YouTube tidak valid.' });
    return;
  }

  const quality = Number(req.body?.quality);
  if (!SUPPORTED_QUALITIES.includes(quality)) {
    res.status(400).json({
      error: `Kualitas tidak didukung. Pilih salah satu: ${SUPPORTED_QUALITIES.join(', ')} kbps.`,
    });
    return;
  }

  if (jobs.activeCount() >= config.maxConcurrentJobs) {
    res.status(429).json({ error: 'Server sedang memproses banyak permintaan. Coba lagi sebentar.' });
    return;
  }

  const title = typeof req.body?.title === 'string' ? req.body.title : null;
  const job = jobs.createJob({ url: youtube.canonicalUrl(videoId), videoId, quality, title });
  console.log(`[job ${job.id}] dibuat: ${videoId} @ ${quality}kbps`);

  // Jalankan asinkron; perubahan status dikirim lewat SSE.
  jobs.startJob(job);

  res.status(201).json({ id: job.id });
});

/** Status job (fallback bila SSE terputus). */
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job tidak ditemukan atau sudah kedaluwarsa.' });
    return;
  }
  res.json(jobs.toJSON(job));
});

/** Live update status job via Server-Sent Events. */
app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) {
    res.status(404).end();
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: jangan buffer SSE
  });
  res.flushHeaders?.();

  const send = (payload) => res.write(payload);
  const unsubscribe = jobs.subscribe(job, send);

  // Kirim state terkini saat klien baru connect.
  send(`event: update\ndata: ${JSON.stringify(jobs.toJSON(job))}\n\n`);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** Unduh hasil MP3. */
app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'File tidak ditemukan atau sudah kedaluwarsa.' });
    return;
  }
  if (job.status !== 'done' || !job.filePath) {
    res.status(409).json({ error: 'Konversi belum selesai.' });
    return;
  }
  if (!fs.existsSync(job.filePath)) {
    res.status(410).json({ error: 'File sudah dihapus dari server. Silakan konversi ulang.' });
    return;
  }

  const baseName = youtube.sanitizeFilename(job.title || job.videoId);
  res.download(job.filePath, `${baseName} [${job.quality}kbps].mp3`, (err) => {
    if (err) console.error('[file] gagal kirim:', err.message);
  });
});

/** Kesehatan server: binary, PO token, jumlah job. */
app.get('/api/health', async (_req, res) => {
  const check = (cmd, args) =>
    new Promise((resolve) => {
      const { spawn } = require('child_process');
      const child = spawn(cmd, args, { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => resolve({ ok: false, version: null }));
      child.on('close', (code) =>
        resolve({ ok: code === 0, version: (out.split(/\r?\n/)[0] || '').trim() || null })
      );
      setTimeout(() => child.kill(), 8000);
    });

  const [ytdlp, ffmpeg] = await Promise.all([
    check(config.ytdlpPath, ['--version']),
    check(config.ffmpegPath, ['-version']),
  ]);

  res.json({
    ok: ytdlp.ok && ffmpeg.ok,
    ytdlp,
    ffmpeg,
    poToken: poToken.status(),
    activeJobs: jobs.activeCount(),
    maxConcurrentJobs: config.maxConcurrentJobs,
    qualities: SUPPORTED_QUALITIES,
  });
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
const publicDir = path.join(__dirname, '..', 'public');
// maxAge 0 -> browser selalu revalidasi via ETag (304 murah), sehingga
// perubahan aset langsung terlihat setelah deploy/restart.
app.use(express.static(publicDir, { index: 'index.html', maxAge: 0, etag: true }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// 404 API
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] error:', err);
  res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({
    error: err.type === 'entity.parse.failed' ? 'Body JSON tidak valid.' : 'Terjadi kesalahan pada server.',
  });
});

// ---------------------------------------------------------------------------
// Startup & housekeeping
// ---------------------------------------------------------------------------
const server = app.listen(config.port, config.host, () => {
  console.log(`YT2MP3 berjalan di http://${config.host}:${config.port}`);
  console.log(`  yt-dlp : ${config.ytdlpPath}`);
  console.log(`  ffmpeg : ${config.ffmpegPath}`);
  console.log(`  PO     : ${config.poClient}, TTL ${Math.round(config.poTokenTtlMs / 60000)} menit`);
  poToken.warmUp();
});

// Prune job & file berkala.
setInterval(() => jobs.prune(), 60 * 1000).unref();

function shutdown(signal) {
  console.log(`\n[server] menerima ${signal}, berhenti...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
