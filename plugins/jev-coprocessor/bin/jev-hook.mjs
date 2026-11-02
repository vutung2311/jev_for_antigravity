#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { evaluateSystemOne, logTelemetry } from './jev-client.mjs';

const CODE_EXTENSIONS = new Set([
  '.go',
  '.dart',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.php',
  '.py',
  '.rs',
  '.c',
  '.cpp',
  '.cc',
  '.h',
  '.hpp',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.sh',
]);

function getPrivilegeEscalationTool() {
  if (process.env.PRIVILEGE_ESCALATION) {
    return process.env.PRIVILEGE_ESCALATION;
  }
  if (process.platform === 'win32') {
    return 'sudo';
  }
  if (!fs.existsSync('/proc/self/status')) {
    return 'pkexec';
  }
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    if (/NoNewPrivs:\s*1/i.test(status)) {
      return 'run0';
    }
    return 'pkexec';
  } catch {
    return 'pkexec';
  }
}

let cachedRgExecutable = null;

function resolveWindowsRgFallback() {
  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(
      home,
      'AppData',
      'Local',
      'Programs',
      'Antigravity IDE',
      'resources',
      'app',
      'node_modules',
      '@vscode',
      'ripgrep',
      'bin',
      'rg.exe'
    ),
    path.join(
      home,
      'AppData',
      'Local',
      'Programs',
      'Microsoft VS Code',
      'resources',
      'app',
      'node_modules',
      '@vscode',
      'ripgrep',
      'bin',
      'rg.exe'
    ),
    'C:\\Program Files\\ripgrep\\rg.exe',
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return 'rg';
}

function resolveRgExecutable() {
  if (cachedRgExecutable) {
    return cachedRgExecutable;
  }
  if (process.env.RG_PATH) {
    cachedRgExecutable = process.env.RG_PATH;
    return cachedRgExecutable;
  }
  cachedRgExecutable = 'rg';
  return cachedRgExecutable;
}

function runProcessAsync(bin, args, timeoutMs = 300) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (stdout, code, errCode = '') => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ stdout, status: code, errCode });
    };
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (err) {
      finish('', -1, err?.code || 'SPAWN_ERR');
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill();
      finish(Buffer.concat(chunks).toString('utf8'), -1, 'ETIMEDOUT');
    }, timeoutMs);
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', (err) => {
      clearTimeout(timer);
      finish('', -1, err?.code || 'ERR');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString('utf8'), code ?? 0, '');
    });
  });
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where',
  'which', 'while', 'how', 'why', 'who', 'will', 'would', 'could', 'should',
  'have', 'has', 'had', 'not', 'are', 'was', 'were', 'been', 'being', 'into',
  'onto', 'upon', 'about', 'above', 'below', 'between', 'under', 'over', 'again',
  'further', 'then', 'once', 'here', 'there', 'all', 'any', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'than',
  'too', 'very', 'can', 'just', 'don', 'now', 'use', 'using', 'used', 'make',
  'check', 'find', 'write', 'create', 'update', 'fix', 'test', 'file', 'files',
  'code', 'function', 'method', 'service', 'handler', 'error', 'errors', 'please',
  'explain', 'modify', 'whether', 'branch', 'return', 'returning', 'without',
]);

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getSubagentInitialMessage(payload) {
  const conversationId = payload?.conversationId;
  if (!conversationId && !payload?.artifactDirectoryPath) {
    return null;
  }
  const homeDir = process.env.HOME || os.homedir();
  const baseDirs = [];
  if (payload?.artifactDirectoryPath) {
    baseDirs.push(
      path.join(payload.artifactDirectoryPath, '.system_generated/messages')
    );
  }
  if (conversationId) {
    for (const productDir of [
      'antigravity',
      'antigravity-ide',
      'antigravity-cli',
    ]) {
      baseDirs.push(
        path.join(
          homeDir,
          '.gemini',
          productDir,
          'brain',
          conversationId,
          '.system_generated/messages'
        )
      );
    }
  }
  const dirs = [];
  for (const baseDir of baseDirs) {
    dirs.push(path.join(baseDir, 'undelivered'), baseDir);
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json') && f !== 'read.json');
      for (const f of files) {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const msg = JSON.parse(raw);
        if (msg && typeof msg.content === 'string' && msg.content.length > 0) {
          return msg.content;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function isControlArm(payload) {
  const transcriptPath = payload?.transcriptPath;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const head = buf.slice(0, bytesRead).toString('utf8');
      if (
        head.includes('JEV_DISABLE') ||
        head.includes('ARM_CONTROL_NO_JEV') ||
        head.includes('BENCH_ARM_A')
      ) {
        return true;
      }
    } catch {
      // fall through
    }
  }
  const initMsg = getSubagentInitialMessage(payload);
  if (
    initMsg &&
    (initMsg.includes('JEV_DISABLE') ||
      initMsg.includes('ARM_CONTROL_NO_JEV') ||
      initMsg.includes('BENCH_ARM_A'))
  ) {
    return true;
  }
  return false;
}

function cleanPromptText(text) {
  return text
    .replace(/^[\s\S]*?content=/m, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:USER_REQUEST|SYSTEM_MESSAGE)>/g, '')
    .trim();
}

const TRANSCRIPT_TAIL_BYTES = 98_304;
const GENERATED_FILE_REGEX =
  /(?:^|[/\\])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock)$|\.(?:pb\.go|bob\.go|sql\.go|gen\.go|gen\.ts|generated\.ts|g\.dart|freezed\.dart|min\.js)$|(?:_gen\.go|^mock_.*\.go)$/i;

function readTranscriptTailLines(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }
  let fd = -1;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) {
      return [];
    }
    const readLen = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const offset = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, offset);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline !== -1) {
        text = text.slice(firstNewline + 1);
      }
    }
    return text.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        // closed
      }
    }
  }
}

function isContinuationFragment(text) {
  if (!text) {
    return false;
  }
  if (text.length < 48) {
    return true;
  }
  return /^(and|also|plus|or|but|as\s+well|what\s+about|how\s+about|for\s+the)\b/i.test(
    text.trim()
  );
}

