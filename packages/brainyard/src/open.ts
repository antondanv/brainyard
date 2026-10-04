/**
 * Opening a CLI for a person: in this terminal, where it takes the keyboard
 * and the screen until it exits, or — Claude Code only — in the background.
 *
 * The session that comes out is the CLI's own, so it is the one
 * `claude --resume`, `codex resume`, `agy --conversation` and
 * `opencode --session` show later. That
 * is the difference from `run()`: a headless run is resumable by id, but
 * Claude Code keeps it out of its picker.
 *
 * - Claude Code gets the session id up front (`--session-id`) and a name
 *   (`--name`) that its picker, agent view and terminal title show.
 *   Background sessions manage their own id: Brainyard reads the short id
 *   from the output and asks `claude agents` for the full one.
 * - Codex, Antigravity and OpenCode take neither: after the CLI exits, the
 *   session is found in its store by folder and start time.
 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { BRAINS } from './brains/info.js';
import { BrainyardError } from './errors.js';
import { cliFlags } from './flags.js';
import { commandFor, resolveBrain } from './options.js';
import { type Command, capture, describeCommand, spawnInteractive, withoutSessionVars } from './process.js';
import { liveSessions, type SessionInfo, type SessionsOptions, sessions } from './sessions.js';
import type { BrainId, RunError } from './types.js';

export interface OpenOptions {
  brain: BrainId | string;
  /** The folder the CLI works in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The first message. Without one the CLI opens and waits for you. */
  prompt?: string;
  /**
   * Standing instructions for the session. Claude Code appends them to its
   * system prompt, where they stay out of the conversation and survive
   * resumes; Codex, Antigravity and OpenCode have no such slot, so they get
   * them in front of the first message.
   */
  system?: string;
  /** Continue this session instead of starting one. */
  resume?: string;
  /** Claude Code: the session's name in `/resume`, agent view and the terminal title. */
  name?: string;
  /** Claude Code: the id for a new session (a UUID). Generated when not given. */
  sessionId?: string;
  model?: string;
  effort?: string;
  /**
   * Claude Code: `default`, `plan`, `acceptEdits`, `auto`…
   * Antigravity: `plan`, `accept-edits` (`acceptEdits` is translated) or
   * `bypassPermissions` — every tool approved (`--dangerously-skip-permissions`).
   * OpenCode: `plan` (its plan agent), `acceptEdits` (its default) or
   * `bypassPermissions` — every question approved (`--auto`).
   */
  permissionMode?: string;
  /** Claude Code: work in a new git worktree; a string names it. */
  worktree?: boolean | string;
  /** Claude Code: start in the background and return at once (`--bg`). */
  background?: boolean;
  env?: Record<string, string>;
  /** Raw arguments added before the prompt. */
  extraArgs?: string[];
  /** Executable to run instead of the default, as in `run()`. */
  command?: string | string[];
  /** Where to look for the session afterwards, as in `sessions()` (tests, another account). */
  homes?: SessionsOptions['homes'];
}

/** The command `open()` would run. */
export interface OpenPlan {
  brain: BrainId;
  command: Command;
  args: string[];
  cwd: string;
  /** Known before the start (Claude Code, or the session being resumed). */
  sessionId?: string;
  background: boolean;
  /** Options this CLI cannot honour; nothing is dropped silently. */
  warnings: string[];
  /** The command line, for logs. */
  display: string;
}

