#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_TTL_MS,
  DAEMON_SOCKET_PATH,
  computeCacheKey,
  directEvaluateSystemOne,
  loadEnv,
  readCachedResponse,
  writeCachedResponse,
} from './jev-client.mjs';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_MEM_ENTRIES = 500;
const startedAt = Date.now();
const memCache = new Map();
const inflight = new Map();
let idleTimer = null;

function cleanupSocketFile() {
  if (process.platform === 'win32') {
    return;
  }
  try {
    if (fs.existsSync(DAEMON_SOCKET_PATH)) {
      fs.unlinkSync(DAEMON_SOCKET_PATH);
    }
  } catch (err) {
    void err;
  }
}

function getMemCache(key) {
  const hit = memCache.get(key);
  if (!hit) {
    return null;
  }
  if (Date.now() - hit.ts >= CACHE_TTL_MS) {
    memCache.delete(key);
    return null;
  }
  memCache.delete(key);
  memCache.set(key, hit);
  return hit.data;
}

function setMemCache(key, data) {
  if (memCache.size >= MAX_MEM_ENTRIES) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey) {
      memCache.delete(oldestKey);
    }
  }
  memCache.set(key, { ts: Date.now(), data });
}

function prewarmTlsConnection() {
  const cfg = loadEnv();
  if (!cfg.apiUrl) {
    return;
  }
  try {
    const origin = new URL(cfg.apiUrl).origin;
    fetch(origin, { method: 'HEAD' }).catch(() => null);
  } catch (err) {
    void err;
  }
}

async function handleEvaluateRequest(payload) {
  const cfg = loadEnv();
  const model = payload?.model || cfg.model;
  const reqBody = JSON.stringify({
    state: payload?.state,
    model,
    questions: payload?.questions,
  });
  const cacheKey = computeCacheKey(reqBody);

  const memHit = getMemCache(cacheKey);
  if (memHit) {
    return { ...memHit, latencyMs: 0, cached: true, warmDaemon: true };
  }

  const diskHit = readCachedResponse(cacheKey);
  if (diskHit) {
    setMemCache(cacheKey, diskHit);
    return { ...diskHit, latencyMs: 1, cached: true, warmDaemon: true };
  }

  const pending = inflight.get(cacheKey);
  if (pending) {
    const shared = await pending;
    return { ...shared, cached: true, coalesced: true, warmDaemon: true };
  }

  const task = directEvaluateSystemOne({
    state: payload?.state,
    questions: payload?.questions,
    model,
    timeoutMs: payload?.timeoutMs || 4500,
    skipDiskWrite: true,
  });
  inflight.set(cacheKey, task);

  try {
    const result = await task;
    const rawData = { ...result };
    delete rawData.latencyMs;
    delete rawData.cached;
    setMemCache(cacheKey, rawData);
    setImmediate(() => writeCachedResponse(cacheKey, rawData));
    return { ...result, warmDaemon: true };
  } finally {
    inflight.delete(cacheKey);
  }
}

function resetIdleTimer(server) {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    server.close(() => {
      cleanupSocketFile();
      process.exit(0);
    });
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

const server = http.createServer((req, res) => {
  resetIdleTimer(server);

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        cacheSize: memCache.size,
      })
    );
    return;
  }

  if (req.method !== 'POST' || req.url !== '/evaluate') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not_found"}');
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const result = await handleEvaluateRequest(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });
});

function probeExistingDaemon() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: DAEMON_SOCKET_PATH,
        path: '/health',
        method: 'GET',
        timeout: 150,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function sweepStaleTempFiles() {
  const tmpDir = os.tmpdir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      if (
        !name.startsWith('jev-session-') &&
        !name.startsWith('jev-hook-last-step-')
      ) {
        continue;
      }
      const fullPath = path.join(tmpDir, name);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
      }
    }
    for (const sub of ['jev-logs', 'jev-ctx']) {
      const dir = path.join(tmpDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'fts-index.sqlite') continue;
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    process.stderr.write(`jev-daemon temp sweep warning: ${err?.message || err}\n`);
  }
}

async function startDaemon() {
  const alreadyAlive = await probeExistingDaemon();
  if (alreadyAlive) {
    process.exit(0);
  }
  sweepStaleTempFiles();
  cleanupSocketFile();
  server.on('error', () => {
    process.exit(0);
  });
  server.listen(DAEMON_SOCKET_PATH, () => {
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(DAEMON_SOCKET_PATH, 0o600);
      } catch (err) {
        void err;
      }
    }
    resetIdleTimer(server);
    prewarmTlsConnection();
  });
}

process.on('SIGTERM', () => {
  cleanupSocketFile();
  process.exit(0);
});
process.on('SIGINT', () => {
  cleanupSocketFile();
  process.exit(0);
});

startDaemon();
