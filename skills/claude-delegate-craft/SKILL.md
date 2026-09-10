---
name: claude-delegate-craft
description: How to shape a request into a self-contained Claude Code task brief before forwarding it through the bridge
user-invocable: false
---

# Claude Delegate Craft

Use this skill inside `claude-code:claude-delegate` to tighten a raw request into the task text handed to the bridge — and for nothing else. It shapes text; it never inspects the repo or solves the task.

## The brief is all the context Claude gets

The child Claude starts with no conversation memory. It does see the working tree and the project's `CLAUDE.md` / `AGENTS.md`, so project conventions do not need restating — but everything else from the current thread does:

- Name the exact files, symbols, or commands involved (absolute or repo-relative paths), not "the failing test".
- State the goal and the completion signal: what command should pass, what output you need back.
- One task per delegation. Split "diagnose then fix then verify" chains; the first run diagnoses, the follow-up (via `--resume-last`) fixes.

## Shape the deliverable you want back

Claude returns its final message verbatim to the main thread, so ask for a report structure that survives the trip:

- For diagnosis: findings ordered by likelihood, each with file:line evidence and a proposed fix sketch; open questions last.
- For implementation: summary of changes, list of touched files, test commands run and their results.
- For research: conclusions first, then sources.
- Say explicitly when you want no edits made even in write-capable mode ("report only — do not edit files"), though `--read-only` is the safer tool for that.

## Continuation briefs

When following up with `--resume-last` / `--resume`, the prior context carries over — the brief only needs the delta: what to do next, what changed since, new constraints. Do not re-paste the original task.

## Boundaries

- Declare blast radius: which paths may be touched, which must not ("only src/plugins/*, do not touch pnpm-lock.yaml").
- For wide or risky edits, prefer `--worktree` so changes land in an isolated `cc-<jobid>` worktree the main thread can inspect and merge deliberately.
- Budget-sensitive or long tasks: say so in the brief and let the main thread pass `--budget`.

## Model routing

The backend model behind the CLI is whatever `~/.claude/settings.json` (or the account in use) maps it to — it may be a proxy routing to non-Anthropic models. Task text should not rely on Claude-specific manners; plain, concrete, imperative briefs work across models. Pass `--model` only on explicit user request.