export interface OpenResult {
  brain: BrainId;
  /** The CLI exited cleanly (interactive) or the background session started. */
  ok: boolean;
  exitCode: number | null;
  /** The session to come back to. Undefined only when the store had no trace of it. */
  sessionId?: string;
  /** Claude Code background sessions: what `claude attach` takes. */
  shortId?: string;
  background: boolean;
  /** ISO. */
  startedAt: string;
  /** ISO. */
  endedAt: string;
  warnings: string[];
  /** What a background launch printed (Claude Code tells you how to attach). */
  output?: string;
  error?: RunError;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds the command line without running anything. */
export async function planOpen(options: OpenOptions): Promise<OpenPlan> {
  const brain = resolveBrain(options.brain);
  const invalid = (message: string) => new BrainyardError('invalid_option', message, { brain });
  const cwd = resolve(options.cwd ?? process.cwd());
  try {
    if (!statSync(cwd).isDirectory()) throw invalid(`not a folder: ${cwd}`);
  } catch (error) {
    if (error instanceof BrainyardError) throw error;
    throw invalid(`no such folder: ${cwd}`);
  }
  const command = commandFor(brain, options.command);
  const flags = await cliFlags(brain, command);
  const warnings: string[] = [];
  const prompt = options.prompt?.trim() ? options.prompt : undefined;
  const system = options.system?.trim() ? options.system : undefined;
  const resume = options.resume?.trim() || undefined;
  if (options.background && brain !== 'claude') {
    throw invalid(`${BRAINS[brain].label} has no background sessions; only Claude Code does`);
  }

  let args: string[];
  let sessionId: string | undefined = resume;
  if (brain === 'claude') {
    args = [];
    if (options.background && !flags.has('--bg')) {
      throw invalid('this Claude Code has no background sessions (`--bg`); update it with `claude update`');
    }
    if (resume) args.push('--resume', resume);
    else if (!options.background) {
      // `--bg` manages the id itself and ignores this flag with a warning.
      const id = options.sessionId ?? randomUUID();
      if (!UUID.test(id)) throw invalid(`a session id must be a UUID: ${id}`);
      if (flags.has('--session-id')) {
        args.push('--session-id', id);
        sessionId = id;
      } else {
        warnings.push('this Claude Code cannot be given a session id; it is looked up after the session ends');
      }
    }
    if (options.name?.trim()) {
      if (flags.has('--name')) args.push('--name', options.name.trim());
      else warnings.push('this Claude Code cannot name sessions; update it with `claude update`');
    }
    let first = prompt;
    if (system) {
      if (resume) {
        // A resumed conversation keeps the system prompt it was recorded with.
        warnings.push('instructions are not changed on resume: the session keeps the ones it started with');
      } else if (flags.has('--append-system-prompt')) args.push('--append-system-prompt', system);
      else first = joinText(system, prompt);
    }
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--effort', options.effort);
    if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
    if (options.worktree) {
      args.push('--worktree');
      if (typeof options.worktree === 'string' && options.worktree.trim()) args.push(options.worktree.trim());
    }
    if (options.background) args.push('--bg');
    args.push(...(options.extraArgs ?? []));
    // After `--` a prompt that starts with a dash is still a prompt.
    if (first) args.push('--', first);
  } else if (brain === 'codex') {
    args = resume ? ['resume', resume] : [];
    if (options.name?.trim())
      warnings.push('Codex does not take session names: it titles the session after the first message');
    if (options.model) args.push('-m', options.model);
    if (options.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`);
    if (options.permissionMode)
      warnings.push('Codex has no permission modes; use extraArgs for `--sandbox`/`--ask-for-approval`');
    if (options.worktree) warnings.push('Codex does not create worktrees from the command line');
    args.push(...(options.extraArgs ?? []));
    const first = joinText(system, prompt);
    if (first) args.push('--', first);
  } else if (brain === 'antigravity') {
    args = [];
    if (resume) args.push('--conversation', resume);
    if (options.name?.trim()) warnings.push('Antigravity does not take session names');
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--effort', options.effort);
    if (options.permissionMode) {
      const mode = options.permissionMode === 'acceptEdits' ? 'accept-edits' : options.permissionMode;
      if (mode === 'plan' || mode === 'accept-edits') args.push('--mode', mode);
      else if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
      else
        warnings.push(
          `Antigravity has no "${options.permissionMode}" mode, only plan, accept-edits and bypassPermissions`,
        );
    }
    if (options.worktree) warnings.push('Antigravity does not create worktrees');
    args.push(...(options.extraArgs ?? []));
    // `=` binds the value to the flag, dash or not.
    const first = joinText(system, prompt);
    if (first) args.push(`--prompt-interactive=${first}`);
  } else {
    args = [];
    if (resume) args.push('--session', resume);
    if (options.name?.trim()) {
      warnings.push('OpenCode does not take session names: it titles the session after the first message');
    }
    if (options.model) args.push('--model', options.model);
    if (options.effort)
      warnings.push('OpenCode picks the reasoning variant inside the session (ctrl+t), not on its command line');
    const mode = options.permissionMode;
    if (mode === 'plan') args.push('--agent', 'plan');
    else if (mode === 'bypassPermissions') {
      if (flags.has('--auto')) args.push('--auto');
      else
        warnings.push(
          'this OpenCode cannot approve everything up front (no --auto); update it with `opencode upgrade`',
        );
    } else if (mode && mode !== 'acceptEdits' && mode !== 'default') {
      warnings.push(`OpenCode has no "${mode}" mode, only plan, acceptEdits (its default) and bypassPermissions`);
    }
    if (options.worktree) warnings.push('OpenCode does not create worktrees from the command line');
    args.push(...(options.extraArgs ?? []));
    // `=` binds the value to the flag, dash or not; the TUI sends it at once.
    const first = joinText(system, prompt);
    if (first) args.push(`--prompt=${first}`);
  }

  const plan: OpenPlan = {
    brain,
    command,
    args,
    cwd,
    background: Boolean(options.background),
    warnings,
    display: describeCommand(
      command,
      args.map((arg) => (arg.length > 80 ? `${arg.slice(0, 77)}…` : arg)),
    ),
  };
  if (sessionId) plan.sessionId = sessionId;
  return plan;
}

/**
 * Opens the CLI and resolves when it is done: when the person exits it, or,
 * for a background session, as soon as it started.
 */
export async function open(options: OpenOptions): Promise<OpenResult> {
  const plan = await planOpen(options);
  // A session opened from inside another must not pass for its child (see SESSION_VARS).
  const env = { ...withoutSessionVars(process.env), ...options.env };
  const startedAt = new Date();
  return plan.background ? openBackground(plan, env, startedAt) : openHere(plan, options, env, startedAt);
}

async function openBackground(plan: OpenPlan, env: NodeJS.ProcessEnv, startedAt: Date): Promise<OpenResult> {
  const got = await capture(plan.command, plan.args, { cwd: plan.cwd, env, timeoutMs: 120_000 });
  const output = `${got.stdout}${got.stderr}`.trim();
  const result: OpenResult = {
    brain: plan.brain,
    ok: false,
    exitCode: got.code,
    background: true,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    warnings: [...plan.warnings],
    output,
  };
  // "backgrounded · 86453cbc · name"
  const short = /backgrounded\W+([0-9a-f]{6,})/i.exec(output)?.[1];
  if (!short) {
    // Exit code 0 is no proof: an untrusted folder prints why and exits 0.
    const why =
      output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('warning:')) ?? 'the background session did not start';
    result.error = {
      kind: got.error ? 'not_installed' : 'failed',
      message: why,
      retryable: false,
    };
    return result;
  }
  result.ok = true;
  result.shortId = short;
  if (plan.sessionId) result.sessionId = plan.sessionId;
  else {
    // The full id is the short one plus the rest of a UUID: agent view knows it.
    for (let attempt = 0; attempt < 5 && !result.sessionId; attempt++) {
      const live = await liveSessions({ all: true, command: [plan.command.file, ...plan.command.args], env });
      const match = live.find((session) => session.live?.shortId === short || session.id.startsWith(short));
      if (match) result.sessionId = match.id;
      else await new Promise((done) => setTimeout(done, 300));
    }
    if (!result.sessionId) result.warnings.push(`started as ${short}, but agent view did not list it yet`);
  }
  result.endedAt = new Date().toISOString();
  return result;
}

async function openHere(
  plan: OpenPlan,
  options: OpenOptions,
  env: NodeJS.ProcessEnv,
  startedAt: Date,
): Promise<OpenResult> {
  if (process.stdin.isTTY) {
    // Flush a fresh pause before the child changes shared terminal descriptor flags.
    process.stdin.resume();
    process.stdin.pause();
    await new Promise<void>((done) => setImmediate(done));
  }
  const child = spawnInteractive(plan.command, plan.args, { cwd: plan.cwd, env });
  // Ctrl+C in the terminal reaches every process in the foreground group, us
  // included. It is meant for the CLI, which handles it; we wait.
  const ignore = () => undefined;
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGQUIT'];
  for (const signal of signals) process.on(signal, ignore);
  let spawnError: Error | undefined;
  const exitCode = await new Promise<number | null>((done) => {
    child.once('error', (error) => {
      spawnError = error;
      done(null);
    });
    child.once('exit', (code, signal) => done(code ?? (signal ? 128 : null)));
  });
  for (const signal of signals) process.off(signal, ignore);

  const result: OpenResult = {
    brain: plan.brain,
    ok: exitCode === 0,
    exitCode,
    background: false,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    warnings: [...plan.warnings],
  };
  if (spawnError) {
    result.error = { kind: 'not_installed', message: spawnError.message, retryable: false };
    return result;
  }
  if (plan.sessionId) result.sessionId = plan.sessionId;
  else {
    const found = await findStarted(plan.brain, plan.cwd, startedAt, options);
    if (found) result.sessionId = found.id;
    else result.warnings.push(`no new ${BRAINS[plan.brain].label} session found for this folder`);
  }
  return result;
}

/** The session a CLI started in this folder since `since`, read from its store. */
export async function findStarted(
  brain: BrainId,
  cwd: string,
  since: Date,
  options: Pick<OpenOptions, 'env' | 'homes'> = {},
): Promise<SessionInfo | undefined> {
  // Clocks of the CLI and ours agree, but a store may round to the second.
  const from = since.getTime() - 2_000;
  const list = await sessions({
    cwd,
    brains: [brain],
    headless: true,
    live: false,
    env: { ...process.env, ...options.env },
    ...(options.homes ? { homes: options.homes } : {}),
  });
  const fresh = list.filter((session) => Date.parse(session.startedAt ?? session.updatedAt ?? '') >= from);
  fresh.sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));
  return fresh[0];
}

function joinText(system: string | undefined, prompt: string | undefined): string | undefined {
  if (system && prompt) return `${system}\n\n${prompt}`;
  return system ?? prompt;
}
