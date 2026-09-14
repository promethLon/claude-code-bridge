#!/usr/bin/env node
// claude-companion — thin bridge from any coding-agent harness to the Claude Code CLI.
//
// Design contract (see ../README.md): Claude Code already owns sessions,
// background work, permissions, budgets and structured output. This script
// only adds what the CLI lacks: per-workspace bookkeeping (which session to
// resume, which background job wrote which file) and stable JSON rendering.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const STATE_VERSION = 1;
const MAX_RECORDS = 50;
const DEFAULT_FALLBACK_DATA_DIR = path.join(os.homedir(), ".claude-code-bridge");

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const command = argv[0];
  const flags = {};
  const positional = [];
  const valueFlags = new Set(["model", "resume", "budget", "cwd", "effort"]);
  const listFlags = new Set(["allow", "deny"]);

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (listFlags.has(name)) {
      (flags[name] ??= []).push(argv[++i]);
    } else if (valueFlags.has(name)) {
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }
  return { command, flags, positional };
}

function printUsage() {
  console.log(`Usage:
  claude-companion.mjs task [options] [prompt]    delegate a task to Claude Code
    --background            run detached; prints job id for status/result/stop
    --read-only             plan permission mode (default: acceptEdits, write-capable)
    --allow <toolspec>      pre-authorize a tool rule for the child (repeatable)
    --deny <toolspec>       forbid a tool rule for the child (repeatable)
    --yolo                  bypass all permission checks (dangerous; prefer --worktree)
    --worktree              run in a fresh git worktree (sandboxed writes)
    --model <id>            override model (e.g. deepseek-flash, glm-5.3)
    --effort <level>        thinking effort: low|medium|high|xhigh|max (default: high)
    --resume <session-id>   continue that Claude session
    --resume-last           continue the newest session recorded in this workspace
    --fresh                 force a new session (default)
    --budget <usd>          cap API spend with --max-budget-usd
    --cwd <dir>             working directory for the child (default: cwd)
    --json                  machine-readable output
    prompt may also arrive on stdin when piped
  claude-companion.mjs status [--json]            jobs + sessions for this workspace
  claude-companion.mjs result <job-id> [--json]   fetch/refresh a background job result
  claude-companion.mjs stop <job-id>              terminate a background job
  claude-companion.mjs sessions [--json]          resumable Claude sessions recorded here`);
}

// ---------------------------------------------------------------------------
// per-workspace state
// ---------------------------------------------------------------------------

function resolveStateDir(cwd) {
  let workspaceRoot = cwd;
  for (let dir = cwd, last = null; ; dir = path.dirname(dir), last = dir) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      workspaceRoot = dir;
      break;
    }
    if (dir === last || dir === path.dirname(dir)) break;
  }
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    /* keep unresolved */
  }
  const slug =
    path.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dataRoot = process.env.CLAUDE_PLUGIN_DATA || DEFAULT_FALLBACK_DATA_DIR;
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

function loadState(cwd) {
  const file = path.join(resolveStateDir(cwd), "state.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: STATE_VERSION,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    return { version: STATE_VERSION, sessions: [], jobs: [] };
  }
}

function saveState(cwd, state) {
  const dir = resolveStateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const trimmed = {
    version: STATE_VERSION,
    sessions: state.sessions.slice(0, MAX_RECORDS),
    jobs: state.jobs.slice(0, MAX_RECORDS),
  };
  fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(trimmed, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// claude CLI plumbing
// ---------------------------------------------------------------------------

function claudeBinary() {
  const which = spawnSync("/usr/bin/which", ["claude"], { encoding: "utf8" });
  const resolved = which.status === 0 ? which.stdout.trim() : "";
  if (!resolved) {
    fail("claude CLI not found on PATH. Install it or check your shell profile.", 3);
  }
  return resolved;
}

function buildClaudeArgs({ prompt, resumeId, model, mode, budget, worktree, jobId, effort, allow, deny, yolo }) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (resumeId) args.push("--resume", resumeId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (mode) args.push("--permission-mode", mode);
  for (const spec of allow ?? []) args.push("--allowedTools", spec);
  for (const spec of deny ?? []) args.push("--disallowedTools", spec);
  if (yolo) args.push("--dangerously-skip-permissions");
  if (budget) args.push("--max-budget-usd", String(budget));
  if (worktree) args.push("--worktree", `cc-${jobId}`);
  return args;
}

// claude --output-format json prints exactly one result object, but stderr
// noise and streaming lines can share the pipe when callers merge streams.
// We keep stdout pure and parse the last line that starts with '{'.
function parseResultJson(stdout) {
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* try the previous candidate */
    }
  }
  return null;
}

