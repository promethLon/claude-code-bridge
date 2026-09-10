---
name: claude-cli-runtime
description: Internal helper contract for driving the Claude Code CLI through the claude-companion bridge
user-invocable: false
---

# Claude Code Runtime

Use this skill only inside the `claude-code-bridge:claude-delegate` subagent (or when the main thread calls the bridge directly).

Primary helper:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" task [flags] "<task text>"`

The bridge wraps `claude -p --output-format json` and adds per-workspace bookkeeping (resumable session ids, background job files). It does not manage processes beyond detached spawn + pid tracking — sessions, permissions, budgets and output structure belong to the Claude Code CLI itself.

## Execution rules

- The delegate subagent is a forwarder. One `task` call, stdout returned verbatim.
- Prefer the helper over hand-rolled `claude` invocations, direct CLI strings, or manual `git` activity.
- Do not call `status`, `result`, `stop`, or `sessions` from the subagent; those belong to the main thread.
- Strip routing flags (`--background`, `--read-only`, `--worktree`, `--model`, `--budget`, `--resume`, `--resume-last`, `--fresh`) from the natural-language task text.

## Flag contract

| Flag | Meaning | Default |
|---|---|---|
| `--background` | detached run; prints job id for `result`/`stop` | foreground |
| `--read-only` | `--permission-mode plan` (read/analyze only) | `acceptEdits` (write-capable) |
| `--worktree` | fresh git worktree sandbox (`cc-<jobid>`) | off |
| `--model <id>` | model override, passed verbatim | settings.json default |
| `--effort <level>` | thinking effort: `low\|medium\|high\|xhigh\|max` | CLI default (`high`) |
| `--resume <session-id>` | continue that exact session | fresh session |
| `--resume-last` | continue newest session recorded in this workspace | fresh session |
| `--budget <usd>` | `--max-budget-usd` cap | uncapped |
| `--cwd <dir>` | working directory for the child | current dir |

- `--resume` and `--resume-last` are mutually exclusive.
- The task text may arrive as trailing arguments or on stdin; the bridge reads piped stdin automatically.

## Reading output

- Foreground success: `[done] claude-code · session <id8> · <turns> turns · $<cost> · <s>s · <model> · <mode>`, blank line, then Claude's final message, then a `continue:` line with the exact resume command.
- `--json` on any command returns one machine-readable object (`job`, `session_id`, `ok`, `result`, `turns`, `cost_usd`, ...).
- `[FAILED]` with an `api_error_status` means the backend rejected the request (auth/model/route) — report it, do not retry blind.
- Exit codes: `0` ok · `3` claude missing · `4` no session/job to resume · `5` no parsable output · `6` task ran but errored · `7` background job died incomplete.

## Session continuity

- Every successful run records its `session_id` per workspace (git-root keyed).
- Follow-ups ("continue", "apply the top fix", "dig deeper") should route `--resume-last`; explicit ids go through `--resume <id>`.
- `sessions` lists the recorded history — useful when the main thread asks which prior thread to continue.

## Environment notes

- The child Claude inherits the workspace cwd and therefore reads the project's own `CLAUDE.md` / `AGENTS.md` if present. Say so in the task brief when project rules must or must not apply.
- If the bridge reports claude missing (`exit 3`) or auth/model errors (`FAILED` with `api_error_status`), tell the user to check `claude doctor` / their `~/.claude/settings.json` model routing; do not improvise alternate auth flows.
