# Jev System One Co-Processor Plugin (`jev-coprocessor`)

Integrates TypeSafe's **Jev** (`jev-latest`, System One model) into Antigravity as an **Upfront Executive Decision Engine (`PreInvocation`)** and **Real-Time Code & Command Guardrail (`PreToolUse`)**.

## Architecture (100% Repository-Agnostic)

1. **`PreInvocation` — Executive Decision Engine (~215ms warm / <2ms cached)**:
   - Evaluates the incoming user prompt (merging queued/continuation follow-up fragments), $O(1)$ tail-read `transcript.jsonl` context across parallel tool turns, and subagent initial messages in a single batched `POST https://api.typesafe.ai/v1/systemone` request using `Choice` and `Noul` primitives.
   - Concurrently runs `git status --porcelain` and identifier-prioritized `rg` searches across 21+ source languages, filtering generated files (`*.pb.go`, `*.bob.go`, `*.sql.go`, `*_gen.go`, `*.gen.ts`, `*.g.dart`) while conditionally including test files when test/assertion terms appear in the prompt.
   - Extracts and ranks top symbols by full-body keyword relevance (`[hits: L<line>]`) with exact `L<start>-L<end>` line ranges and matching code snippets (`match_preview`).
   - Prevents Turn-2+ amnesia and unbatched serial search loops with zero-API-cost Turn-2 reminders and rate-limited **Convergence Guards**.
   - Persists a **Question-First Read-Only Lock** (`/tmp/jev-session-<conversationId>.json`) when `execution_mode === "codebase_audit_or_answer"` and `is_investigatory_question_only >= 0.88`.

2. **`PreToolUse` — Synchronous Code, Read, & Command Guardrail (<1ms local pre-screen / ~215ms warm Jev)**:
   - **Auto-Slicing & Generated/Lockfile Capping (`read_file`, `view_file`)**: Caps unbounded or wide reads of lockfiles/generated code to `L1-L120` and auto-slices first-time wide/unbounded reads of large (`>450` line) Jev-ranked files across both `Path` and Antigravity IDE `AbsolutePath`.
   - **Question-First Lock Enforcement**: Blocks unrequested file edits (`decision: "deny"`) during investigatory/explanatory question turns.
   - **Precision-Screened Code Edit Gate (`edit_file`, `write_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`)**: Pre-screens diffs locally in `<1ms` (ignoring URLs inside strings, standard doc headers, and `errors.New` in unit tests) and blocks violations before disk write.
   - **Shell Command Gate & Zero-Turn Auto-Sanitization (`run_command`)**:
     - Fast-allows commands with zero risk tokens in `<1ms`.
     - Escalates destructive deletes and remote force-pushes to `decision: "force_ask"`.
     - Auto-sanitizes trailing `|| true` on test/build/linter commands and rewrites `sudo <cmd>` to `pkexec <cmd>` (or `run0 <cmd>` when `NoNewPrivs=1` is detected) via `overwrite: { CommandLine }`.

3. **Keep-Alive Local Co-Processor Daemon & 5m LRU/Atomic Cache (`jev-daemon.mjs`)**:
   - Maintains a pre-warmed HTTPS Keep-Alive pool over Unix socket / Windows Named Pipe (**~215ms warm vs ~470ms cold**), in-flight SHA-256 request coalescing, 24h `/tmp` garbage collection, 5 MB telemetry log rotation, and a 5-minute in-memory + atomic disk response cache (`<1ms` hits).

4. **Context-Mode Extensions (`PreToolUse`, `PostToolUse`, & `jev-mcp.mjs`)**:
   - Jev-smart symbol slicing on unranked large files and noisy `run_command` log offloading (`/tmp/jev-logs/`).
   - Local SQLite FTS5 MCP server (`jev_exec`, `jev_index`, `jev_search` with Jev reranking, `jev_list_sources`, `jev_clear`).
   - Persistent per-conversation `PostToolUse` session memory filtered by Jev on `PreInvocation`.

## Setup

1. Export `TYPESAFE_API_KEY` or pass `--api-key` to the installer:
   ```sh
   ./install.sh --api-key "your_typesafe_api_key_here"
   ```
   On Windows PowerShell:
   ```powershell
   .\install.ps1 -ApiKey "your_typesafe_api_key_here"
   ```
   *(Optional overrides: `TYPESAFE_MODEL=jev-latest`, `TYPESAFE_API_URL=https://api.typesafe.ai/v1/systemone`)*
2. Verify installation and warm daemon health with `./install.sh --check` (or `.\install.ps1 -Check` on Windows).

## Empirical 4-Way Benchmark Results (Task 1 Audit + Task 2 Go Coding)

| Combined Metric | Pure Gemini 4 Argon | Passive Jev + Flash | **Jev Executive + Flash** | **Jev Executive + Gemini 4 Argon** |
| :--- | :--- | :--- | :--- | :--- |
| **Task 1 Audit Time / Turns** | 132.0s / 10 turns | 162.0s / 28 turns | 66.0s / 3 turns | **45.0s / 3 turns (2.9x faster)** |
| **Task 1 Prompt Tokens** | 387,527 | 1,290,231 | 87,443 | **79,502 (-79.5%)** |
| **Task 2 Coding Time / Turns** | 61.0s / 4 turns | 196.0s / 24 turns | 64.0s / 6 turns | **56.0s / 4 turns (1-shot pass)** |
| **Task 2 Prompt Tokens** | 104,299 | 892,115 | 176,783 | **105,526 (-40.3% vs Flash)** |
| **Total Wall-Clock Time** | 193.0s | 358.0s | 130.0s (-32.6%) | **101.0s (-47.7% / 1.91x faster)** |
| **Total Planner Turns** | 14 turns | 52 turns | 9 turns (-35.7%) | **7 turns (-50.0% fewer turns)** |
| **Total Prompt Tokens** | 491,826 | 2,182,346 | 264,226 (-46.3%) | **185,028 (-62.4% fewer tokens)** |
| **`golang-dev` Compliance** | Violated (`errors.New`) | Failed | **100% Compliant** | **100% Compliant + `ctx.Err()` + GoDocs** |
| **Relative Compute Cost** | `1.00x` | `~0.85x` | **`~0.10x – 0.14x` (Cheapest)** | **`~0.37x` (-63% cost vs Pure Gemini 4)** |
