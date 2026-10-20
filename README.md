# Jev System One Co-Processor for Google Antigravity (`jev_for_antigravity`)

A 100% repository-agnostic **System One Executive Decision Engine (`PreInvocation`)** and **Real-Time Code & Command Guardrail (`PreToolUse`)** plugin for Google Antigravity, Antigravity IDE, and Antigravity CLI powered by TypeSafe's **Jev** (`jev-latest`).

---

## Quick Start & Installation

### Prerequisites
- **Node.js** `>= 18`
- **ripgrep** (`rg`)
- **git**
- A TypeSafe API key (`TYPESAFE_API_KEY`)

### 1-Command Install
```bash
git clone https://github.com/vutung2311/jev_for_antigravity.git
cd jev_for_antigravity

# Install with your TypeSafe API key (persists to ~/.zshenv + systemd user env):
./install.sh --api-key "your_typesafe_api_key_here"

# Or if TYPESAFE_API_KEY is already exported in your environment:
./install.sh
```

### Verify / Uninstall
```bash
# Verify installation & live Jev API response:
./install.sh --check

# Uninstall cleanly:
./install.sh --uninstall
```

---

## Architecture

1. **`PreInvocation` — Executive Decision Engine (~370ms cold / <5ms cached)**:
   - Evaluates the incoming user prompt, recent `transcript.jsonl` conversation context, and subagent initial messages in a single batched `POST https://api.typesafe.ai/v1/systemone` request using `Choice` and `Noul` primitives (`execution_mode`, `is_self_contained_spec`, `is_investigatory_question_only`, `is_underspecified_or_ambiguous`, `verification_strategy`, and candidate file probabilities).
   - Dynamically discovers candidate files in **any** repository by combining `git status --porcelain` (dirty/modified/untracked files), recently read/edited files from `transcript.jsonl`, secondary git worktree roots, and identifier-prioritized `rg` searches across 21+ source languages.
   - Extracts and ranks top symbols by full-body keyword relevance (`[hits: L<line>]`) with exact `L<start>-L<end>` line ranges and matching code snippets (`match_preview`) so the planner can call `read_file` / `view_file` with `StartLine`/`EndLine` slices in a single parallel Turn 1 batch.
   - Prevents Turn-2+ amnesia and search loops by persisting the session plan and injecting zero-API-cost Turn-2 reminders and Turn-4+ **Convergence Guards** when the agent runs consecutive search turns.
   - Persists a **Question-First Read-Only Lock** (`/tmp/jev-session-<conversationId>.json`) when `execution_mode === "codebase_audit_or_answer"` and `is_investigatory_question_only >= 0.88`.

2. **`PreToolUse` — Synchronous Code, Read, & Command Guardrail (<1ms local pre-screen / ~370ms Jev)**:
   - **Auto-Slicing & Lockfile Capping (`read_file`, `view_file`)**: Automatically caps unbounded reads of lockfiles/generated code to `L1-L120` and auto-slices first-time unbounded reads of large (`>450` line) Jev-ranked files to their primary matched symbol range via `overwrite: { StartLine, EndLine }`.
   - **Question-First Lock Enforcement**: Blocks unrequested file edits (`decision: "deny"`) during investigatory/explanatory question turns until the user asks to apply changes.
   - **Syntactically Pre-Screened Code Edit Gate (`edit_file`, `write_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`)**: Pre-screens diffs locally in `<1ms` and queries Jev only for active syntactic triggers (`has_narrative_comments`, `has_apology_or_hack_comments`, `has_else_after_return`, `has_err_nil_happy_path`, `swallows_error_silently`, `uses_raw_errors_new_in_go`), blocking (`decision: "deny"`) violations before disk write.
   - **Shell Command Gate & Zero-Turn Auto-Sanitization (`run_command`)**:
     - Fast-allows commands with zero risk tokens in `<1ms` (eliminating ~90% of redundant API calls).
     - Escalates destructive deletes (`rm -rf`, `git reset --hard`, schema drops) and remote force-pushes (`git push --force`) to `decision: "force_ask"`.
     - Uses `PreToolUse` `overwrite: { CommandLine: ... }` to **auto-sanitize** trailing `|| true` on test/build/linter commands and dynamically rewrite `sudo <cmd>` to `pkexec <cmd>` (or `run0 <cmd>` when `NoNewPrivs=1` is detected) in-place without burning an extra LLM retry turn.

3. **Content-Addressed 60s Response Cache (`/tmp/jev-response-cache.json`)**:
   - Hashes `{ model, state, questions }` with SHA-256 and serves identical evaluations within 60 seconds in `<5ms` with zero API cost.

---

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
