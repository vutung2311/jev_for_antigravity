import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PLUGIN_ROOT, '.env');
const LOG_DIR = path.join(PLUGIN_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'jev-telemetry.jsonl');
const CACHE_FILE = path.join(os.tmpdir(), 'jev-response-cache.json');
const CACHE_TTL_MS = 60_000;

const HOME_DIR = process.env.HOME || os.homedir();

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

function loadEnv() {
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

export function logTelemetry(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    fs.appendFileSync(LOG_FILE, record + '\n', 'utf8');
  } catch {
    // Non-blocking telemetry write
  }
}

function readCachedResponse(cacheKey) {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return null;
    }
    const store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const entry = store?.[cacheKey];
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
      return entry.data;
    }
  } catch {
    // ignore cache read errors
  }
  return null;
}

function writeCachedResponse(cacheKey, data) {
  try {
    let store = {};
    if (fs.existsSync(CACHE_FILE)) {
      store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
    }
    const now = Date.now();
    for (const k of Object.keys(store)) {
      if (now - (store[k]?.ts || 0) >= CACHE_TTL_MS) {
        delete store[k];
      }
    }
    store[cacheKey] = { ts: now, data };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(store), 'utf8');
  } catch {
    // ignore cache write errors
  }
}

export async function evaluateSystemOne({ state, questions, model, timeoutMs = 4500 }) {
  const cfg = loadEnv();
  if (!cfg.apiKey) {
    throw new Error('Missing TYPESAFE_API_KEY in environment or plugin .env');
  }

  const reqBody = JSON.stringify({
    state,
    model: model || cfg.model,
    questions,
  });
  const cacheKey = crypto.createHash('sha256').update(reqBody).digest('hex');
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
    writeCachedResponse(cacheKey, data);
    return {
      ...data,
      latencyMs: Math.round(elapsedMs),
    };
  } finally {
    clearTimeout(timer);
  }
}
