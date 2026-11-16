#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { exec } from 'node:child_process';
import { evaluateSystemOne } from './jev-client.mjs';

const INDEX_DIR = path.join(os.tmpdir(), 'jev-ctx');
const DB_PATH = path.join(INDEX_DIR, 'fts-index.sqlite');
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 5;

let sqliteDb = null;
const memoryChunks = [];

async function initStore() {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  try {
    const { DatabaseSync } = await import('node:sqlite');
    sqliteDb = new DatabaseSync(DB_PATH);
    sqliteDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        source_id UNINDEXED,
        label UNINDEXED,
        line_start UNINDEXED,
        line_end UNINDEXED,
        body
      );
    `);
  } catch {
    sqliteDb = null;
  }
}

function chunkText(text, sourceId, label) {
  const lines = String(text || '').split(/\r?\n/);
  const chunks = [];
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP);
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    const body = slice.join('\n').trim();
    if (!body) continue;
    chunks.push({
      sourceId,
      label,
      lineStart: i + 1,
      lineEnd: Math.min(lines.length, i + slice.length),
      body,
    });
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return { totalLines: lines.length, chunks };
}

function insertChunks(chunks) {
  if (sqliteDb) {
    const stmt = sqliteDb.prepare(
      'INSERT INTO chunks (source_id, label, line_start, line_end, body) VALUES (?, ?, ?, ?, ?)'
    );
    for (const c of chunks) {
      stmt.run(c.sourceId, c.label, c.lineStart, c.lineEnd, c.body);
    }
    return;
  }
  memoryChunks.push(...chunks);
}

function queryStore(query, sourceId, limit = 8) {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9_.-]/g, ''))
    .filter(Boolean);
  if (terms.length === 0) return [];

  if (sqliteDb) {
    const ftsQuery = terms.map((t) => `"${t}"`).join(' OR ');
    const sql = sourceId
      ? `SELECT source_id, label, line_start, line_end, body, bm25(chunks) AS rank
         FROM chunks WHERE chunks MATCH ? AND source_id = ? ORDER BY rank LIMIT ?`
      : `SELECT source_id, label, line_start, line_end, body, bm25(chunks) AS rank
         FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?`;
    const rows = sourceId
      ? sqliteDb.prepare(sql).all(ftsQuery, sourceId, limit)
      : sqliteDb.prepare(sql).all(ftsQuery, limit);
    return rows.map((r) => ({
      sourceId: r.source_id,
      label: r.label,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      body: r.body,
    }));
  }

  const lowerTerms = terms.map((t) => t.toLowerCase());
  return memoryChunks
    .filter((c) => !sourceId || c.sourceId === sourceId)
    .map((c) => {
      const lower = c.body.toLowerCase();
      const score = lowerTerms.reduce(
        (acc, t) => acc + (lower.includes(t) ? 1 : 0),
        0
      );
      return { ...c, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function rerankWithJev(query, candidates) {
  if (candidates.length <= 1) return candidates;
  const questions = {};
  candidates.forEach((c, idx) => {
    questions[`chunk_${idx}`] = {
      type: 'noul',
      instructions: `Does \`candidates[${idx}]\` contain information directly answering or relevant to \`query\`?`,
      criteria: {
        true: 'Contains relevant error, symbol, log line, or answer for `query`',
        false: 'Noisy or unrelated chunk',
      },
    };
  });
  try {
    const res = await evaluateSystemOne({
      state: {
        query: String(query).slice(0, 400),
        candidates: candidates.map((c, idx) => ({
          idx,
          label: c.label,
          lines: `L${c.lineStart}-L${c.lineEnd}`,
          preview: c.body.slice(0, 600),
        })),
      },
      questions,
    });
    const scored = candidates
      .map((c, idx) => ({
        ...c,
        prob: res.answers?.[`chunk_${idx}`]?.noul ?? 0.5,
      }))
      .sort((a, b) => b.prob - a.prob);
    const filtered = scored.filter((c) => c.prob >= 0.55);
    return (filtered.length > 0 ? filtered : scored).slice(0, 4);
  } catch {
    return candidates.slice(0, 4);
  }
}

