# claude-code-bridge

Delegate tasks to the [Claude Code](https://code.claude.com/) CLI from any coding-agent harness, through a deliberately thin bridge. The host agent keeps driving; Claude Code runs as a resumable, budget-capped worker beside it.

Works natively as a Claude Code plugin, and degrades gracefully to a plain CLI helper for harnesses without a plugin system (Codex CLI, Gemini CLI, anything that can run a shell command).

## Why thin

Claude Code already owns sessions, background work, permissions, budgets and structured output natively. A delegate bridge does not need its own runtime — only per-workspace bookkeeping and stable output rendering:

| Capability | Claude Code native | This bridge adds |
|---|---|---|
| Sessions | `--resume <id>` / `--fork-session`, ids returned in JSON | per-workspace bookkeeping of which id to resume |
| Background | detached `claude -p` writes clean result JSON | spawn + pid + log file (~60 lines) |
| Permissions | `--permission-mode plan/acceptEdits` | `--read-only` / default-write mapping |
| Sandbox | `--worktree` | pass-through |
| Budget | `--max-budget-usd` | `--budget` pass-through |
| Structured output | `--output-format json` | render/parse |

So the bridge is ~500 lines of glue, not a runtime.

## Install

### Claude Code (native)

```bash
claude plugin marketplace add promethLon/claude-code-bridge
claude plugin install claude-code-bridge@claude-code-bridge
```

Or interactively inside Claude Code: `/plugin marketplace add promethLon/claude-code-bridge`, then `/plugin install claude-code-bridge@claude-code-bridge`.

This registers the `claude-delegate` subagent plus two internal skills. Any other harness that implements the Claude Code plugin format can install it the same way.

### Any other harness (Codex CLI, Gemini CLI, …)

No plugin system needed — clone the repo and call the companion script directly:

```bash
git clone https://github.com/promethLon/claude-code-bridge.git
node claude-code-bridge/scripts/claude-companion.mjs task "Diagnose why tests/e2e/login.spec.ts flakes on CI"
```

If your harness supports the [Agent Skills](https://code.claude.com/docs/en/skills) convention (markdown `skills/*/SKILL.md`), you can also point it at this repo's `skills/` directory. Replace `${CLAUDE_PLUGIN_ROOT}` in the skill text with the path of your clone — that variable is only set inside Claude-Code-format plugin hosts.

## Usage

```
claude-companion.mjs task [options] [prompt]    delegate a task to Claude Code
  --background          run detached; prints job id for status/result/stop
  --read-only           plan permission mode (default: acceptEdits, write-capable)
  --worktree            run in a fresh git worktree (sandboxed writes)
  --model <id>          override model (passed verbatim to the CLI)
  --effort <level>      thinking effort: low|medium|high|xhigh|max (default: high)
  --resume <session-id> continue that Claude session
  --resume-last         continue the newest session recorded in this workspace
  --budget <usd>        cap API spend with --max-budget-usd
  --cwd <dir>           working directory for the child (default: cwd)
  --json                machine-readable output
  prompt may also arrive on stdin when piped
claude-companion.mjs status [--json]            jobs + sessions for this workspace
claude-companion.mjs result <job-id> [--json]   fetch/refresh a background job result
claude-companion.mjs stop <job-id>              terminate a background job
claude-companion.mjs sessions [--json]          resumable Claude sessions recorded here
```

Every successful run prints a `continue:` line with the exact command to resume that Claude session. Follow-ups ("apply the top fix", "dig deeper") should use `--resume-last`.

## Layout

- `agents/claude-delegate.md` — forwarding subagent (one Bash call, stdout verbatim)
- `skills/claude-cli-runtime/` — internal contract for the bridge commands
- `skills/claude-delegate-craft/` — how to write the task brief handed to Claude
- `scripts/claude-companion.mjs` — the bridge itself

## Defaults

- Write-capable by default (`acceptEdits`); `--read-only` opts into plan mode. This channel is an execution channel, not a review gate — the calling agent decides what to do with the results.
- Model comes from the CLI's own configuration (`~/.claude/settings.json` routing or the signed-in account); `--model` overrides per task, passed through verbatim.
- State lives under `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<hash>/` when set by the host (git-root keyed, capped at 50 records), falling back to `~/.claude-code-bridge/`.

## Environment facts learned the hard way

- When the CLI is backed by a third-party proxy, unknown model ids can surface as a 401 "Failed to authenticate" — check the model mapping in `~/.claude/settings.json` first when tasks fail with `api_error_status: 401`.
- `claude --bg` is for backgrounding *interactive* sessions; its `logs` output is TUI-rendered frames, not parseable text. That is why the bridge runs detached `claude -p` with file redirection instead.
- `settings.json` `env` overrides process environment; use `--settings '{"env":{...}}'` (or fix the file) when testing model routing.

## License

[MIT](LICENSE)