function extractTranscriptContext(payload, workspaceRoot) {
  const ctx = {
    latestUserInput: null,
    turnsSinceUserInput: 0,
    consecutiveSearchTurns: 0,
    recentFiles: [],
    secondaryRoots: [],
    recentContextSummary: '',
    transcriptSize: 0,
  };

  const recentFileSet = new Set();
  const secondaryRootSet = new Set();
  const transcriptPath = payload?.transcriptPath;

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      ctx.transcriptSize = fs.statSync(transcriptPath).size;
    } catch {
      ctx.transcriptSize = 0;
    }
    const lines = readTranscriptTailLines(transcriptPath);
    if (lines.length > 0) {
      const startIdx = Math.max(0, lines.length - 160);
      let foundLatestUser = false;
      let streakSearching = true;
      let plannerTurnsSeen = 0;
      const latestUserParts = [];
      let priorUserInput = null;

      for (let i = lines.length - 1; i >= startIdx && plannerTurnsSeen < 10; i--) {
        let step;
        try {
          step = JSON.parse(lines[i]);
        } catch {
          continue;
        }

        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          plannerTurnsSeen++;
          let turnOnlySearched = true;
          for (const tc of step.tool_calls) {
            const tName = tc?.name || '';
            const tArgs = tc?.arguments || tc?.args || {};
            const fPath =
              tArgs?.Path ||
              tArgs?.TargetFile ||
              tArgs?.AbsolutePath ||
              tArgs?.SearchPath ||
              tArgs?.DirectoryPath ||
              '';
            if (
              fPath &&
              typeof fPath === 'string' &&
              !/[/\\]brain[/\\]/.test(fPath) &&
              fs.existsSync(fPath)
            ) {
              const stat = fs.statSync(fPath);
              if (stat.isFile()) {
                recentFileSet.add(fPath);
              }
              if (stat.isDirectory() && fPath !== workspaceRoot) {
                secondaryRootSet.add(fPath);
              }
            }
            const cmd = tArgs?.CommandLine || '';
            if (typeof cmd === 'string' && cmd) {
              const gitC = cmd.match(/\bgit\s+-C\s+([^\s;&|]+)/);
              if (gitC && fs.existsSync(gitC[1])) {
                secondaryRootSet.add(gitC[1]);
              }
              const cdMatch = cmd.match(/^\s*cd\s+([^\s;&|]+)/);
              if (cdMatch && fs.existsSync(cdMatch[1])) {
                secondaryRootSet.add(cdMatch[1]);
              }
            }
            const isSearchTool =
              tName === 'read_file' ||
              tName === 'view_file' ||
              tName === 'view_file_outline' ||
              tName === 'view_code_item' ||
              tName === 'list_dir' ||
              tName === 'grep_search' ||
              tName === 'find_by_name' ||
              (tName === 'run_command' &&
                /^\s*(?:cd\s+[^\s;&|]+\s*&&\s*)?(?:rg|fd|grep|git\s+(?:-C\s+[^\s]+\s+)?(?:grep|log|diff|show|status)|find|ls)\b/.test(
                  cmd
                ));
            if (!isSearchTool) {
              turnOnlySearched = false;
            }
          }
          if (!foundLatestUser) {
            ctx.turnsSinceUserInput++;
            const isSerialUnbatchedSearch =
              turnOnlySearched && step.tool_calls.length <= 2;
            if (streakSearching && isSerialUnbatchedSearch) {
              ctx.consecutiveSearchTurns++;
            }
            if (!isSerialUnbatchedSearch) {
              streakSearching = false;
            }
          }
        } else if (
          step.type === 'PLANNER_RESPONSE' ||
          step.type === 'TOOL_CALL'
        ) {
          plannerTurnsSeen++;
          if (!foundLatestUser) {
            ctx.turnsSinceUserInput++;
          }
          if (
            foundLatestUser &&
            !ctx.recentContextSummary &&
            typeof step.content === 'string' &&
            step.content.trim()
          ) {
            ctx.recentContextSummary = step.content
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 320);
          }
        }

        const isUserStep =
          step.type === 'USER_INPUT' ||
          (step.step_index === 0 && step.type === 'SYSTEM_MESSAGE');
        if (isUserStep && step.content) {
          const text =
            typeof step.content === 'string'
              ? step.content
              : JSON.stringify(step.content);
          const cleaned = cleanPromptText(text);
          if (cleaned) {
            if (!foundLatestUser) {
              foundLatestUser = true;
              if (ctx.turnsSinceUserInput === 0) {
                latestUserParts.unshift(cleaned);
              }
            } else if (
              ctx.turnsSinceUserInput === 0 &&
              plannerTurnsSeen === 0
            ) {
              latestUserParts.unshift(cleaned);
            } else if (!priorUserInput && plannerTurnsSeen <= 2) {
              priorUserInput = cleaned;
            }
          }
        }
      }

      if (latestUserParts.length > 0) {
        const joinedLatest = latestUserParts.join('\n').trim();
        ctx.latestUserInput =
          priorUserInput && isContinuationFragment(joinedLatest)
            ? `${priorUserInput}\n${joinedLatest}`
            : joinedLatest;
      }
    }
  }

  if (!ctx.latestUserInput && ctx.turnsSinceUserInput === 0) {
    if ((payload?.initialNumSteps ?? 0) <= 1) {
      const initMsg = getSubagentInitialMessage(payload);
      if (initMsg) {
        ctx.latestUserInput = cleanPromptText(initMsg) || null;
      }
    }
    if (
      !ctx.latestUserInput &&
      typeof payload?.userPrompt === 'string' &&
      payload.userPrompt.trim()
    ) {
      ctx.latestUserInput = cleanPromptText(payload.userPrompt) || null;
    }
  }

  ctx.recentFiles = [...recentFileSet].slice(0, 5);
  ctx.secondaryRoots = [...secondaryRootSet].filter(
    (r) => r !== workspaceRoot
  );
  return ctx;
}

function extractPrioritizedKeywords(userMessage, recentContextSummary = '') {
  const combined = `${userMessage} ${recentContextSummary}`;
  const backtickMatches = [
    ...userMessage.matchAll(/`([a-zA-Z0-9_./:-]{3,64})`/g),
  ].map((m) => m[1]);

  const rawTokens = combined
    .replace(/[^a-zA-Z0-9_./-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.,:;!?()[\]]+|[.,:;!?()[\]]+$/g, ''))
    .filter(
      (t) =>
        t.length >= 3 &&
        !STOPWORDS.has(t.toLowerCase()) &&
        !/^\d+$/.test(t)
    );

  const scored = new Map();
  const addToken = (tok, bonus = 0) => {
    const clean = tok.includes('/') ? path.basename(tok) : tok;
    const base = clean.replace(/\.[a-z0-9]+$/i, '');
    if (base.length < 3 || STOPWORDS.has(base.toLowerCase())) {
      return;
    }
    let score = bonus;
    if (/[a-z][A-Z]/.test(base) || /[A-Z]{2,}[a-z]/.test(base)) {
      score += 50; // camelCase / PascalCase identifier
    }
    if (base.includes('_') || base.includes('-')) {
      score += 40; // snake_case / kebab-case identifier
    }
    if (/\.[a-z]{1,4}$/i.test(clean)) {
      score += 35; // explicit filename
    }
    score += Math.min(base.length, 18);
    const prev = scored.get(base) || 0;
    if (score > prev) {
      scored.set(base, score);
    }
  };

  for (const bt of backtickMatches) {
    addToken(bt, 60);
  }
  for (const tok of rawTokens) {
    addToken(tok, 10);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k);
}

function extractDirectoryHints(userMessage, workspaceRoot, secondaryRoots = []) {
  const hints = [];
  const roots = [workspaceRoot, ...secondaryRoots].filter(Boolean);
  const winAbsPaths =
    userMessage.match(/[a-zA-Z]:[/\\][a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)+/g) || [];
  const unixAbsPaths =
    userMessage.match(/\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+/g) || [];
  const absPaths = [...winAbsPaths, ...unixAbsPaths];
  for (const rawAbs of absPaths) {
    const cleanAbs = rawAbs.replace(/[.,:;!?)]+$/, '');
    if (fs.existsSync(cleanAbs) && !/[/\\]brain[/\\]/.test(cleanAbs)) {
      const stat = fs.statSync(cleanAbs);
      hints.push(stat.isDirectory() ? cleanAbs : path.dirname(cleanAbs));
    }
  }

  const pathTokens =
    userMessage.match(/[a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)+/g) || [];
  for (const rawToken of pathTokens) {
    const cleanToken = rawToken.replace(/[.,:;!?)]+$/, '');
    for (const root of roots) {
      const candidatePath = path.resolve(root, cleanToken);
      if (!candidatePath.startsWith(root)) {
        continue;
      }
      if (fs.existsSync(candidatePath)) {
        const stat = fs.statSync(candidatePath);
        hints.push(
          stat.isDirectory() ? candidatePath : path.dirname(candidatePath)
        );
        break;
      }
      const parentDir = path.dirname(candidatePath);
      if (parentDir.startsWith(root) && fs.existsSync(parentDir)) {
        hints.push(parentDir);
        break;
      }
    }
  }
  return [...new Set([...hints, ...secondaryRoots])];
}

