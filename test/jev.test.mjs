import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'plugins', 'jev-coprocessor', 'bin', 'jev-hook.mjs');
const MCP_SCRIPT = path.join(REPO_ROOT, 'plugins', 'jev-coprocessor', 'bin', 'jev-mcp.mjs');

function runHook(mode, payload) {
  const res = spawnSync(process.execPath, [HOOK_SCRIPT, mode], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, JEV_NO_DAEMON: '1', TYPESAFE_API_KEY: '' },
  });
  assert.equal(res.status, 0, `Hook exited with ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function runMcpRequests(requests) {
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const res = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-sqlite', MCP_SCRIPT],
    {
      input,
      encoding: 'utf8',
      env: { ...process.env, JEV_NO_DAEMON: '1', TYPESAFE_API_KEY: '' },
    }
  );
  assert.equal(res.status, 0, `MCP exited with ${res.status}: ${res.stderr}`);
  return res.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('PreToolUse caps unranked large file read on first call and allows second call', () => {
  const convId = `unit-read-${Date.now()}`;
  const out1 = runHook('PreToolUse', {
    conversationId: convId,
    stepIdx: 1,
    toolCall: { name: 'read_file', args: { Path: HOOK_SCRIPT } },
  });
  assert.equal(out1.decision, 'allow');
  assert.deepEqual(out1.overwrite, { StartLine: 1, EndLine: 250 });

  const out2 = runHook('PreToolUse', {
    conversationId: convId,
    stepIdx: 2,
    toolCall: { name: 'read_file', args: { Path: HOOK_SCRIPT } },
  });
  assert.equal(out2.decision, 'allow');
  assert.equal(out2.overwrite, undefined);

  fs.rmSync(path.join(os.tmpdir(), `jev-session-${convId}.json`), { force: true });
  fs.rmSync(path.join(os.tmpdir(), `jev-hook-last-step-${convId}.json`), { force: true });
});

test('PreToolUse offloads noisy run_command and fast-allows compact git commands', () => {
  const convId = `unit-cmd-${Date.now()}`;
  const noisy = runHook('PreToolUse', {
    conversationId: convId,
    stepIdx: 1,
    toolCall: { name: 'run_command', args: { CommandLine: 'go test ./...' } },
  });
  assert.equal(noisy.decision, 'allow');
  if (process.platform !== 'win32') {
    assert.ok(noisy.overwrite?.CommandLine?.includes('/tmp/jev-logs/'));
    assert.ok(noisy.overwrite?.CommandLine?.includes('tail -n 80'));
  }

  const compact = runHook('PreToolUse', {
    conversationId: convId,
    stepIdx: 2,
    toolCall: { name: 'run_command', args: { CommandLine: 'git commit -m "chore: update docs"' } },
  });
  assert.equal(compact.decision, 'allow');
  assert.equal(compact.overwrite, undefined);

  const benignOrTrue = runHook('PreToolUse', {
    conversationId: convId,
    stepIdx: 3,
    toolCall: { name: 'run_command', args: { CommandLine: 'curl -s http://127.0.0.1:8080/health || true' } },
  });
  assert.equal(benignOrTrue.decision, 'allow');
  assert.equal(benignOrTrue.overwrite, undefined);

  fs.rmSync(path.join(os.tmpdir(), 'jev-logs', convId), { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), `jev-hook-last-step-${convId}.json`), { force: true });
});

test('PostToolUse persists edited files and failed commands to session memory', () => {
  const convId = `unit-mem-${Date.now()}`;
  const memPath = path.join(os.tmpdir(), 'jev-ctx', `memory-${convId}.json`);
  runHook('PostToolUse', {
    conversationId: convId,
    stepIdx: 1,
    toolCall: { name: 'edit_file', args: { Path: '/repo/src/app.ts' } },
  });
  runHook('PostToolUse', {
    conversationId: convId,
    stepIdx: 2,
    toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    error: 'exit code 1',
  });

  const saved = JSON.parse(fs.readFileSync(memPath, 'utf8'));
  assert.deepEqual(saved.editedFiles, ['/repo/src/app.ts']);
  assert.equal(saved.failedCommands.length, 1);
  assert.ok(saved.failedCommands[0].includes('npm test'));

  fs.rmSync(memPath, { force: true });
  fs.rmSync(path.join(os.tmpdir(), `jev-hook-last-step-${convId}.json`), { force: true });
});

test('jev-mcp.mjs supports initialize, tools/list, jev_exec error highlights, jev_search, list, and clear', () => {
  const responses = runMcpRequests([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'jev_exec',
        arguments: {
          command:
            'node -e "for(let i=1;i<=45;i++){console.log(i===12?\'ERROR: shard timeout\':\'ok \'+i)};process.exit(1)"',
        },
      },
    },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'jev_list_sources', arguments: {} } },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'jev_search', arguments: { query: 'shard timeout' } },
    },
  ]);

  assert.equal(responses[0].result.serverInfo.name, 'jev-context-mcp');
  const toolNames = responses[1].result.tools.map((t) => t.name);
  assert.deepEqual(toolNames, ['jev_exec', 'jev_index', 'jev_search', 'jev_list_sources', 'jev_clear']);

  const execText = responses[2].result.content[0].text;
  assert.ok(execText.includes('exit=1'));
  assert.ok(execText.includes('--- Key error lines ---'));
  assert.ok(execText.includes('ERROR: shard timeout'));

  const sourceMatch = /source_id=(\S+)/.exec(execText);
  assert.ok(sourceMatch, 'Expected source_id in jev_exec output');
  const sourceId = sourceMatch[1];

  assert.ok(responses[3].result.content[0].text.includes(sourceId));
  assert.ok(responses[4].result.content[0].text.includes('ERROR: shard timeout'));

  const clearRes = runMcpRequests([
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'jev_clear', arguments: { source_id: sourceId } } },
  ]);
  assert.ok(clearRes[0].result.content[0].text.includes(`Cleared source_id="${sourceId}"`));
});

test('jev-mcp.mjs reports non-zero exit code on command timeout', () => {
  const responses = runMcpRequests([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'jev_exec',
        arguments: { command: 'node -e "setTimeout(()=>{}, 5000)"', timeout_ms: 150 },
      },
    },
  ]);
  const text = responses[0].result.content[0].text;
  assert.ok(text.includes('exit=1'));
  assert.ok(text.includes('Command timed out'));
  const sourceMatch = /source_id=(\S+)/.exec(text);
  if (sourceMatch) {
    runMcpRequests([
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jev_clear', arguments: { source_id: sourceMatch[1] } } },
    ]);
  }
});

test('jev-mcp.mjs indexes files, replaces duplicate source_id cleanly, and rejects missing files', () => {
  const tmpFile = path.join(os.tmpdir(), `jev-idx-test-${Date.now()}.log`);
  const sourceId = `custom-src-${Date.now()}`;
  fs.writeFileSync(tmpFile, 'line 1 alpha\nline 2 UNIQUE_TOKEN_987\nline 3 omega\n', 'utf8');
  try {
    const res = runMcpRequests([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'jev_index', arguments: { path: tmpFile, source_id: sourceId } },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'jev_index', arguments: { path: tmpFile, source_id: sourceId } },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'jev_search', arguments: { query: 'UNIQUE_TOKEN_987', source_id: sourceId } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'jev_index', arguments: { path: '/nonexistent/jev-missing.log' } },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'jev_clear', arguments: { source_id: sourceId } },
      },
    ]);
    assert.ok(res[0].result.content[0].text.includes(`source_id="${sourceId}"`));
    const searchText = res[2].result.content[0].text;
    assert.equal(searchText.split('UNIQUE_TOKEN_987').length - 1, 1, 'Duplicate source_id should not produce duplicate chunks');
    assert.equal(res[3].result.isError, true);
    assert.ok(res[4].result.content[0].text.includes(`Cleared source_id="${sourceId}"`));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('Manifest and hook JSON files are valid', () => {
  for (const rel of [
    'hooks.json',
    'plugins/jev-coprocessor/hooks.json',
    'plugins/jev-coprocessor/mcp_config.json',
    'plugins/jev-coprocessor/plugin.json',
  ]) {
    const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    assert.ok(parsed && typeof parsed === 'object');
  }
});
