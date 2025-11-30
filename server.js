// server.js - improved sync with Kie.ai: correct polling, task cache, controlled auto-download
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(morgan('dev'));
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const KIE_KEY = process.env.KIE_KEY;
const KIE_BASE = process.env.KIE_BASE || 'https://api.kie.ai';
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads'));
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

if (!KIE_KEY) {
  console.error('Please set KIE_KEY in .env');
  process.exit(1);
}

// serve UI static folder (public)
app.use('/', express.static(path.join(__dirname, 'public')));

/**
 * taskCache:
 *  taskId => {
 *    lastRaw: <full data returned from Kie record-info call>,
 *    status: 'PENDING'|'TEXT_SUCCESS'|'FIRST_SUCCESS'|'SUCCESS'|...,
 *    updatedAt: timestamp,
 *    downloaded: boolean,
 *    localFiles: [ { type:'audio'|'cover'|'source', path: '/abs/path', name:'...' } ]
 *  }
 */
const taskCache = new Map();
const activePolls = new Map();

async function kieRecordInfo(taskId) {
  const url = `${KIE_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`;
  const headers = { Authorization: `Bearer ${KIE_KEY}` };
  const r = await axios.get(url, { headers, timeout: 20000 });
  return r.data; // full response e.g. { code, msg, data: { taskId, status, response: { sunoData: [...] } } }
}

// Decide final statuses
const FINAL_STATUSES = new Set(['SUCCESS', 'FIRST_SUCCESS']); // only treat these as downloadable final
const ERROR_STATUSES = new Set(['CREATE_TASK_FAILED','GENERATE_AUDIO_FAILED','SENSITIVE_WORD_ERROR','CALLBACK_EXCEPTION']);

// normalize status read from Kie response
function getStatusFromKieResp(kieResp) {
  // many doc variants: kieResp.data.status or kieResp.data.response.status or kieResp.data.status
  try {
    const data = kieResp?.data || kieResp;
    const status = data?.status || data?.response?.status || (kieResp?.data && kieResp.data.status);
    return (typeof status === 'string') ? status.toUpperCase() : null;
  } catch (e) {
    return null;
  }
}

// extract sunoData array safely
function extractSunoData(kieResp) {
  try {
    const data = kieResp?.data || kieResp;
    const s = data?.response?.sunoData || data?.sunoData || data?.response || data?.data?.response?.sunoData;
    if (Array.isArray(s)) return s;
    // sometimes response.data contains sunoData under different key:
    const maybe = kieResp?.data?.data || kieResp?.data?.response;
    if (maybe?.sunoData) return maybe.sunoData;
    return [];
  } catch (e) {
    return [];
  }
}

// download helpers
async function downloadFileToPath(fileUrl, outPath) {
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return outPath;
  }
  const writer = fs.createWriteStream(outPath);
  const r = await axios.get(fileUrl, { responseType: 'stream', timeout: 60000 });
  await new Promise((resolve, reject) => {
    r.data.pipe(writer);
    let err = null;
    writer.on('error', e => { err = e; writer.close(); reject(e); });
    writer.on('close', () => { if (!err) resolve(); });
  });
  return outPath;
}

