#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

const SAFE_CMD_PREFIXES = [
  'ls',
  'pwd',
  'cat ',
  'head ',
  'tail ',
  'rg ',
  'grep ',
  'find ',
  'diff ',
  'sed -n',
  'uname',
  'lscpu',
  'lspci',
  'lsblk',
  'git status',
  'git diff',
  'git log',
  'git branch',
  'git show',
  'node -v',
  'go test',
  'go vet',
  'golangci-lint',
  'cargo test',
  'cargo check',
  'cargo clippy',
  'pytest',
  'npm test',
  'pnpm test',
  'yarn test',
  'npx tsc',
  'dart analyze',
  'dart test',
  'flutter test',
  'make analyze',
  'make test',
  'make lint',
  'make go-test',
  'make go-lint',
];

function getPrivilegeEscalationTool() {
  if (process.env.PRIVILEGE_ESCALATION) {
    return process.env.PRIVILEGE_ESCALATION;
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
  } catch (err) {
    return 'pkexec';
  }
}

function isSafeCommand(cmd) {
  if (
    !cmd ||
    cmd.includes('|| true') ||
    cmd.includes('rm ') ||
    cmd.includes('--force') ||
    cmd.startsWith('sudo ')
  ) {
    return false;
  }

  if (SAFE_CMD_PREFIXES.some((prefix) => cmd.startsWith(prefix))) {
    return true;
  }

  if (/^git\s+(?:-C\s+\S+\s+)?(?:status|diff|log|branch|show)\b/.test(cmd)) {
    return true;
  }

  return false;
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

function getLatestUserInput(payload) {
  const transcriptPath = payload?.transcriptPath;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8').trim();
      if (content) {
        const lines = content.split(/\r?\n/);
        for (
          let i = lines.length - 1;
          i >= Math.max(0, lines.length - 6);
          i--
        ) {
          const step = JSON.parse(lines[i]);
          if (step.type === 'PLANNER_RESPONSE' || step.type === 'TOOL_CALL') {
            return null;
          }
          if (
            (step.type === 'USER_INPUT' ||
              (step.step_index === 0 && step.type === 'SYSTEM_MESSAGE')) &&
            step.content
          ) {
            const text =
              typeof step.content === 'string'
                ? step.content
                : JSON.stringify(step.content);
            const cleaned = cleanPromptText(text);
            if (cleaned) {
              return cleaned;
            }
          }
        }
        return null;
      }
    } catch {
      // fall through to subagent message check
    }
  }

  if ((payload?.initialNumSteps ?? 0) <= 1) {
    const initMsg = getSubagentInitialMessage(payload);
    if (initMsg) {
      return cleanPromptText(initMsg) || null;
    }
  }
  if (typeof payload?.userPrompt === 'string' && payload.userPrompt.trim()) {
    return cleanPromptText(payload.userPrompt) || null;
  }
  return null;
}

function extractDirectoryHints(userMessage, workspaceRoot) {
  const hints = [];
  const pathTokens =
    userMessage.match(/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+/g) || [];
  for (const rawToken of pathTokens) {
    const cleanToken = rawToken.replace(/[.,:;!?)]+$/, '');
    const candidatePath = path.resolve(workspaceRoot, cleanToken);
    if (!candidatePath.startsWith(workspaceRoot)) {
      continue;
    }
    if (fs.existsSync(candidatePath)) {
      const stat = fs.statSync(candidatePath);
      hints.push(stat.isDirectory() ? candidatePath : path.dirname(candidatePath));
      continue;
    }
    const parentDir = path.dirname(candidatePath);
    if (parentDir.startsWith(workspaceRoot) && fs.existsSync(parentDir)) {
      hints.push(parentDir);
    }
  }
  return [...new Set(hints)];
}

