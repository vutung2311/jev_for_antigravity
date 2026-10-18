# Jev System One Co-Processor Plugin (`jev-coprocessor`)

Integrates TypeSafe's **Jev** (`jev-latest`, System One model) into Antigravity as an **Upfront Executive Decision Engine (`PreInvocation`)** and **Real-Time Code & Command Guardrail (`PreToolUse`)**.

## Architecture (100% Repository-Agnostic)

1. **`PreInvocation` — Executive Decision Engine (~370ms cold / <5ms cached)**:
   - Evaluates the incoming user prompt (and subagent initial message) in a single batched `POST https://api.typesafe.ai/v1/systemone` request using `Choice` and `Noul` primitives with explicit `criteria` contrasts.
   - Dynamically discovers candidate files in **any** repository by combining `git status --porcelain` (dirty/modified/untracked files) with path hints and keyword `rg` searches across 21+ source languages.
   - Extracts and ranks top symbols by keyword relevance with exact `L<start>-L<end>` line ranges so the planner can call `view_file` with `StartLine`/`EndLine` slices in a single parallel Turn 1 batch.
   - Dynamically walks up from matched files to discover applicable workspace rule files (`.agents/AGENTS.md`, `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `.cursorrules`).
   - Persists a **Question-First Read-Only Lock** (`/tmp/jev-session-<conversationId>.json`) when `execution_mode === "codebase_audit_or_answer"` and `is_investigatory_question_only >= 0.88`.

2. **`PreToolUse` — Synchronous Code & Command Guardrail (~370ms cold / <5ms cached)**:
   - **Question-First Lock Enforcement**: Blocks unrequested file edits (`decision: "deny"`) during investigatory/explanatory question turns until the user asks to apply changes.
   - **Code Edit Gate (`write_to_file`, `replace_file_content`, `multi_replace_file_content`)**: Scores proposed diffs against 6 universal quality invariants (`has_narrative_comments`, `has_apology_or_hack_comments`, `has_else_after_return`, `has_err_nil_happy_path`, `swallows_error_silently`, `uses_raw_errors_new_in_go`) and blocks (`decision: "deny"`) violations before disk write.
   - **Shell Command Gate & Zero-Turn Auto-Sanitization (`run_command`)**:
     - Escalates destructive deletes (`rm -rf`, schema drops) and remote force-pushes (`git push --force`) to `decision: "force_ask"`.
     - Uses `PreToolUse` `overwrite: { CommandLine: ... }` to **auto-sanitize** trailing `|| true` on test/build/linter commands and rewrite `sudo <cmd>` to `pkexec <cmd>` in-place without burning an extra LLM retry turn.

3. **Content-Addressed 60s Response Cache (`/tmp/jev-response-cache.json`)**:
   - Hashes `{ model, state, questions }` with SHA-256 and serves identical evaluations within 60 seconds in `<5ms` with zero API cost.

## Setup

1. Export `TYPESAFE_API_KEY` in your shell environment (e.g., `~/.zshenv` or `~/.profile`):
   ```sh
   export TYPESAFE_API_KEY="your_typesafe_api_key_here"
   ```
   *(Optional overrides: `TYPESAFE_MODEL=jev-latest`, `TYPESAFE_API_URL=https://api.typesafe.ai/v1/systemone`)*
2. Run `./deploy.sh --non-system` from `local_diagnostic` to sync `hooks.json` and plugin scripts to `~/.gemini/config/`, `~/.gemini/antigravity/`, and `~/.gemini/antigravity-ide/`.

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
