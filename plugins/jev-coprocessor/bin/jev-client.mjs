import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, 'jev-daemon.mjs');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PLUGIN_ROOT, '.env');
const LOG_DIR = path.join(PLUGIN_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'jev-telemetry.jsonl');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const CACHE_FILE = path.join(os.tmpdir(), 'jev-response-cache.json');
export const CACHE_TTL_MS = 300_000;

const HOME_DIR = process.env.HOME || os.homedir();
let logDirInitialized = false;

function resolveDaemonSocketPath() {
  if (process.platform === 'win32') {
    const rawUser = process.env.USERNAME || os.userInfo().username || 'default';
    const safeUser = rawUser.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `\\\\.\\pipe\\jev-coprocessor-v2-${safeUser}`;
  }
  const uid =
    typeof process.getuid === 'function'
      ? process.getuid()
      : (os.userInfo().username || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `jev-coprocessor-v2-${uid}.sock`);
}

export const DAEMON_SOCKET_PATH = resolveDaemonSocketPath();

function parseEnvFile(filePath, target) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if ((key === 'TYPESAFE_API_KEY' || key === 'JEV_API_KEY') && !target.apiKey) {
      target.apiKey = val;
    }
    if ((key === 'TYPESAFE_MODEL' || key === 'JEV_MODEL') && !target.model) {
      target.model = val;
    }
    if ((key === 'TYPESAFE_API_URL' || key === 'JEV_API_URL') && !target.apiUrl) {
      target.apiUrl = val;
    }
  }
}

export function loadEnv() {
  const config = {
    apiKey: process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '',
    model: process.env.TYPESAFE_MODEL || process.env.JEV_MODEL || '',
    apiUrl: process.env.TYPESAFE_API_URL || process.env.JEV_API_URL || '',
  };

  if (!config.apiKey) {
    for (const candidate of [
      path.join(HOME_DIR, '.gemini', 'config', 'jev.env'),
      path.join(HOME_DIR, '.gemini', 'config', '.env'),
      path.join(HOME_DIR, '.zshenv'),
      path.join(HOME_DIR, '.profile'),
      path.join(HOME_DIR, '.env'),
      ENV_PATH,
    ]) {
      parseEnvFile(candidate, config);
      if (config.apiKey) {
        break;
      }
    }
  }

  return {
    apiKey: config.apiKey,
    model: config.model || 'jev-latest',
    apiUrl: config.apiUrl || 'https://api.typesafe.ai/v1/systemone',
  };
}

export function computeCacheKey(reqBody) {
  return crypto.createHash('sha256').update(reqBody).digest('hex');
}

export function logTelemetry(entry) {
  if (!entry || !entry.hook) {
    return false;
  }
  try {
    if (!logDirInitialized) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logDirInitialized = true;
    }
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size >= MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    fs.appendFileSync(LOG_FILE, record + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function readCachedResponse(cacheKey) {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return null;
    }
    const store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const entry = store?.[cacheKey];
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
      return entry.data;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCachedResponse(cacheKey, data) {
  try {
    let store = {};
    if (fs.existsSync(CACHE_FILE)) {
      store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
    }
    const now = Date.now();
    const validEntries = [];
    for (const [k, v] of Object.entries(store)) {
      if (now - (v?.ts || 0) < CACHE_TTL_MS) {
        validEntries.push([k, v]);
      }
    }
    validEntries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    const prunedStore = Object.fromEntries(validEntries.slice(0, 199));
    prunedStore[cacheKey] = { ts: now, data };
    const tmpFile = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(prunedStore), 'utf8');
    fs.renameSync(tmpFile, CACHE_FILE);
    return true;
  } catch {
    return false;
  }
}

function spawnDaemonDetached() {
  if (process.env.JEV_NO_DAEMON === '1' || !fs.existsSync(DAEMON_SCRIPT)) {
    return;
  }
  try {
    const child = spawn(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    void err;
  }
}

function requestViaDaemon(payloadObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payloadObj);
    const req = http.request(
      {
        socketPath: DAEMON_SOCKET_PATH,
        path: '/evaluate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`Daemon HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Daemon request timed out'));
    });
    req.on('error', (err) => {
      reject(err);
    });
    req.end(body);
  });
}

export async function directEvaluateSystemOne({
  state,
  questions,
  model,
  timeoutMs = 4500,
  skipDiskWrite = false,
}) {
  const cfg = loadEnv();
  if (!cfg.apiKey) {
    throw new Error('Missing TYPESAFE_API_KEY in environment or plugin .env');
  }

  const reqBody = JSON.stringify({
    state,
    model: model || cfg.model,
    questions,
  });
  const cacheKey = computeCacheKey(reqBody);
  const cached = readCachedResponse(cacheKey);
  if (cached) {
    return {
      ...cached,
      latencyMs: 1,
      cached: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startNs = process.hrtime.bigint();

  try {
    const response = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: reqBody,
      signal: controller.signal,
    });

    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`TypeSafe HTTP ${response.status}: ${text}`);
    }
    const data = JSON.parse(text);
    if (!skipDiskWrite) {
      writeCachedResponse(cacheKey, data);
    }
    return {
      ...data,
      latencyMs: Math.round(elapsedMs),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateSystemOne({
  state,
  questions,
  model,
  timeoutMs = 4500,
}) {
  if (process.env.JEV_NO_DAEMON !== '1') {
    try {
      return await requestViaDaemon({ state, questions, model, timeoutMs }, timeoutMs);
    } catch (daemonErr) {
      const code = daemonErr?.code || '';
      if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE') {
        spawnDaemonDetached();
      }
    }
  }
  return directEvaluateSystemOne({ state, questions, model, timeoutMs });
}