async function getGitDirtyFiles(workspaceRoot) {
  const dirtyMap = new Map();
  const gitRes = await runProcessAsync(
    'git',
    ['-C', workspaceRoot, 'status', '--porcelain', '-uall'],
    150
  );
  if (!gitRes.stdout) {
    return dirtyMap;
  }
  const lines = gitRes.stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(0, 15)) {
    const status = line.slice(0, 2).trim();
    const relPath = line
      .slice(3)
      .trim()
      .replace(/^.* -> /, '')
      .replace(/^"|"$/g, '');
    const absPath = path.resolve(workspaceRoot, relPath);
    if (
      absPath.startsWith(workspaceRoot) &&
      fs.existsSync(absPath) &&
      fs.statSync(absPath).isFile()
    ) {
      dirtyMap.set(absPath, status === '??' ? 'untracked' : 'modified');
    }
  }
  return dirtyMap;
}

async function runRgCountAsync(rgArgs, timeoutMs = 350) {
  const firstBin = resolveRgExecutable();
  const res = await runProcessAsync(firstBin, rgArgs, timeoutMs);
  if (
    res.errCode === 'ENOENT' &&
    process.platform === 'win32' &&
    firstBin === 'rg'
  ) {
    const fallbackBin = resolveWindowsRgFallback();
    if (fallbackBin !== 'rg') {
      cachedRgExecutable = fallbackBin;
      return runProcessAsync(fallbackBin, rgArgs, timeoutMs);
    }
  }
  return res;
}

function extractRankedSymbolsWithRanges(fileText, keywords) {
  const lines = fileText.split(/\r?\n/);
  const totalLines = lines.length;
  const symbolRegex =
    /^(?:func\s+|type\s+\w+\s+(?:struct|interface)|export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+|(?:async\s+)?(?:function|def)\s+\w+|class\s+\w+|(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+|(?:(?:public|protected|private|static|override|async)\s+)+(?:function\s+)?\w+\s*\()/;

  const rawSymbols = [];
  for (let i = 0; i < totalLines; i++) {
    const trimmed = lines[i].trim();
    if (
      !trimmed ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      /^(if|for|while|switch|catch|return|else)\b/.test(trimmed)
    ) {
      continue;
    }
    if (symbolRegex.test(trimmed)) {
      rawSymbols.push({
        header: trimmed.replace(/\s*\{$/, '').slice(0, 80),
        startLine: i + 1,
      });
    }
  }

  const lowerKeywords = keywords.map((kw) => kw.toLowerCase());
  const matchPreviewLines = [];

  for (let i = 0; i < rawSymbols.length; i++) {
    const endLine =
      i + 1 < rawSymbols.length
        ? rawSymbols[i + 1].startLine - 1
        : totalLines;
    const headerLower = rawSymbols[i].header.toLowerCase();
    let kwHits = 0;
    const bodyHitLines = [];

    for (const kw of lowerKeywords) {
      if (headerLower.includes(kw)) {
        kwHits += 3;
      }
    }

    const scanLimit = Math.min(endLine, rawSymbols[i].startLine + 600);
    for (let ln = rawSymbols[i].startLine; ln <= scanLimit; ln++) {
      const lineText = lines[ln - 1] || '';
      const lineLower = lineText.toLowerCase();
      let matchedLine = false;
      for (const kw of lowerKeywords) {
        if (lineLower.includes(kw)) {
          kwHits += 2;
          matchedLine = true;
        }
      }
      if (matchedLine && ln > rawSymbols[i].startLine) {
        if (bodyHitLines.length < 3) {
          bodyHitLines.push(ln);
        }
        if (matchPreviewLines.length < 3) {
          const snippet = lineText.trim().slice(0, 90);
          if (snippet) {
            matchPreviewLines.push(`L${ln}: ${snippet}`);
          }
        }
      }
    }

    rawSymbols[i].endLine = endLine;
    rawSymbols[i].kwHits = kwHits;
    rawSymbols[i].firstHitLine = bodyHitLines[0] || rawSymbols[i].startLine;
    rawSymbols[i].hitNote =
      bodyHitLines.length > 0
        ? ` [hits: ${bodyHitLines.map((l) => `L${l}`).join(',')}]`
        : '';
  }

  if (matchPreviewLines.length === 0 && lowerKeywords.length > 0) {
    for (let ln = 1; ln <= Math.min(totalLines, 1500); ln++) {
      const lineText = lines[ln - 1] || '';
      const lineLower = lineText.toLowerCase();
      if (lowerKeywords.some((kw) => lineLower.includes(kw))) {
        matchPreviewLines.push(`L${ln}: ${lineText.trim().slice(0, 90)}`);
        if (matchPreviewLines.length >= 3) break;
      }
    }
  }

  const ranked = rawSymbols
    .sort((a, b) => b.kwHits - a.kwHits || a.startLine - b.startLine)
    .slice(0, 6);

  const topSym = ranked[0];
  let primaryStart = topSym ? topSym.startLine : null;
  let primaryEnd = topSym ? topSym.endLine : null;
  if (topSym && primaryEnd - primaryStart > 180 && topSym.firstHitLine) {
    primaryStart = Math.max(topSym.startLine, topSym.firstHitLine - 40);
    primaryEnd = Math.min(topSym.endLine, topSym.firstHitLine + 120);
  }

  const symbols = ranked
    .map((s) => `L${s.startLine}-L${s.endLine}: ${s.header}${s.hitNote}`)
    .join('; ');

  return {
    symbols,
    matchPreview: matchPreviewLines.join(' | '),
    totalLines,
    primaryStart,
    primaryEnd,
  };
}

async function findCandidateFilesWithSummaries(
  userMessage,
  workspaceRoot,
  transcriptCtx = {}
) {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return [];
  }
  try {
    const secondaryRoots = transcriptCtx.secondaryRoots || [];
    const recentFiles = transcriptCtx.recentFiles || [];
    const dirHints = extractDirectoryHints(
      userMessage,
      workspaceRoot,
      secondaryRoots
    );
    const searchPaths =
      dirHints.length > 0
        ? dirHints.slice(0, 4)
        : [workspaceRoot, ...secondaryRoots.slice(0, 2)];

    const uniqueKeywords = extractPrioritizedKeywords(
      userMessage,
      transcriptCtx.recentContextSummary || ''
    );
    const wantsTests =
      /\b(test|tests|testing|spec|specs|assert|mock|mocks|benchmark|apitest)\b|_test\.|\.test\.|\.spec\./i.test(
        userMessage
      );
    const isInlineSelection =
      /<(?:SELECTION|CODE_SELECTION|ACTIVE_DOCUMENT|SELECTED_CODE)\b/i.test(
        userMessage
      );

    const gitRoots = [workspaceRoot, ...secondaryRoots.slice(0, 2)];
    const rgPromise =
      uniqueKeywords.length > 0 && !isInlineSelection
        ? (() => {
            const pattern = uniqueKeywords
              .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('|');
            const globs = [
              '-g', '!node_modules/**',
              '-g', '!.git/**',
              '-g', '!vendor/**',
              '-g', '!dist/**',
              '-g', '!build/**',
              '-g', '!target/**',
              '-g', '!.next/**',
              '-g', '!coverage/**',
              '-g', '!*.lock',
              '-g', '!package-lock.json',
              '-g', '!*.pb.go',
              '-g', '!*.bob.go',
              '-g', '!*.sql.go',
              '-g', '!*.gen.go',
              '-g', '!*_gen.go',
              '-g', '!*.gen.ts',
              '-g', '!*.generated.ts',
              '-g', '!*.g.dart',
              '-g', '!*.freezed.dart',
              '-g', '!*.min.js',
            ];
            if (!wantsTests) {
              globs.push(
                '-g', '!*mock*.go',
                '-g', '!*_test.go',
                '-g', '!*_test.ts',
                '-g', '!*_test.dart',
                '-g', '!*.spec.ts',
                '-g', '!*.test.ts',
                '-g', '!*.spec.js',
                '-g', '!*.test.js'
              );
            }
            return runRgCountAsync(
              [
                '-i',
                '-c',
                '--no-messages',
                '--max-filesize',
                '200K',
                ...globs,
                pattern,
                ...searchPaths,
              ],
              350
            );
          })()
        : Promise.resolve({ stdout: '' });

    const [dirtyMaps, rgRes] = await Promise.all([
      Promise.all(gitRoots.map((r) => getGitDirtyFiles(r))),
      rgPromise,
    ]);

    const dirtyMap = new Map();
    for (const dm of dirtyMaps) {
      for (const [k, v] of dm.entries()) {
        dirtyMap.set(k, v);
      }
    }

    const promptLower = userMessage.toLowerCase();
    const isAllowedCandidate = (absFile) => {
      const base = path.basename(absFile);
      if (promptLower.includes(base.toLowerCase())) {
        return true;
      }
      return !GENERATED_FILE_REGEX.test(absFile);
    };

    const candidateMap = new Map();

    for (const absFile of recentFiles) {
      if (!isAllowedCandidate(absFile)) {
        continue;
      }
      const relFile = absFile.startsWith(workspaceRoot)
        ? path.relative(workspaceRoot, absFile)
        : absFile;
      const keywordHits = uniqueKeywords.filter((kw) =>
        relFile.toLowerCase().includes(kw.toLowerCase())
      ).length;
      candidateMap.set(absFile, {
        absFile,
        relFile,
        gitStatus: dirtyMap.get(absFile) || 'recent_context',
        rankScore: 45 + keywordHits * 45,
      });
    }

    for (const [absFile, gitStatus] of dirtyMap.entries()) {
      if (!isAllowedCandidate(absFile)) {
        continue;
      }
      const relFile = absFile.startsWith(workspaceRoot)
        ? path.relative(workspaceRoot, absFile)
        : absFile;
      const keywordHits = uniqueKeywords.filter((kw) =>
        relFile.toLowerCase().includes(kw.toLowerCase())
      ).length;
      const prev = candidateMap.get(absFile);
      candidateMap.set(absFile, {
        absFile,
        relFile,
        gitStatus,
        rankScore: Math.max(prev?.rankScore || 0, 25 + keywordHits * 45),
      });
    }

    if (rgRes.stdout) {
      const rgLines = rgRes.stdout.trim().split(/\r?\n/).filter(Boolean);
      for (const line of rgLines) {
        const lastColon = line.lastIndexOf(':');
        if (lastColon === -1) continue;
        const absFile = line.slice(0, lastColon);
        if (!isAllowedCandidate(absFile)) {
          continue;
        }
        const count = parseInt(line.slice(lastColon + 1), 10) || 0;
        const relFile = absFile.startsWith(workspaceRoot)
          ? path.relative(workspaceRoot, absFile)
          : absFile;
        const keywordHits = uniqueKeywords.filter((kw) =>
          relFile.toLowerCase().includes(kw.toLowerCase())
        ).length;
        const prev = candidateMap.get(absFile);
        const rgScore = keywordHits * 40 + Math.min(count, 40);
        candidateMap.set(absFile, {
          absFile,
          relFile,
          gitStatus: prev?.gitStatus || 'clean',
          rankScore: (prev?.rankScore || 0) + rgScore,
        });
      }
    }

    const candidates = [...candidateMap.values()]
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, 8);

    return candidates.map((c) => {
      let symbols = '';
      let matchPreview = '';
      let totalLines = 0;
      let primaryStart = null;
      let primaryEnd = null;
      try {
        const fileText = fs.readFileSync(c.absFile, 'utf8');
        const extracted = extractRankedSymbolsWithRanges(
          fileText,
          uniqueKeywords
        );
        symbols = extracted.symbols;
        matchPreview = extracted.matchPreview;
        totalLines = extracted.totalLines;
        primaryStart = extracted.primaryStart;
        primaryEnd = extracted.primaryEnd;
      } catch {
        symbols = '';
      }
      return {
        file: c.relFile,
        absFile: c.absFile,
        gitStatus: c.gitStatus,
        symbols,
        matchPreview,
        totalLines,
        primaryStart,
        primaryEnd,
      };
    });
  } catch {
    return [];
  }
}

function discoverApplicableRules(workspaceRoot, targetFiles) {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return [];
  }
  const ruleNames = [
    '.agents/AGENTS.md',
    'AGENTS.md',
    'GEMINI.md',
    'CLAUDE.md',
    '.cursorrules',
  ];
  const found = new Set();
  const dirsToCheck = new Set([workspaceRoot]);

  for (const f of targetFiles) {
    let curr = path.dirname(f.absFile || path.join(workspaceRoot, f.file));
    while (curr && curr.startsWith(workspaceRoot) && curr !== workspaceRoot) {
      dirsToCheck.add(curr);
      curr = path.dirname(curr);
    }
  }

  for (const dir of dirsToCheck) {
    for (const ruleName of ruleNames) {
      const candidate = path.join(dir, ruleName);
      if (fs.existsSync(candidate)) {
        found.add(path.relative(workspaceRoot, candidate));
      }
    }
  }
  return [...found].slice(0, 4);
}