function getGitDirtyFiles(workspaceRoot) {
  const dirtyMap = new Map();
  try {
    const gitRes = spawnSync(
      'git',
      ['-C', workspaceRoot, 'status', '--porcelain', '-uall'],
      { encoding: 'utf8', timeout: 150 }
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
  } catch {
    // ignore non-git workspaces
  }
  return dirtyMap;
}

function extractRankedSymbolsWithRanges(fileText, keywords) {
  const lines = fileText.split(/\r?\n/);
  const totalLines = lines.length;
  const symbolRegex =
    /^(func\s+|type\s+\w+\s+(struct|interface)|export\s+(default\s+)?(async\s+)?(function|class|const|interface|type)\s+|(async\s+)?def\s+\w+|class\s+\w+|(pub(\([^)]+\))?\s+)?(async\s+)?(fn|struct|enum|trait|impl)\s+|(public|protected|private|static|\s)*function\s+\w+)/;

  const rawSymbols = [];
  for (let i = 0; i < totalLines; i++) {
    const trimmed = lines[i].trim();
    if (symbolRegex.test(trimmed)) {
      rawSymbols.push({
        header: trimmed.replace(/\s*\{$/, '').slice(0, 85),
        startLine: i + 1,
      });
    }
  }

  for (let i = 0; i < rawSymbols.length; i++) {
    const endLine =
      i + 1 < rawSymbols.length
        ? rawSymbols[i + 1].startLine - 1
        : totalLines;
    const headerLower = rawSymbols[i].header.toLowerCase();
    const kwHits = keywords.filter((kw) =>
      headerLower.includes(kw.toLowerCase())
    ).length;
    rawSymbols[i].endLine = endLine;
    rawSymbols[i].kwHits = kwHits;
  }

  return rawSymbols
    .sort((a, b) => b.kwHits - a.kwHits || a.startLine - b.startLine)
    .slice(0, 8)
    .sort((a, b) => a.startLine - b.startLine)
    .map((s) => `L${s.startLine}-L${s.endLine}: ${s.header}`)
    .join('; ');
}

function findCandidateFilesWithSummaries(userMessage, workspaceRoot) {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return [];
  }
  try {
    const dirHints = extractDirectoryHints(userMessage, workspaceRoot);
    const searchPaths =
      dirHints.length > 0 ? dirHints.slice(0, 3) : [workspaceRoot];

    const tokens = userMessage
      .replace(/[^a-zA-Z0-9_./-]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(
        (t) =>
          t.length >= 4 &&
          !STOPWORDS.has(t.toLowerCase()) &&
          !t.includes('/')
      );

    const uniqueKeywords = [...new Set(tokens)].slice(0, 7);
    const dirtyMap = getGitDirtyFiles(workspaceRoot);
    const candidateMap = new Map();

    for (const [absFile, gitStatus] of dirtyMap.entries()) {
      const relFile = path.relative(workspaceRoot, absFile);
      const keywordHits = uniqueKeywords.filter((kw) =>
        relFile.toLowerCase().includes(kw.toLowerCase())
      ).length;
      candidateMap.set(absFile, {
        absFile,
        relFile,
        gitStatus,
        rankScore: 25 + keywordHits * 45,
      });
    }

    if (uniqueKeywords.length > 0) {
      const pattern = uniqueKeywords
        .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

      const rgRes = spawnSync(
        'rg',
        [
          '-i',
          '-c',
          '--no-messages',
          '--max-filesize',
          '200K',
          '-g',
          '!node_modules/**',
          '-g',
          '!.git/**',
          '-g',
          '!vendor/**',
          '-g',
          '!dist/**',
          '-g',
          '!build/**',
          '-g',
          '!target/**',
          '-g',
          '!.next/**',
          '-g',
          '!coverage/**',
          '-g',
          '!*.lock',
          '-g',
          '!package-lock.json',
          '-g',
          '!*.pb.go',
          '-g',
          '!*mock*.go',
          '-g',
          '!*_test.go',
          '-g',
          '!*_test.ts',
          '-g',
          '!*_test.dart',
          '-g',
          '!*.spec.ts',
          '-g',
          '!*.test.ts',
          '-g',
          '!*.g.dart',
          '-g',
          '!*.freezed.dart',
          pattern,
          ...searchPaths,
        ],
        { encoding: 'utf8', timeout: 350 }
      );

      if (rgRes.stdout) {
        const rgLines = rgRes.stdout.trim().split(/\r?\n/).filter(Boolean);
        for (const line of rgLines) {
          const lastColon = line.lastIndexOf(':');
          if (lastColon === -1) continue;
          const absFile = line.slice(0, lastColon);
          const count = parseInt(line.slice(lastColon + 1), 10) || 0;
          const relFile = path.relative(workspaceRoot, absFile);
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
    }

    const candidates = [...candidateMap.values()]
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, 8);

    return candidates.map((c) => {
      let symbols = '';
      try {
        const fileText = fs.readFileSync(c.absFile, 'utf8');
        symbols = extractRankedSymbolsWithRanges(fileText, uniqueKeywords);
      } catch {
        symbols = '';
      }
      return {
        file: c.relFile,
        absFile: c.absFile,
        gitStatus: c.gitStatus,
        symbols,
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

  const userMessage = getLatestUserInput(payload);
  if (!userMessage || userMessage.length < 4) {
    return {};
  }

  const workspaceRoot =
    (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) ||
    process.cwd();

  const candidates = findCandidateFilesWithSummaries(
    userMessage,
    workspaceRoot
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
        false: 'Requires inspecting existing repository files or answering a question',
      },
    },
    is_investigatory_question_only: {
      type: 'noul',
      instructions:
        'Is `user_prompt` asking an investigatory, diagnostic, or explanatory question ("why", "how", "what if", "find out if") where the assistant should answer in text FIRST without modifying any files?',
      criteria: {
        true: 'Pure question, audit, or brainstorming request; user has NOT asked to apply code edits right now',
        false: 'User explicitly asks to implement, edit, fix, create, update, commit, or proceed with changes',
      },
    },
  };

  candidates.forEach((cand, idx) => {
    questions[`cand_file_${idx}`] = {
      type: 'noul',
      instructions: `Is \`candidate_files[${idx}]\` (${cand.file}) a primary file that must be read or edited to fulfill \`user_prompt\`?`,
      criteria: {
        true: 'Defines or configures the exact logic, symbols, or pending changes targeted by `user_prompt`',
        false: 'Unrelated or merely shares a generic keyword',
      },
    };
  });

  try {
    const res = await evaluateSystemOne({
      state: {
        workspace_name: path.basename(workspaceRoot),
        user_prompt: userMessage.slice(0, 4000),
        candidate_files: candidates.map((c) => ({
          file: c.file,
          git_status: c.gitStatus,
          symbols: c.symbols,
        })),
      },
      questions,
    });

    const mode =
      res.answers?.execution_mode?.choice || 'codebase_audit_or_answer';
    const isSelfContained = res.answers?.is_self_contained_spec?.noul ?? 0;
    const isQuestionOnly =
      res.answers?.is_investigatory_question_only?.noul ?? 0;

    const topFiles = candidates
      .map((c, idx) => ({
        ...c,
        prob: res.answers?.[`cand_file_${idx}`]?.noul ?? 0,
      }))
      .filter((f) => f.prob >= 0.72)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 4);

    const readOnlyLock =
      mode === 'codebase_audit_or_answer' && isQuestionOnly >= 0.88;
    setSessionState(payload?.conversationId, {
      readOnlyQuestionTurn: readOnlyLock,
      executionMode: mode,
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

    const applicableRules = discoverApplicableRules(workspaceRoot, topFiles);
    const rulesNote =
      applicableRules.length > 0
        ? ` (Applicable Workspace Rules: ${applicableRules.join(', ')})`
        : '';

    let directive = '';
    if (mode === 'direct_code_write' || isSelfContained >= 0.75) {
      const mentionsGo =
        /\.go\b|\bpackage\s+\w+|\bgo\s+test\b/i.test(userMessage);
      directive = [
        `[JEV SYSTEM-1 EXECUTIVE DECISION PLAN (${res.latencyMs}ms) — OBEY STRICTLY]`,
        `- Decision: DIRECT_CODE_WRITE (Self-Contained Specification, p=${isSelfContained.toFixed(2)})${rulesNote}.`,
        `- STRICT PROHIBITIONS: Do NOT run exploratory grep, rg, find, ls, or cat. Do NOT read unrelated SKILL.md files or MCP tool schemas.`,
        `- TURN 1 (MANDATORY): Call write_to_file IN PARALLEL for all requested implementation and test files right now in Turn 1 (omit ArtifactMetadata for non-artifact files).`,
        ...(mentionsGo
          ? [
              `  * Go Standards: signature must be (ctx context.Context, input XInput) (*XOutput, error); define typed domain error sentinels (type DomainError string) instead of raw errors.New; use early-return guard clauses with zero else-after-return and zero narrative comments.`,
            ]
          : [
              `  * Code Standards: use early-return guard clauses with zero else-after-return and zero narrative/apology comments.`,
            ]),
        `- TURN 2 (MANDATORY): Call run_command to execute the verification/test command specified in the prompt.`,
        `- TURN 3 (MANDATORY): Call send_message (if subagent) or output the final summary and terminate immediately.`,
      ].join('\n');
    } else if (mode === 'codebase_audit_or_answer' || readOnlyLock) {
      const fileLines = topFiles.map(
        (f) =>
          `  * ${f.absFile} (p=${f.prob.toFixed(2)}, git=${f.gitStatus}) [${f.symbols || 'source file'}]`
      );
      directive = [
        `[JEV SYSTEM-1 EXECUTIVE DECISION PLAN (${res.latencyMs}ms) — OBEY STRICTLY]`,
        `- Decision: CODEBASE_AUDIT_OR_ANSWER (Read-Only Question-First Mode, Workspace=${path.basename(workspaceRoot)})${rulesNote}.`,
        `- STRICT PROHIBITIONS: Answer the user's question/audit in text FIRST. Do NOT modify any files or run mutating commands during this turn. Do NOT read unrelated SKILL.md files or MCP tool schemas.`,
        ...(fileLines.length > 0
          ? [
              `- Jev Pre-Ranked Primary Files & Symbol Line Ranges (Confidence >= 0.72):`,
              ...fileLines,
              `- TURN 1 (MANDATORY): Call view_file IN A SINGLE PARALLEL BATCH on the Jev Pre-Ranked Primary Files above using their L<start>-L<end> line ranges where applicable. Do NOT read files one-by-one across serial turns.`,
              `- TURN 2-3 (MANDATORY): Read any directly referenced callee file in one batch, then synthesize the complete technical answer and finish immediately.`,
            ]
          : [
              `- TURN 1: Run a single targeted rg search and batch all view_file calls in parallel.`,
            ]),
      ].join('\n');
    } else {
      const fileLines = topFiles.map(
        (f) =>
          `  * ${f.absFile} (p=${f.prob.toFixed(2)}, git=${f.gitStatus}) [${f.symbols || 'source file'}]`
      );
      directive = [
        `[JEV SYSTEM-1 EXECUTIVE DECISION PLAN (${res.latencyMs}ms) — OBEY STRICTLY]`,
        `- Decision: CODEBASE_EDIT (Workspace=${path.basename(workspaceRoot)})${rulesNote}.`,
        `- STRICT PROHIBITIONS: Do NOT read unrelated SKILL.md or MCP schemas. Batch file reads and edits efficiently using the symbol L<start>-L<end> ranges below.`,
        ...(fileLines.length > 0
          ? [`- Jev Pre-Ranked Target Files & Symbol Line Ranges:`, ...fileLines]
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

  if (
    toolName === 'replace_file_content' ||
    toolName === 'multi_replace_file_content' ||
    toolName === 'write_to_file'
  ) {
    const targetFile = args?.TargetFile || '';

    const sessionState = getSessionState(payload?.conversationId);
    if (
      sessionState?.readOnlyQuestionTurn &&
      targetFile &&
      !targetFile.includes('/brain/')
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

    try {
      const res = await evaluateSystemOne({
        state: {
          file_path: targetFile,
          language_extension: ext,
          proposed_code: addedCode.slice(0, 6000),
        },
        questions: {
          has_narrative_comments: {
            type: 'noul',
            instructions:
              'Does `proposed_code` contain phase-narrating comments such as "// Step 1:", "// Phase 2:", or "// Initialize variables"?',
            criteria: {
              true: 'Contains explicit step-by-step or phase-narrating comments',
              false:
                'No narrative comments; only doc comments, license headers, or non-obvious constraint notes',
            },
          },
          has_apology_or_hack_comments: {
            type: 'noul',
            instructions:
              'Does `proposed_code` contain workaround or apology comments such as "// Hack for...", "// Temporary workaround", or "// Do not touch"?',
            criteria: {
              true: 'Contains comments apologizing for a hack, race condition workaround, or fragile code',
              false: 'Clean code or standard technical documentation comments',
            },
          },
          has_else_after_return: {
            type: 'noul',
            instructions:
              'Does `proposed_code` contain an `else` or `else if` block immediately after an `if` block that unconditionally ends with `return`, `continue`, `break`, or `throw`?',
            criteria: {
              true: 'An `if` block terminates unconditionally with return/throw/continue/break and is immediately followed by `else` or `else if`',
              false:
                'Uses flat guard clauses without `else` after return, or the `if` branch does not unconditionally return',
            },
          },
          has_err_nil_happy_path: {
            type: 'noul',
            instructions:
              'In Go code, does `proposed_code` wrap the happy path inside `if err == nil { ... }` instead of checking `if err != nil` and returning early?',
            criteria: {
              true: 'Go code branches on `if err == nil` to execute primary logic',
              false:
                'Not Go code, or checks `if err != nil` first as a guard clause',
            },
          },
          swallows_error_silently: {
            type: 'noul',
            instructions:
              'Does `proposed_code` silently swallow an error or exception (e.g., an empty `catch {}` block, `_ = err` on a critical mutation, or logging an error inside an `if err != nil` block and falling through without returning)?',
            criteria: {
              true: 'Catches or checks an error and silently ignores it or falls through to downstream mutations without returning/throwing',
              false:
                'Properly returns, wraps, or throws errors, or no error handling is present in the snippet',
            },
          },
          uses_raw_errors_new_in_go: {
            type: 'noul',
            instructions:
              'In Go code, does `proposed_code` construct domain or wrapped errors using raw `errors.New(...)` or `fmt.Errorf(...)` when the repository uses structured `xerrors` (`xerrors.New` / `xerrors.Wrapf`)?',
            criteria: {
              true: 'Go code calls raw `errors.New(...)` for a domain/sentinel error',
              false:
                'Not Go code, uses `xerrors`, or does not call `errors.New`',
            },
          },
        },
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
    if (isSafeCommand(cmd)) {
      return { decision: 'allow' };
    }

    try {
      const res = await evaluateSystemOne({
        state: {
          command_line: cmd.slice(0, 2000),
          cwd: args?.Cwd || '',
        },
        questions: {
          is_destructive_delete_or_drop: {
            type: 'noul',
            instructions:
              'Does `command_line` recursively delete project/system directories (`rm -rf`), drop database tables, or destroy cloud infrastructure?',
            criteria: {
              true: 'Executes recursive deletion (`rm -rf`), database table/schema drop, or infrastructure destruction',
              false:
                'Normal build, test, git, or file inspection command without destructive deletion',
            },
          },
          is_remote_force_push: {
            type: 'noul',
            instructions:
              'Does `command_line` push to a git remote with `--force`, `-f`, or `--force-with-lease`?',
            criteria: {
              true: 'Runs `git push` with `--force`, `-f`, or `--force-with-lease`',
              false: 'Not a git force-push command',
            },
          },
          swallows_test_or_lint_failure: {
            type: 'noul',
            instructions:
              'Does `command_line` run a test suite, build, or linter and suppress its failure exit code using `|| true`?',
            criteria: {
              true: 'Runs a test, build, or linter command and appends `|| true` to mask non-zero exit codes',
              false:
                'Does not suppress test/build/linter exit codes (or uses `|| true` only on a benign search like `grep`)',
            },
          },
          uses_sudo_instead_of_pkexec: {
            type: 'noul',
            instructions:
              'Does `command_line` invoke `sudo` to run a privileged command on Linux instead of a polkit/systemd privilege escalation tool such as `pkexec` or `run0`?',
            criteria: {
              true: 'Invokes `sudo <command>` for root privileges',
              false:
                'Does not invoke `sudo` (e.g. invokes `pkexec`, `run0`, or unprivileged commands)',
            },
          },
        },
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
        const sanitizedCmd = cmd.replace(/\s*\|\|\s*true\s*$/, '').trim();
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
  const stepKey =
    mode === 'PreInvocation'
      ? `inv:${payload?.invocationNum ?? ''}:${payload?.initialNumSteps ?? ''}`
      : `step:${payload?.stepIdx ?? ''}:${payload?.toolCall?.name ?? ''}`;
  if (!convId || stepKey.endsWith('::')) {
    return false;
  }
  const dedupPath = `/tmp/jev-hook-last-step-${convId}.json`;
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
