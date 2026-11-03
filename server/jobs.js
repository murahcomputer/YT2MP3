'use strict';

/**
 * Penyimpanan & orkestrasi job konversi.
 *
 * Setiap job melewati status: queued -> running -> done | error
 * dan stage: preparing -> downloading -> converting -> done
 * Perubahan apapun di-broadcast ke semua klien SSE yang subscribe job ini.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { config } = require('./config');
const youtube = require('./youtube');

/** @type {Map<string, object>} */
const jobs = new Map();

function createJob({ url, videoId, quality, title }) {
  const id = randomUUID();
  const job = {
    id,
    url,
    videoId,
    quality,
    title: title ? String(title).slice(0, 300) : null,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    status: 'queued', // queued | running | done | error
    stage: 'queued', // queued | preparing | downloading | converting | done | error
    progress: 0,
    fileSize: null,
    filePath: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    listeners: new Set(),
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function update(job, patch) {
  Object.assign(job, patch);
  job.updatedAt = Date.now();
  broadcast(job);
}

function broadcast(job) {
  if (!job.listeners.size) return;
  const payload = `event: update\ndata: ${JSON.stringify(toJSON(job))}\n\n`;
  for (const send of job.listeners) {
    try {
      send(payload);
    } catch {
      job.listeners.delete(send);
    }
  }
}

/** Bentuk job yang aman dikirim ke klien (tanpa listener/path internal). */
function toJSON(job) {
  let hasFile = false;
  if (job.filePath) {
    try {
      hasFile = fs.existsSync(job.filePath);
    } catch {
      hasFile = false;
    }
  }
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    title: job.title,
    thumbnail: job.thumbnail,
    quality: job.quality,
    videoId: job.videoId,
    fileSize: job.fileSize,
    error: job.error,
    hasFile,
  };
}

/** Subscribe perubahan job (untuk SSE). Return fungsi unsubscribe. */
function subscribe(job, send) {
  job.listeners.add(send);
  return () => job.listeners.delete(send);
}

function activeCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'queued' || job.status === 'running') count += 1;
  }
  return count;
}

/** Jalankan job konversi (dipanggil sekali, jangan diawait dari route). */
async function startJob(job) {
  update(job, { status: 'running', stage: 'preparing', progress: 3 });
  try {
    const { filePath } = await youtube.downloadMp3({
      jobId: job.id,
      videoId: job.videoId,
      quality: job.quality,
      onProgress: ({ stage, percent }) => {
        const patch = {};
        if (stage) patch.stage = stage;
        // Progres dibuat monoton agar tidak "mundur" saat retry.
        if (typeof percent === 'number' && percent > job.progress) patch.progress = percent;
        if (Object.keys(patch).length) update(job, patch);
      },
    });

    let fileSize = null;
    try {
      fileSize = fs.statSync(filePath).size;
    } catch {
      /* file mungkin sudah dibersihkan */
    }

    update(job, {
      status: 'done',
      stage: 'done',
      progress: 100,
      filePath,
      fileSize,
      title: job.title || job.videoId,
      finishedAt: Date.now(),
    });
    console.log(`[job ${job.id}] selesai: ${job.title || job.videoId} (${job.quality}kbps)`);
  } catch (err) {
    console.error(`[job ${job.id}] gagal:`, err?.output || err?.message || err);
    youtube.cleanupJobFiles(job.id);
    update(job, {
      status: 'error',
      stage: 'error',
      error: youtube.humanizeError(err),
      finishedAt: Date.now(),
    });
  }
}

/** Hapus job kedaluwarsa + file MP3 yang tidak terpakai. */
function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const done = job.status === 'done' || job.status === 'error';
    if (done && now - (job.finishedAt || job.updatedAt) > config.jobTtlMs) {
      if (job.filePath) youtube.cleanupJobFiles(id);
      jobs.delete(id);
    }
  }

  // File yatim di folder temp (bukan milik job aktif) ikut dibersihkan.
  try {
    const activePrefixes = new Set();
    for (const job of jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') activePrefixes.add(job.id);
    }
    for (const name of fs.readdirSync(config.tempDir)) {
      const jobId = name.split('.')[0];
      if (activePrefixes.has(jobId)) continue;
      const target = path.join(config.tempDir, name);
      try {
        const stat = fs.statSync(target);
        if (now - stat.mtimeMs > config.jobTtlMs) fs.unlinkSync(target);
      } catch {
        /* abaikan */
      }
    }
  } catch {
    /* folder temp belum ada */
  }
}

module.exports = { createJob, getJob, activeCount, startJob, subscribe, toJSON, prune };