function setSessionState(conversationId, stateObj) {
  if (!conversationId) {
    return;
  }
  try {
    const p = path.join(os.tmpdir(), `jev-session-${conversationId}.json`);
    fs.writeFileSync(
      p,
      JSON.stringify({ ...stateObj, ts: Date.now() }),
      'utf8'
    );
  } catch {
    // ignore
  }
}

function getSessionState(conversationId) {
  if (!conversationId) {
    return null;
  }
  try {
    const p = path.join(os.tmpdir(), `jev-session-${conversationId}.json`);
    if (!fs.existsSync(p)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - (data?.ts || 0) > 180_000) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

async function handlePreInvocation(payload) {
  if (isControlArm(payload)) {
    return {};
  }

  const workspaceRoot =
    (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) ||
    process.cwd();

  const transcriptCtx = extractTranscriptContext(payload, workspaceRoot);
  const userMessage = transcriptCtx.latestUserInput;

  if (!userMessage) {
    const sessionState = getSessionState(payload?.conversationId);
    const loopThreshold =
      sessionState?.executionMode === 'codebase_audit_or_answer' ? 5 : 4;
    const overThreshold = transcriptCtx.consecutiveSearchTurns - loopThreshold;
    const shouldFireLoopBreaker =
      overThreshold >= 0 &&
      overThreshold % 3 === 0 &&
      sessionState?.lastLoopBreakerTurn !== transcriptCtx.turnsSinceUserInput;

    if (shouldFireLoopBreaker) {
      if (sessionState) {
        setSessionState(payload?.conversationId, {
          ...sessionState,
          lastLoopBreakerTurn: transcriptCtx.turnsSinceUserInput,
        });
      }
      const savedFiles = (sessionState?.topFiles || [])
        .map((f) => `${f.file}${f.primaryRange ? ` (${f.primaryRange})` : ''}`)
        .join(', ');
      const targetNote = savedFiles ? ` Target files: ${savedFiles}.` : '';
      logTelemetry({
        hook: 'PreInvocation:loop_breaker',
        turnsSinceUserInput: transcriptCtx.turnsSinceUserInput,
        consecutiveSearchTurns: transcriptCtx.consecutiveSearchTurns,
      });
      return {
        injectSteps: [
          {
            ephemeralMessage: `[JEV CONVERGENCE GUARD] You have spent ${transcriptCtx.consecutiveSearchTurns} consecutive unbatched search turns.${targetNote} Stop serial grep/search calls: batch any final read_file/view_file calls now and proceed directly to your edit or final answer.`,
          },
        ],
      };
    }
    if (
      transcriptCtx.turnsSinceUserInput === 1 &&
      sessionState?.turn2Reminder
    ) {
      return {
        injectSteps: [
          {
            ephemeralMessage: sessionState.turn2Reminder,
          },
        ],
      };
    }
    return {};
  }

  if (userMessage.length < 4) {
    return {};
  }

  if (
    userMessage.length < 65 &&
    /^(yes|yep|ok|okay|sure|please\s+proceed|proceed|go\s+ahead|do\s+it|lgtm|commit(\s+and\s+push)?|push\s+to\s+.*|make\s+a?\s*pr|create\s+a?\s*pr)\b/i.test(
      userMessage.trim()
    )
  ) {
    setSessionState(payload?.conversationId, {
      readOnlyQuestionTurn: false,
      executionMode: 'conversational_or_git_ops',
    });
    return {};
  }

  const candidates = await findCandidateFilesWithSummaries(
    userMessage,
    workspaceRoot,
    transcriptCtx
  );

  const questions = {
    execution_mode: {
      type: 'choice',
      instructions:
        'What is the primary execution mode required to handle `user_prompt`?',
      criteria: {
        direct_code_write:
          'Self-contained coding specification where exact target file path(s) and complete logic requirements are already provided in the prompt',
        codebase_audit_or_answer:
          'Read-only codebase investigation, audit, diagnostic, or architectural question without modifying files',
        codebase_edit:
          'Modifying, creating, or refactoring repository files to fix a bug, update configuration, or implement a requested change',
        conversational_or_git_ops:
          'Short conversational follow-up, approval ("proceed", "yes"), git commit/push/branch request, or simple command where no file discovery plan is needed',
      },
    },
    is_self_contained_spec: {
      type: 'noul',
      instructions:
        'Does `user_prompt` already specify the exact file paths to create and the complete business logic rules so no codebase search is needed?',
      criteria: {
        true: 'Exact target file path(s) and full function/logic specification are explicitly stated in `user_prompt`',
        false:
          'Requires inspecting existing repository files or answering a question',
      },
    },
    is_investigatory_question_only: {
      type: 'noul',
      instructions:
        'Is `user_prompt` asking an investigatory, diagnostic, or explanatory question ("why", "how", "what if", "find out if") where the assistant should answer in text FIRST without modifying any files?',
      criteria: {
        true: 'Pure question, audit, or brainstorming request; user has NOT asked to apply code edits right now',
        false:
          'User explicitly asks to implement, edit, fix, create, update, commit, or proceed with changes',
      },
    },
    is_underspecified_or_ambiguous: {
      type: 'noul',
      instructions:
        'Does `user_prompt` ask to build or change something with multiple conflicting architectural choices or critical missing requirements where the assistant should ask a clarifying question BEFORE writing code?',
      criteria: {
        true: 'Vague or ambiguous change request with critical unstated requirements that require user clarification first',
        false:
          'Clear bug fix, specific edit, self-contained spec, or read-only question that can be executed or answered directly',
      },
    },
    verification_strategy: {
      type: 'choice',
      instructions:
        'What is the most token-efficient verification step after completing `user_prompt`?',
      criteria: {
        none_needed:
          'Read-only question, documentation/config edit, or conversational turn requiring no test execution',
        targeted_unit_test:
          'Run only the specific unit test file or package touched by the change (never the entire monorepo suite)',
        typecheck_or_lint_only:
          'Run a fast static analyzer or typechecker on the modified package',
      },
    },
  };

  candidates.forEach((cand, idx) => {
    questions[`cand_file_${idx}`] = {
      type: 'noul',
      instructions: `Is \`candidate_files[${idx}]\` (${cand.file}) a primary file that must be read or edited to fulfill \`user_prompt\`?`,
      criteria: {
        true: 'Contains matching code/symbols (see `symbols` and `match_preview`), pending git changes, or recent context targeted by `user_prompt`',
        false: 'Unrelated file with no relevant symbol or snippet matches',
      },
    };
  });

  try {
    const res = await evaluateSystemOne({
      state: {
        workspace_name: path.basename(workspaceRoot),
        user_prompt: userMessage.slice(0, 4000),
        ...(transcriptCtx.recentContextSummary
          ? { recent_context: transcriptCtx.recentContextSummary }
          : {}),
        candidate_files: candidates.map((c) => ({
          file: c.file,
          git_status: c.gitStatus,
          symbols: c.symbols,
          ...(c.matchPreview ? { match_preview: c.matchPreview } : {}),
        })),
      },
      questions,
    });

    const mode =
      res.answers?.execution_mode?.choice || 'codebase_audit_or_answer';
    const isSelfContained = res.answers?.is_self_contained_spec?.noul ?? 0;
    const isQuestionOnly =
      res.answers?.is_investigatory_question_only?.noul ?? 0;
    const isAmbiguous =
      res.answers?.is_underspecified_or_ambiguous?.noul ?? 0;
    const verifyStrategy =
      res.answers?.verification_strategy?.choice || 'targeted_unit_test';

    const topFiles = candidates
      .map((c, idx) => {
        const startLine = c.primaryStart;
        const endLine = c.primaryEnd;
        return {
          ...c,
          prob: res.answers?.[`cand_file_${idx}`]?.noul ?? 0,
          primaryRange:
            startLine && endLine ? `L${startLine}-L${endLine}` : '',
          startLine,
          endLine,
        };
      })
      .filter((f) => f.prob >= 0.6)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 4);

    const readOnlyLock =
      mode === 'codebase_audit_or_answer' && isQuestionOnly >= 0.88;

    const applicableRules = discoverApplicableRules(workspaceRoot, topFiles);
    const rulesNote =
      applicableRules.length > 0
        ? ` (Rules: ${applicableRules.join(', ')})`
        : '';

    const turn2Reminder =
      mode === 'direct_code_write' || isSelfContained >= 0.75
        ? `[JEV TURN-2 PLAN] Run the targeted verification test command now, then output the final summary and stop.`
        : readOnlyLock
          ? `[JEV TURN-2 PLAN] Read-Only Question Mode active. Synthesize your technical answer directly from the slices read without modifying files.`
          : topFiles.length > 0
            ? `[JEV TURN-2 PLAN] Edit target slices (${topFiles.map((f) => path.basename(f.file)).join(', ')})${rulesNote}. Verify with: ${verifyStrategy}.`
            : '';

    setSessionState(payload?.conversationId, {
      readOnlyQuestionTurn: readOnlyLock,
      executionMode: mode,
      verifyStrategy,
      turn2Reminder,
      topFiles: topFiles.map((f) => ({
        file: f.file,
        absFile: f.absFile,
        prob: f.prob,
        primaryRange: f.primaryRange,
        startLine: f.startLine,
        endLine: f.endLine,
        totalLines: f.totalLines,
      })),
    });

    logTelemetry({
      hook: 'PreInvocation',
      latencyMs: res.latencyMs,
      cached: Boolean(res.cached),
      model: res.model,
      workspace: path.basename(workspaceRoot),
      promptPreview: userMessage.slice(0, 140),
      executionMode: mode,
      isSelfContained,
      isQuestionOnly,
      isAmbiguous,
      verifyStrategy,
      readOnlyLock,
      topFiles: topFiles.map((f) => ({
        file: f.file,
        gitStatus: f.gitStatus,
        prob: f.prob,
      })),
    });

    if (mode === 'conversational_or_git_ops' && isSelfContained < 0.75) {
      return {};
    }

    const clarifyNote =
      isAmbiguous >= 0.85 && mode === 'codebase_edit'
        ? `\n- AMBIGUITY ALERT (p=${isAmbiguous.toFixed(2)}): Requirements appear underspecified. Inspect the primary file slice below once, then ask a concise clarifying question before making broad architectural changes.`
        : '';

    let directive = '';
    if (mode === 'direct_code_write' || isSelfContained >= 0.75) {
      const mentionsGo =
        /\.go\b|\bpackage\s+\w+|\bgo\s+test\b/i.test(userMessage);
      directive = [
        `[JEV SYSTEM-1 EXECUTIVE PLAN (${res.latencyMs}ms) — OBEY STRICTLY]`,
        `- Mode: DIRECT_CODE_WRITE (Self-Contained Spec, p=${isSelfContained.toFixed(2)})${rulesNote}.`,
        `- PROHIBITIONS: Zero exploratory grep/rg/find/ls/cat. Zero unrelated SKILL.md or MCP schema reads.`,
        `- TURN 1: Call write_file / write_to_file IN PARALLEL for all requested implementation & test files right now (omit ArtifactMetadata).`,
        ...(mentionsGo
          ? [
              `  * Go Rules: signature (ctx context.Context, input XInput) (*XOutput, error); typed domain error sentinels (type DomainError string) instead of raw errors.New; flat guard clauses, zero else-after-return, zero narrative comments.`,
            ]
          : [
              `  * Code Rules: flat early-return guard clauses, zero else-after-return, zero narrative/apology comments.`,
            ]),
        `- TURN 2: Run the verification test command, then finish immediately.`,
      ].join('\n');
    } else if (mode === 'codebase_audit_or_answer' || readOnlyLock) {
      const fileLines = topFiles.map(
        (f) =>
          `  * ${f.absFile} (p=${f.prob.toFixed(2)}, git=${f.gitStatus}) [${f.symbols || 'source file'}]`
      );
      directive = [
        `[JEV SYSTEM-1 EXECUTIVE PLAN (${res.latencyMs}ms) — OBEY STRICTLY]`,
        `- Mode: CODEBASE_AUDIT_OR_ANSWER (Read-Only Question-First, Workspace=${path.basename(workspaceRoot)})${rulesNote}.`,
        `- PROHIBITIONS: Answer in text FIRST. Do NOT edit files or run mutating commands. Do NOT read unrelated SKILL.md or MCP schemas.`,
        ...(fileLines.length > 0
          ? [
              `- Pre-Ranked Files & Symbol Line Ranges:`,
              ...fileLines,
              `- TURN 1: Call read_file / view_file IN A SINGLE PARALLEL BATCH using StartLine/EndLine from the L<start>-L<end> ranges above. Never read files one-by-one across serial turns.`,
            ]
          : [
              `- TURN 1: Run a single targeted search and batch all read_file / view_file calls in parallel.`,
            ]),
      ].join('\n');
    } else {
      const fileLines = topFiles.map(
        (f) =>
          `  * ${f.absFile} (p=${f.prob.toFixed(2)}, git=${f.gitStatus}) [${f.symbols || 'source file'}]`
      );
      directive = [
        `[JEV SYSTEM-1 EXECUTIVE PLAN (${res.latencyMs}ms) — OBEY STRICTLY]`,
        `- Mode: CODEBASE_EDIT (Workspace=${path.basename(workspaceRoot)}, Verify=${verifyStrategy})${rulesNote}.${clarifyNote}`,
        `- PROHIBITIONS: Do NOT read unrelated SKILL.md or MCP schemas. Use StartLine/EndLine from the L<start>-L<end> ranges below instead of reading whole files.`,
        ...(fileLines.length > 0
          ? [`- Pre-Ranked Target Files & Symbol Line Ranges:`, ...fileLines]
          : []),
      ].join('\n');
    }

    return {
      injectSteps: [
        {
          ephemeralMessage: directive,
        },
      ],
    };
  } catch (err) {
    logTelemetry({
      hook: 'PreInvocation',
      error: String(err?.message || err),
    });
    return {};
  }
}

function extractAddedCode(toolName, args) {
  if (toolName === 'edit_file') {
    return args?.Replacement || '';
  }
  if (toolName === 'write_file') {
    return args?.Content || '';
  }
  if (toolName === 'replace_file_content') {
    return args?.ReplacementContent || '';
  }
  if (
    toolName === 'multi_replace_file_content' &&
    Array.isArray(args?.ReplacementChunks)
  ) {
    return args.ReplacementChunks.map((c) => c.ReplacementContent || '').join(
      '\n\n'
    );
  }
  if (toolName === 'write_to_file') {
    return args?.CodeContent || '';
  }
  return '';
}

async function handlePreToolUse(payload) {
  if (isControlArm(payload)) {
    return { decision: 'allow' };
  }

  const toolName = payload?.toolCall?.name || '';
  const args = payload?.toolCall?.args || {};

  if (toolName === 'read_file' || toolName === 'view_file') {
    const readPath = args?.Path || args?.AbsolutePath || args?.TargetFile || '';
    if (!readPath) {
      return { decision: 'allow' };
    }
    const startArg = args?.StartLine;
    const endArg = args?.EndLine;
    const hasExplicitNarrowBounds =
      (startArg != null || endArg != null) &&
      !(
        (startArg == null || startArg <= 1) &&
        (endArg == null || endArg - (startArg || 1) >= 500)
      );
    if (hasExplicitNarrowBounds) {
      return { decision: 'allow' };
    }

    if (GENERATED_FILE_REGEX.test(readPath)) {
      logTelemetry({
        hook: 'PreToolUse:read_cap',
        toolName,
        targetFile: readPath,
        reason: 'cap_generated_or_lockfile',
      });
      return {
        decision: 'allow',
        overwrite: {
          StartLine: 1,
          EndLine: 120,
        },
      };
    }

    const sessionState = getSessionState(payload?.conversationId);
    const normRead = readPath.replace(/\\/g, '/');
    const rankedMatch = (sessionState?.topFiles || []).find((f) => {
      const normAbs = (f.absFile || '').replace(/\\/g, '/');
      const normRel = (f.file || '').replace(/\\/g, '/');
      return normAbs === normRead || (normRel && normRead.endsWith(`/${normRel}`));
    });
    const alreadySliced = (sessionState?.autoSlicedFiles || []).includes(
      normRead
    );
    if (
      rankedMatch &&
      !alreadySliced &&
      rankedMatch.totalLines > 450 &&
      rankedMatch.startLine &&
      rankedMatch.endLine
    ) {
      const sliceStart = Math.max(1, rankedMatch.startLine - 25);
      const sliceEnd = Math.min(
        rankedMatch.totalLines,
        Math.max(rankedMatch.endLine + 40, sliceStart + 140)
      );
      setSessionState(payload?.conversationId, {
        ...sessionState,
        autoSlicedFiles: [...(sessionState?.autoSlicedFiles || []), normRead],
      });
      logTelemetry({
        hook: 'PreToolUse:read_slice',
        toolName,
        targetFile: readPath,
        totalLines: rankedMatch.totalLines,
        sliceStart,
        sliceEnd,
      });
      return {
        decision: 'allow',
        overwrite: {
          StartLine: sliceStart,
          EndLine: sliceEnd,
        },
      };
    }

    return { decision: 'allow' };
  }

  if (
    toolName === 'replace_file_content' ||
    toolName === 'multi_replace_file_content' ||
    toolName === 'write_to_file' ||
    toolName === 'edit_file' ||
    toolName === 'write_file'
  ) {
    const targetFile =
      args?.TargetFile || args?.Path || args?.AbsolutePath || '';

    const sessionState = getSessionState(payload?.conversationId);
    if (
      sessionState?.readOnlyQuestionTurn &&
      targetFile &&
      !/[/\\]brain[/\\]/.test(targetFile)
    ) {
      logTelemetry({
        hook: 'PreToolUse:question_first_lock',
        toolName,
        targetFile,
        action: 'deny_edit_on_question_turn',
      });
      return {
        decision: 'deny',
        reason: `[Jev System-1 Question-First Guardrail] The user's prompt was classified as an investigatory/explanatory question without an edit request. Answer the user's question in text first before modifying ${path.basename(targetFile)}.`,
      };
    }

    const ext = path.extname(targetFile).toLowerCase();
    const addedCode = extractAddedCode(toolName, args).trim();

    if (!CODE_EXTENSIONS.has(ext) || addedCode.length < 25) {
      return { decision: 'allow' };
    }

    const isTestFile =
      /(?:_test\.go|\.(?:test|spec)\.[jt]sx?|_test\.dart)$/i.test(targetFile);
    const hasSuspiciousComments =
      /(?:(?<!:)\/\/|\/\*|^\s*#(?!\!))\s*(?:step\s*\d|phase\s*\d|part\s*\d|stage\s*\d|first,|second,|third,|finally,|hack\b|workaround\b|temp(?:orary)?\b|fragile\b|do\s+not\s+touch|kludge\b|band-?aid\b|apolog|todo\b|fixme\b|xxx\b|initialize\s+var|validate\s+input|return\s+result)/im.test(
        addedCode
      ) ||
      (addedCode.match(/^\s+(?:(?<!:)\/\/|#(?!\!))\s+\S/gm) || []).length >= 3;
    const hasElse = /\belse\b/.test(addedCode);
    const hasGoErrNil = ext === '.go' && /\berr\s*==\s*nil\b/.test(addedCode);
    const hasGoRawErrorsNew =
      ext === '.go' && !isTestFile && /\berrors\.New\s*\(/.test(addedCode);
    const hasErrorConstruct =
      /\b(catch\s*(\(|{)|err\s*(!=|==)\s*nil|_\s*=\s*\w+|except\b|rescue\b)/.test(
        addedCode
      );

    const codeQuestions = {};
    if (hasSuspiciousComments) {
      codeQuestions.has_narrative_comments = {
        type: 'noul',
        instructions:
          'Does `proposed_code` contain phase-narrating comments such as "// Step 1:", "// Phase 2:", or "// Initialize variables"?',
        criteria: {
          true: 'Contains explicit step-by-step or phase-narrating comments',
          false:
            'No narrative comments; only doc comments, license headers, or non-obvious constraint notes',
        },
      };
      codeQuestions.has_apology_or_hack_comments = {
        type: 'noul',
        instructions:
          'Does `proposed_code` contain workaround or apology comments such as "// Hack for...", "// Temporary workaround", or "// Do not touch"?',
        criteria: {
          true: 'Contains comments apologizing for a hack, race condition workaround, or fragile code',
          false: 'Clean code or standard technical documentation comments',
        },
      };
    }
    if (hasElse) {
      codeQuestions.has_else_after_return = {
        type: 'noul',
        instructions:
          'Does `proposed_code` contain an `else` or `else if` block immediately after an `if` block that unconditionally ends with `return`, `continue`, `break`, or `throw`?',
        criteria: {
          true: 'An `if` block terminates unconditionally with return/throw/continue/break and is immediately followed by `else` or `else if`',
          false:
            'Uses flat guard clauses without `else` after return, or the `if` branch does not unconditionally return',
        },
      };
    }
    if (hasGoErrNil) {
      codeQuestions.has_err_nil_happy_path = {
        type: 'noul',
        instructions:
          'In Go code, does `proposed_code` wrap the happy path inside `if err == nil { ... }` instead of checking `if err != nil` and returning early?',
        criteria: {
          true: 'Go code branches on `if err == nil` to execute primary logic',
          false:
            'Not Go code, or checks `if err != nil` first as a guard clause',
        },
      };
    }
    if (hasErrorConstruct) {
      codeQuestions.swallows_error_silently = {
        type: 'noul',
        instructions:
          'Does `proposed_code` silently swallow an error or exception (e.g., an empty `catch {}` block, `_ = err` on a critical mutation, or logging an error inside an `if err != nil` block and falling through without returning)?',
        criteria: {
          true: 'Catches or checks an error and silently ignores it or falls through to downstream mutations without returning/throwing',
          false:
            'Properly returns, wraps, or throws errors, or no error handling is present in the snippet',
        },
      };
    }
    if (hasGoRawErrorsNew) {
      codeQuestions.uses_raw_errors_new_in_go = {
        type: 'noul',
        instructions:
          'In Go code, does `proposed_code` construct domain or wrapped errors using raw `errors.New(...)` when the repository uses structured `xerrors` (`xerrors.New` / `xerrors.Wrapf`) or typed domain error sentinels?',
        criteria: {
          true: 'Go code calls raw `errors.New(...)` for a domain/sentinel error',
          false:
            'Not Go code, uses `xerrors`/typed errors, or does not call `errors.New`',
        },
      };
    }

    if (Object.keys(codeQuestions).length === 0) {
      return { decision: 'allow' };
    }

    try {
      const res = await evaluateSystemOne({
        state: {
          file_path: targetFile,
          language_extension: ext,
          proposed_code: addedCode.slice(0, 6000),
        },
        questions: codeQuestions,
      });

      const a = res.answers || {};
      const violations = [];
      if ((a.has_narrative_comments?.noul ?? 0) >= 0.92) {
        violations.push(
          `narrative comments (p=${a.has_narrative_comments.noul.toFixed(2)})`
        );
      }
      if ((a.has_apology_or_hack_comments?.noul ?? 0) >= 0.92) {
        violations.push(
          `workaround/apology comments (p=${a.has_apology_or_hack_comments.noul.toFixed(2)})`
        );
      }
      if ((a.has_else_after_return?.noul ?? 0) >= 0.93) {
        violations.push(
          `else/else-if after guard return (p=${a.has_else_after_return.noul.toFixed(2)})`
        );
      }
      if (ext === '.go' && (a.has_err_nil_happy_path?.noul ?? 0) >= 0.92) {
        violations.push(
          `if err == nil happy-path branching (p=${a.has_err_nil_happy_path.noul.toFixed(2)})`
        );
      }
      if ((a.swallows_error_silently?.noul ?? 0) >= 0.93) {
        violations.push(
          `silent error swallowing / fall-through (p=${a.swallows_error_silently.noul.toFixed(2)})`
        );
      }
      if (ext === '.go' && (a.uses_raw_errors_new_in_go?.noul ?? 0) >= 0.94) {
        violations.push(
          `raw errors.New instead of xerrors.New (p=${a.uses_raw_errors_new_in_go.noul.toFixed(2)})`
        );
      }

      logTelemetry({
        hook: 'PreToolUse:code',
        toolName,
        targetFile,
        latencyMs: res.latencyMs,
        cached: Boolean(res.cached),
        scores: {
          narrativeComments: a.has_narrative_comments?.noul,
          hackComments: a.has_apology_or_hack_comments?.noul,
          elseAfterReturn: a.has_else_after_return?.noul,
          errNilHappyPath: a.has_err_nil_happy_path?.noul,
          swallowsError: a.swallows_error_silently?.noul,
          rawErrorsNew: a.uses_raw_errors_new_in_go?.noul,
        },
        violations,
      });

      if (violations.length > 0) {
        return {
          decision: 'deny',
          reason: `[Jev System-1 Code Guardrail (${res.latencyMs}ms)] Blocked edit to ${path.basename(targetFile)} due to code quality rule violation: ${violations.join(', ')}. Refactor the snippet and retry.`,
        };
      }
      return { decision: 'allow' };
    } catch (err) {
      logTelemetry({
        hook: 'PreToolUse:code',
        error: String(err?.message || err),
      });
      return { decision: 'allow' };
    }
  }

  if (toolName === 'run_command') {
    const cmd = (args?.CommandLine || '').trim();
    if (!cmd) {
      return { decision: 'allow' };
    }

    // Fast syntactic pre-screening for shell commands (<1ms for ~90% of dev commands)
    const hasDestructiveTrigger =
      /\b(rm\s|rmdir\s|unlink\s|git\s+clean\b|git\s+reset\s+--hard\b|drop\s+(table|database|schema)\b|truncate\s+table\b|terraform\s+destroy\b|kubectl\s+delete\b|docker\s+(rm|system\s+prune)\b|dd\s+if=|mkfs\b)/i.test(
        cmd
      );
    const hasForcePushTrigger =
      /\bgit\b.*\bpush\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b)/i.test(
        cmd
      );
    const hasOrTrueTrigger = /\|\|\s*(true|:)\b/.test(cmd);
    const hasSudoTrigger = /(^|[;&|]\s*)sudo\s+/.test(cmd);

    if (
      !hasDestructiveTrigger &&
      !hasForcePushTrigger &&
      !hasOrTrueTrigger &&
      !hasSudoTrigger
    ) {
      return { decision: 'allow' };
    }

    const cmdQuestions = {};
    if (hasDestructiveTrigger) {
      cmdQuestions.is_destructive_delete_or_drop = {
        type: 'noul',
        instructions:
          'Does `command_line` recursively delete project/system directories (`rm -rf`), discard uncommitted git work (`git reset --hard`), drop database tables, or destroy cloud infrastructure?',
        criteria: {
          true: 'Executes recursive deletion (`rm -rf`), database table/schema drop, or infrastructure destruction',
          false:
            'Normal build, test, git, or single temporary file cleanup without destructive directory/data loss',
        },
      };
    }
    if (hasForcePushTrigger) {
      cmdQuestions.is_remote_force_push = {
        type: 'noul',
        instructions:
          'Does `command_line` push to a git remote with `--force`, `-f`, or `--force-with-lease`?',
        criteria: {
          true: 'Runs `git push` with `--force`, `-f`, or `--force-with-lease`',
          false: 'Not a git force-push command',
        },
      };
    }
    if (hasOrTrueTrigger) {
      cmdQuestions.swallows_test_or_lint_failure = {
        type: 'noul',
        instructions:
          'Does `command_line` run a test suite, build, or linter and suppress its failure exit code using `|| true`?',
        criteria: {
          true: 'Runs a test, build, or linter command and appends `|| true` to mask non-zero exit codes',
          false:
            'Does not suppress test/build/linter exit codes (or uses `|| true` only on a benign search like `grep`)',
        },
      };
    }
    if (hasSudoTrigger) {
      cmdQuestions.uses_sudo_instead_of_pkexec = {
        type: 'noul',
        instructions:
          'Does `command_line` invoke `sudo` to run a privileged command on Linux instead of a polkit/systemd privilege escalation tool such as `pkexec` or `run0`?',
        criteria: {
          true: 'Invokes `sudo <command>` for root privileges',
          false:
            'Does not invoke `sudo` (e.g. invokes `pkexec`, `run0`, or unprivileged commands)',
        },
      };
    }

    try {
      const res = await evaluateSystemOne({
        state: {
          command_line: cmd.slice(0, 2000),
          cwd: args?.Cwd || '',
        },
        questions: cmdQuestions,
      });

      const a = res.answers || {};
      const destructive = a.is_destructive_delete_or_drop?.noul ?? 0;
      const forcePush = a.is_remote_force_push?.noul ?? 0;
      const swallowsFailure = a.swallows_test_or_lint_failure?.noul ?? 0;
      const usesSudo = a.uses_sudo_instead_of_pkexec?.noul ?? 0;

      logTelemetry({
        hook: 'PreToolUse:command',
        commandLine: cmd.slice(0, 200),
        latencyMs: res.latencyMs,
        cached: Boolean(res.cached),
        scores: {
          destructive,
          forcePush,
          swallowsFailure,
          usesSudo,
        },
      });

      if (destructive >= 0.9 || forcePush >= 0.9) {
        return {
          decision: 'force_ask',
          reason: `[Jev System-1 Command Guardrail (${res.latencyMs}ms)] High-risk command detected (destructive=${destructive.toFixed(2)}, force_push=${forcePush.toFixed(2)}). Requires explicit user confirmation.`,
        };
      }

      if (swallowsFailure >= 0.92) {
        const sanitizedCmd = cmd.replace(/\s*\|\|\s*(true|:)\s*$/, '').trim();
        if (sanitizedCmd && sanitizedCmd !== cmd) {
          logTelemetry({
            hook: 'PreToolUse:command:overwrite',
            originalCommand: cmd,
            sanitizedCommand: sanitizedCmd,
            reason: 'strip_trailing_or_true',
          });
          return {
            decision: 'allow',
            overwrite: {
              CommandLine: sanitizedCmd,
            },
          };
        }
        return {
          decision: 'deny',
          reason: `[Jev System-1 Command Guardrail (${res.latencyMs}ms)] Command suppresses test/build/linter exit code with '|| true' (p=${swallowsFailure.toFixed(2)}), violating the No Error Swallowing rule.`,
        };
      }

      if (usesSudo >= 0.92 && /^sudo\s+(?!-)/.test(cmd)) {
        const escalationTool = getPrivilegeEscalationTool();
        const sanitizedCmd = cmd.replace(/^sudo\s+/, `${escalationTool} `);
        logTelemetry({
          hook: 'PreToolUse:command:overwrite',
          originalCommand: cmd,
          sanitizedCommand: sanitizedCmd,
          reason: `rewrite_sudo_to_${escalationTool}`,
        });
        return {
          decision: 'allow',
          overwrite: {
            CommandLine: sanitizedCmd,
          },
        };
      }

      return { decision: 'allow' };
    } catch (err) {
      logTelemetry({
        hook: 'PreToolUse:command',
        error: String(err?.message || err),
      });
      return { decision: 'allow' };
    }
  }

  return { decision: 'allow' };
}

function isDuplicateStep(mode, payload) {
  const convId = payload?.conversationId || '';
  if (!convId) {
    return false;
  }
  const args = payload?.toolCall?.args || {};
  const targetDiscriminator =
    args?.TargetFile ||
    args?.Path ||
    args?.AbsolutePath ||
    (args?.CommandLine || '').slice(0, 60) ||
    '';

  let stepKey = '';
  if (mode === 'PreInvocation') {
    const invNum = payload?.invocationNum ?? '';
    const initSteps = payload?.initialNumSteps ?? '';
    if (invNum !== '' || initSteps !== '') {
      stepKey = `inv:${invNum}:${initSteps}`;
    } else if (payload?.transcriptPath && fs.existsSync(payload.transcriptPath)) {
      try {
        stepKey = `inv:tx:${fs.statSync(payload.transcriptPath).size}`;
      } catch {
        return false;
      }
    }
  } else {
    const toolName = payload?.toolCall?.name ?? '';
    if (toolName) {
      stepKey = `step:${payload?.stepIdx ?? ''}:${toolName}:${targetDiscriminator}`;
    }
  }

  if (!stepKey) {
    return false;
  }
  const dedupPath = path.join(os.tmpdir(), `jev-hook-last-step-${convId}.json`);
  const composite = `${convId}|${mode}|${stepKey}`;
  try {
    if (fs.existsSync(dedupPath)) {
      const prev = JSON.parse(fs.readFileSync(dedupPath, 'utf8'));
      if (prev.key === composite && Date.now() - prev.ts < 5000) {
        return true;
      }
    }
    fs.writeFileSync(
      dedupPath,
      JSON.stringify({ key: composite, ts: Date.now() }),
      'utf8'
    );
  } catch {
    return false;
  }
  return false;
}

async function main() {
  const mode = process.argv[2] || 'PreToolUse';
  const payload = readStdinJson();

  if (isDuplicateStep(mode, payload)) {
    process.stdout.write(
      mode === 'PreToolUse' ? '{"decision":"allow"}\n' : '{}\n'
    );
    return;
  }

  if (mode === 'PreInvocation') {
    const out = await handlePreInvocation(payload);
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  if (mode === 'PreToolUse') {
    const out = await handlePreToolUse(payload);
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  process.stdout.write('{}\n');
}

main().catch(() => {
  process.stdout.write('{"decision":"allow"}\n');
});