async function downloadAssetsForTask(taskId, sunoDataArray) {
  if (!Array.isArray(sunoDataArray) || sunoDataArray.length === 0) return [];
  const taskDir = path.join(DOWNLOAD_DIR, taskId);
  if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });

  const saved = [];
  for (let i = 0; i < sunoDataArray.length; i++) {
    const it = sunoDataArray[i] || {};
    const audioUrl = it.audioUrl || it.audio_url || it.streamAudioUrl || it.stream_audio_url;
    const sourceAudioUrl = it.sourceAudioUrl || it.source_audio_url;
    const imageUrl = it.imageUrl || it.image_url;
    const sourceImageUrl = it.sourceImageUrl || it.source_image_url;

    const safeTitle = ((it.title || `track_${i+1}`) + '').replace(/[\/\\?%*:|"<>]/g, '-').slice(0,100);
    const prefix = `${i+1}_${safeTitle}`;

    if (audioUrl) {
      try {
        const ext = path.extname(new URL(audioUrl).pathname) || '.mp3';
        const fname = `${prefix}${ext}`;
        const out = path.join(taskDir, fname);
        await downloadFileToPath(audioUrl, out);
        saved.push({ type: 'audio', path: out, name: fname });
      } catch (e) { /* ignore individual failures */ }
    }

    if (sourceAudioUrl) {
      try {
        const ext = path.extname(new URL(sourceAudioUrl).pathname) || '.mp3';
        const fname = `${prefix}_source${ext}`;
        const out = path.join(taskDir, fname);
        await downloadFileToPath(sourceAudioUrl, out);
        saved.push({ type: 'audio_source', path: out, name: fname });
      } catch (e) {}
    }

    if (imageUrl) {
      try {
        const ext = path.extname(new URL(imageUrl).pathname) || '.png';
        const fname = `${prefix}_cover${ext}`;
        const out = path.join(taskDir, fname);
        await downloadFileToPath(imageUrl, out);
        saved.push({ type: 'cover', path: out, name: fname });
      } catch (e) {}
    } else if (sourceImageUrl) {
      try {
        const ext = path.extname(new URL(sourceImageUrl).pathname) || '.png';
        const fname = `${prefix}_cover_source${ext}`;
        const out = path.join(taskDir, fname);
        await downloadFileToPath(sourceImageUrl, out);
        saved.push({ type: 'cover_source', path: out, name: fname });
      } catch (e) {}
    }
  }

  return saved;
}

// Start polling Kie for a taskId, update cache, and auto-download when final
function startServerSidePoll(taskId) {
  if (!taskId) return;
  if (activePolls.has(taskId)) return;
  console.log(`[poll] start polling ${taskId}`);

  // initialize cache entry
  if (!taskCache.has(taskId)) {
    taskCache.set(taskId, { lastRaw: null, status: null, updatedAt: Date.now(), downloaded: false, localFiles: [] });
  }

  let attempts = 0;
  const maxAttempts = 120; // ~10 minutes
  const intervalMs = 5000;

  const timer = setInterval(async () => {
    attempts++;
    try {
      const kieResp = await kieRecordInfo(taskId); // full response
      const status = getStatusFromKieResp(kieResp) || 'UNKNOWN';
      const sunoData = extractSunoData(kieResp);

      // update cache
      const current = taskCache.get(taskId) || {};
      current.lastRaw = kieResp;
      current.status = status;
      current.updatedAt = Date.now();
      current.sunoData = sunoData;
      taskCache.set(taskId, current);

      console.log(`[poll] ${taskId} status=${status} attempts=${attempts}`);

      // If final -> download
      if (FINAL_STATUSES.has(status)) {
        clearInterval(timer);
        activePolls.delete(taskId);
        console.log(`[poll] ${taskId} reached final status=${status} -> start auto-download`);
        try {
          const saved = await downloadAssetsForTask(taskId, sunoData);
          const entry = taskCache.get(taskId) || {};
          entry.downloaded = true;
          entry.localFiles = saved;
          entry.updatedAt = Date.now();
          taskCache.set(taskId, entry);
          console.log(`[poll] ${taskId} assets saved: ${saved.length}`);
        } catch (e) {
          console.error(`[poll] ${taskId} download error:`, e.message || e);
        }
        return;
      }

      if (ERROR_STATUSES.has(status) || attempts >= maxAttempts) {
        clearInterval(timer);
        activePolls.delete(taskId);
        console.warn(`[poll] ${taskId} stopped (status=${status}, attempts=${attempts})`);
        return;
      }

    } catch (err) {
      console.error(`[poll] error fetching record-info for ${taskId}:`, err.message || err);
      if (attempts >= maxAttempts) {
        clearInterval(timer);
        activePolls.delete(taskId);
      }
    }
  }, intervalMs);

  activePolls.set(taskId, { timer, attempts: 0 });
}

// Helper: call Kie POST proxy
async function proxyPost(relativePath, body) {
  const url = `${KIE_BASE}${relativePath}`;
  const headers = { Authorization: `Bearer ${KIE_KEY}`, 'Content-Type': 'application/json' };
  return axios.post(url, body, { headers, timeout: 20000 });
}

// Routes: proxy endpoints that return taskId and start polling
app.post('/api/generate', async (req, res) => {
  try {
    const r = await proxyPost('/api/v1/generate', req.body);
    res.json(r.data);
    const taskId = r.data?.data?.taskId || r.data?.taskId;
    if (taskId) startServerSidePoll(taskId);
  } catch (err) {
    console.error('/api/generate error', err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json(err?.response?.data || { error: err.message });
  }
});

app.post('/api/extend', async (req, res) => {
  try {
    const r = await proxyPost('/api/v1/generate/extend', req.body);
    res.json(r.data);
    const taskId = r.data?.data?.taskId || r.data?.taskId;
    if (taskId) startServerSidePoll(taskId);
  } catch (err) {
    console.error('/api/extend error', err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json(err?.response?.data || { error: err.message });
  }
});

app.post('/api/upload-cover', async (req, res) => {
  try {
    const r = await proxyPost('/api/v1/generate/upload-cover', req.body);
    res.json(r.data);
    const taskId = r.data?.data?.taskId || r.data?.taskId;
    if (taskId) startServerSidePoll(taskId);
  } catch (err) {
    console.error('/api/upload-cover error', err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json(err?.response?.data || { error: err.message });
  }
});

app.post('/api/add-instrumental', async (req, res) => {
  try {
    const r = await proxyPost('/api/v1/generate/add-instrumental', req.body);
    res.json(r.data);
    const taskId = r.data?.data?.taskId || r.data?.taskId;
    if (taskId) startServerSidePoll(taskId);
  } catch (err) {
    console.error('/api/add-instrumental error', err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json(err?.response?.data || { error: err.message });
  }
});

app.post('/api/add-vocals', async (req, res) => {
  try {
    const r = await proxyPost('/api/v1/generate/add-vocals', req.body);
    res.json(r.data);
    const taskId = r.data?.data?.taskId || r.data?.taskId;
    if (taskId) startServerSidePoll(taskId);
  } catch (err) {
    console.error('/api/add-vocals error', err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json(err?.response?.data || { error: err.message });
  }
});

app.post('/api/generate-lyrics', async (req, res) => {
  try {
    const url = `${KIE_BASE}/api/v1/lyrics`;
    const headers = { Authorization: `Bearer ${KIE_KEY}`, 'Content-Type': 'application/json' };
    const r = await axios.post(url, req.body, { headers });
    res.json(r.data);
    const taskId = r.data?.data?.taskId || r.data?.taskId;
    if (taskId) startServerSidePoll(taskId);
  } catch (err) {
    console.error('/api/generate-lyrics error', err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json(err?.response?.data || { error: err.message });
  }
});

// Get task status: prefer cached info if exists (keeps UI in sync with polling)
app.get('/api/task/:taskId', async (req, res) => {
  const taskId = req.params.taskId;
  const cached = taskCache.get(taskId);
  if (cached) {
    // return a friendly object composed from cache (closer to Kie shape)
    return res.json({
      code: 200,
      msg: 'ok',
      data: {
        taskId,
        status: cached.status,
        lastUpdated: cached.updatedAt,
        sunoData: cached.sunoData || [],
        downloaded: cached.downloaded || false,
        localFiles: cached.localFiles || []
      }
    });
  }
  // if not cached, fetch once from Kie and start polling
  try {
    const r = await kieRecordInfo(taskId);
    const status = getStatusFromKieResp(r) || 'UNKNOWN';
    const sunoData = extractSunoData(r);
    taskCache.set(taskId, { lastRaw: r, status, updatedAt: Date.now(), sunoData, downloaded: false, localFiles: [] });
    // start polling
    startServerSidePoll(taskId);
    return res.json({ code: 200, msg: 'ok', data: { taskId, status, sunoData, downloaded: false, localFiles: [] } });
  } catch (err) {
    console.error('/api/task error', err.message || err);
    return res.status(500).json({ error: err.message || 'failed' });
  }
});

// Download proxy: if local file present, serve it; otherwise stream remote URL
app.get('/download', async (req, res) => {
  const fileUrl = req.query.url;
  const taskId = req.query.taskId;
  // If a local file exists in cache for given task & url, serve it. Otherwise stream remote.
  if (taskId) {
    const entry = taskCache.get(taskId);
    if (entry && entry.localFiles && entry.localFiles.length > 0) {
      // try to find matching file by original url or type
      // simple policy: if fileUrl present, match by filename in URL's path; else serve first audio
      if (fileUrl) {
        const basename = path.basename(new URL(fileUrl).pathname);
        const found = entry.localFiles.find(f => (f.name && f.name.includes(basename)) || f.name === basename);
        if (found && fs.existsSync(found.path)) {
          return res.download(found.path, found.name);
        }
      }
      // fallback to first audio local file
      const audioLocal = entry.localFiles.find(f => f.type === 'audio') || entry.localFiles[0];
      if (audioLocal && fs.existsSync(audioLocal.path)) {
        return res.download(audioLocal.path, audioLocal.name);
      }
    }
  }
  // else stream remote
  if (!fileUrl) return res.status(400).send('Missing url or taskId');
  try {
    const r = await axios.get(fileUrl, { responseType: 'stream', timeout: 60000 });
    const filename = path.basename(new URL(fileUrl).pathname) || 'file.bin';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (r.headers['content-type']) res.setHeader('Content-Type', r.headers['content-type']);
    r.data.pipe(res);
  } catch (err) {
    console.error('/download proxy error', err.message || err);
    res.status(500).send('Download failed: ' + (err.message || ''));
  }
});

// Simple callback receiver (for local dev)
app.post('/callback', (req, res) => {
  console.log('Callback body (truncated):', JSON.stringify(req.body).slice(0,2000));
  // Optionally: you could parse and update taskCache here if you trust callbacks.
  res.status(200).json({ status: 'received' });
});

app.listen(PORT, () => console.log(`Listening http://localhost:${PORT} downloads: ${DOWNLOAD_DIR}`));