function runShellCommand(command, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: cwd || process.cwd(), timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : 0;
        resolve({
          exitCode,
          combined: `${stdout || ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`,
        });
      }
    );
  });
}

async function handleToolCall(name, args) {
  if (name === 'jev_exec') {
    const command = String(args?.command || '').trim();
    if (!command) {
      return { content: [{ type: 'text', text: 'Missing required argument: command' }], isError: true };
    }
    const timeoutMs = Math.min(Number(args?.timeout_ms) || 30000, 120000);
    const { exitCode, combined } = await runShellCommand(command, args?.cwd, timeoutMs);
    const sourceId = `exec-${Date.now()}`;
    const { totalLines, chunks } = chunkText(combined, sourceId, command.slice(0, 80));
    insertChunks(chunks);

    const lines = combined.split(/\r?\n/);
    const tail = lines.slice(-25).join('\n');
    const summary = [
      `[jev_exec] exit=${exitCode} lines=${totalLines} bytes=${Buffer.byteLength(combined, 'utf8')} chunks=${chunks.length} source_id=${sourceId}`,
      totalLines > 25
        ? `--- Last 25 lines (use jev_search with source_id="${sourceId}" to query earlier output) ---`
        : '--- Output ---',
      tail,
    ].join('\n');
    return { content: [{ type: 'text', text: summary }] };
  }

  if (name === 'jev_index') {
    const filePath = String(args?.path || '').trim();
    if (!filePath || !fs.existsSync(filePath)) {
      return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const sourceId = args?.source_id ? String(args.source_id) : `file-${path.basename(filePath)}-${Date.now()}`;
    const { totalLines, chunks } = chunkText(raw, sourceId, filePath);
    insertChunks(chunks);
    return {
      content: [
        {
          type: 'text',
          text: `[jev_index] Indexed ${filePath} (${totalLines} lines, ${chunks.length} chunks). Use jev_search with source_id="${sourceId}".`,
        },
      ],
    };
  }

  if (name === 'jev_search') {
    const query = String(args?.query || '').trim();
    if (!query) {
      return { content: [{ type: 'text', text: 'Missing required argument: query' }], isError: true };
    }
    const candidates = queryStore(query, args?.source_id ? String(args.source_id) : null, 8);
    if (candidates.length === 0) {
      return { content: [{ type: 'text', text: `[jev_search] No matches for "${query}".` }] };
    }
    const ranked = await rerankWithJev(query, candidates);
    const formatted = ranked
      .map(
        (c) =>
          `[${c.sourceId} | ${c.label} L${c.lineStart}-L${c.lineEnd}${c.prob != null ? ` | p=${c.prob.toFixed(2)}` : ''}]\n${c.body}`
      )
      .join('\n\n---\n\n');
    return { content: [{ type: 'text', text: formatted }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

const TOOLS = [
  {
    name: 'jev_exec',
    description:
      'Execute a shell command in a sandboxed runner, index its full stdout/stderr into local SQLite FTS5, and return a compact summary + source_id for targeted jev_search.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Optional working directory' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 30000, max 120000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'jev_index',
    description:
      'Index a large log file or document into local SQLite FTS5 for targeted BM25 + Jev-reranked search.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to file to index' },
        source_id: { type: 'string', description: 'Optional custom source_id' },
      },
      required: ['path'],
    },
  },
  {
    name: 'jev_search',
    description:
      'Search indexed command outputs or files using SQLite FTS5 BM25 and Jev System-1 relevance reranking.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords or error phrase' },
        source_id: { type: 'string', description: 'Optional source_id returned by jev_exec or jev_index' },
      },
      required: ['query'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function main() {
  await initStore();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = req;
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'jev-context-mcp', version: '1.0.0' },
        },
      });
    } else if (method === 'notifications/initialized') {
      // No response needed
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      send({ jsonrpc: '2.0', id, result });
    } else if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  }
}

main().catch((err) => {
  process.stderr.write(`jev-mcp fatal: ${err?.message || err}\n`);
  process.exit(1);
});