function summarizeResult(parsed) {
  return {
    session_id: parsed.session_id ?? null,
    ok: parsed.is_error !== true,
    error: parsed.is_error === true ? (parsed.result ?? "unknown error") : null,
    api_error_status: parsed.api_error_status ?? null,
    result: parsed.result ?? null,
    turns: parsed.num_turns ?? null,
    cost_usd: parsed.total_cost_usd ?? null,
    duration_ms: parsed.duration_ms ?? null,
    model: parsed.model ?? Object.keys(parsed.modelUsage ?? {})[0] ?? null,
  };
}

function recordSession(cwd, summary, meta) {
  const state = loadState(cwd);
  if (!summary.session_id) return;
  state.sessions.unshift({
    session_id: summary.session_id,
    at: new Date().toISOString(),
    model: summary.model ?? meta.model ?? null,
    mode: meta.mode,
    resume_of: meta.resumeOf ?? null,
    background: meta.background === true,
    cost_usd: summary.cost_usd,
    turns: summary.turns,
    prompt_head: (meta.prompt ?? "").slice(0, 160),
  });
  saveState(cwd, state);
}

function pickResumeTarget(cwd, flags) {
  if (flags.resume) return { id: flags.resume, origin: "explicit" };
  if (flags["resume-last"]) {
    const latest = loadState(cwd).sessions[0];
    if (!latest) {
      fail("No recorded Claude session in this workspace yet; run a fresh task first.", 4);
    }
    return { id: latest.session_id, origin: "resume-last" };
  }
  return { id: null, origin: "fresh" };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderTaskReport(summary, meta, jobId) {
  const lines = [];
  const status = summary.ok ? "done" : "FAILED";
  const bits = [
    `session ${(summary.session_id ?? "?").slice(0, 8)}`,
    summary.turns != null ? `${summary.turns} turns` : null,
    summary.cost_usd != null ? `$${Number(summary.cost_usd).toFixed(4)}` : null,
    summary.duration_ms != null ? `${Math.round(summary.duration_ms / 1000)}s` : null,
    summary.model,
    meta.mode,
    meta.worktree ? "worktree" : null,
    meta.yolo ? "yolo" : null,
  ].filter(Boolean);
  lines.push(`[${status}] claude-code · ${bits.join(" · ")}`);
  if (meta.background) lines.push(`job: ${jobId} (result: claude-companion.mjs result ${jobId})`);
  if (summary.error) {
    lines.push("", `error: ${summary.error}`);
    if (summary.api_error_status) lines.push(`api_status: ${summary.api_error_status}`);
  } else if (summary.result != null) {
    lines.push("", String(summary.result));
  }
  if (summary.session_id) {
    lines.push("", `continue: task --resume ${summary.session_id} "<follow-up>"`);
  }
  return `${lines.join("\n")}\n`;
}

function fail(message, code = 1) {
  process.stderr.write(`claude-companion: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function readPrompt(positional) {
  if (positional.length > 0) return positional.join(" ");
  if (!process.stdin.isTTY) {
    try {
      const piped = fs.readFileSync(0, "utf8").trim();
      if (piped) return piped;
    } catch {
      /* no stdin content */
    }
  }
  return null;
}

function cmdTask(flags, positional) {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
  const prompt = readPrompt(positional);
  if (!prompt) fail("no prompt given (argument or stdin).");
  if (flags.resume && flags["resume-last"]) fail("--resume and --resume-last are mutually exclusive.");
  if (flags["read-only"] && flags.yolo) fail("--read-only and --yolo are mutually exclusive.");
  claudeBinary();

  const resume = pickResumeTarget(cwd, flags);
  const mode = flags["read-only"] ? "plan" : "acceptEdits";
  const jobId = `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const args = buildClaudeArgs({
    prompt,
    resumeId: resume.id,
    model: flags.model,
    effort: flags.effort,
    mode,
    allow: flags.allow,
    deny: flags.deny,
    yolo: Boolean(flags.yolo),
    budget: flags.budget,
    worktree: flags.worktree,
    jobId,
  });
  const meta = {
    prompt,
    model: flags.model ?? null,
    effort: flags.effort ?? null,
    mode,
    worktree: Boolean(flags.worktree),
    yolo: Boolean(flags.yolo),
    background: Boolean(flags.background),
    resumeOf: resume.id,
  };

  if (flags.background) {
    return runBackground(cwd, args, jobId, meta, flags);
  }
  return runForeground(cwd, args, jobId, meta, flags);
}

function runForeground(cwd, args, jobId, meta, flags) {
  const started = Date.now();
  const child = spawnSync(claudeBinary(), args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (child.error) fail(`failed to start claude: ${child.error.message}`, 3);
  const parsed = parseResultJson(child.stdout);
  if (!parsed) {
    const stderrTail = (child.stderr ?? "").split("\n").filter(Boolean).slice(-5).join("\n");
    fail(`claude produced no parsable result (exit ${child.status}). stderr tail:\n${stderrTail}`, 5);
  }
  const summary = summarizeResult(parsed);
  recordSession(cwd, summary, meta);
  if (flags.json) {
    console.log(JSON.stringify({ job: jobId, ...summary }, null, 2));
  } else {
    process.stdout.write(renderTaskReport(summary, meta, jobId));
  }
  process.exitCode = summary.ok ? 0 : 6;
}

function runBackground(cwd, args, jobId, meta, flags) {
  const stateDir = resolveStateDir(cwd);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, `${jobId}.json`);

  const out = fs.openSync(logFile, "w");
  const child = spawn(claudeBinary(), args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
  });
  fs.closeSync(out);
  child.unref();

  const state = loadState(cwd);
  state.jobs.unshift({
    id: jobId,
    pid: child.pid,
    logFile,
    cwd,
    at: new Date().toISOString(),
    model: meta.model,
    effort: meta.effort,
    mode: meta.mode,
    worktree: meta.worktree,
    yolo: meta.yolo,
    resume_of: meta.resumeOf,
    prompt_head: meta.prompt.slice(0, 160),
    background: true,
  });
  saveState(cwd, state);

  const payload = {
    job: jobId,
    pid: child.pid,
    state: "running",
    logFile,
    note: `poll with: claude-companion.mjs result ${jobId}`,
  };
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(`[started] ${jobId} · pid ${child.pid} · log ${logFile}\npoll with: claude-companion.mjs result ${jobId}\n`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function findJob(cwd, jobId) {
  const job = loadState(cwd).jobs.find((j) => j.id === jobId);
  if (!job) fail(`no recorded job '${jobId}' in this workspace.`, 4);
  return job;
}

function cmdResult(flags, positional) {
  const jobId = positional[0];
  if (!jobId) fail("usage: result <job-id> [--json]");
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
  const job = findJob(cwd, jobId);

  let raw = "";
  try {
    raw = fs.readFileSync(job.logFile, "utf8");
  } catch {
    fail(`job log missing: ${job.logFile}`, 5);
  }
  const parsed = parseResultJson(raw);
  const alive = job.pid ? pidAlive(job.pid) : false;

  if (!parsed) {
    const payload = { job: job.id, state: alive ? "running" : "dead-incomplete", logFile: job.logFile };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (alive) {
      console.log(`[running] ${job.id} · pid ${job.pid} still active; try again later.`);
    } else {
      console.log(`[incomplete] ${job.id} · process exited without a final result. Inspect ${job.logFile}`);
    }
    process.exitCode = alive ? 0 : 7;
    return;
  }

  const summary = summarizeResult(parsed);
  recordSession(cwd, summary, {
    prompt: job.prompt_head,
    model: job.model,
    mode: job.mode,
    resumeOf: job.resume_of,
    background: true,
  });
  const payload = { job: job.id, pid: job.pid, state: "done", ...summary };
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else {
    process.stdout.write(
      renderTaskReport(summary, { ...job, background: true }, job.id)
    );
  }
  process.exitCode = summary.ok ? 0 : 6;
}

function cmdStop(flags, positional) {
  const jobId = positional[0];
  if (!jobId) fail("usage: stop <job-id>");
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
  const job = findJob(cwd, jobId);
  if (!job.pid || !pidAlive(job.pid)) {
    console.log(`[already-exited] ${job.id}`);
    return;
  }
  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {
    process.kill(job.pid, "SIGTERM");
  }
  const state = loadState(cwd);
  const entry = state.jobs.find((j) => j.id === jobId);
  if (entry) entry.stopped = new Date().toISOString();
  saveState(cwd, state);
  console.log(`[stopped] ${job.id} · pid ${job.pid}`);
}

function cmdStatus(flags) {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
  const state = loadState(cwd);
  const jobs = state.jobs.map((j) => ({
    job: j.id,
    pid: j.pid,
    running: j.pid ? pidAlive(j.pid) : false,
    at: j.at,
    model: j.model ?? null,
    mode: j.mode ?? null,
    worktree: Boolean(j.worktree),
    prompt_head: j.prompt_head,
    stopped: j.stopped ?? null,
  }));
  const sessions = state.sessions.map((s) => ({
    session_id: s.session_id,
    at: s.at,
    model: s.model ?? null,
    turns: s.turns ?? null,
    cost_usd: s.cost_usd ?? null,
    prompt_head: s.prompt_head,
  }));
  if (flags.json) {
    console.log(JSON.stringify({ workspace: cwd, jobs, sessions }, null, 2));
    return;
  }
  console.log(`workspace: ${cwd}`);
  console.log(`\nbackground jobs (${jobs.length}):`);
  if (jobs.length === 0) console.log("  (none)");
  for (const j of jobs) {
    const run = j.pid && pidAlive(j.pid) ? "running" : j.stopped ? "stopped" : "exited";
    console.log(`  ${j.job} · ${run} · ${j.at} · ${(j.prompt_head ?? "").slice(0, 60)}`);
  }
  console.log(`\nsessions (${sessions.length}, newest first):`);
  if (sessions.length === 0) console.log("  (none)");
  for (const s of sessions.slice(0, 10)) {
    console.log(`  ${s.session_id.slice(0, 8)} · ${s.at} · ${s.turns ?? "?"} turns · ${(s.prompt_head ?? "").slice(0, 60)}`);
  }
  if (state.sessions[0]) {
    console.log(`\nresume-last target: ${state.sessions[0].session_id}`);
  }
}

function cmdSessions(flags) {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
  const sessions = loadState(cwd).sessions;
  if (flags.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }
  if (sessions.length === 0) {
    console.log("no recorded sessions in this workspace");
    return;
  }
  sessions.forEach((s, i) => {
    const tag = i === 0 ? " (latest)" : "";
    console.log(`${i + 1}. ${s.session_id}${tag} · ${s.at} · ${s.turns ?? "?"} turns · ${(s.prompt_head ?? "").slice(0, 70)}`);
  });
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

const { command, flags, positional } = parseArgs(process.argv.slice(2));
switch (command) {
  case "task":
    cmdTask(flags, positional);
    break;
  case "status":
    cmdStatus(flags);
    break;
  case "result":
    cmdResult(flags, positional);
    break;
  case "stop":
    cmdStop(flags, positional);
    break;
  case "sessions":
    cmdSessions(flags);
    break;
  default:
    printUsage();
    process.exitCode = command ? 2 : 0;
}
