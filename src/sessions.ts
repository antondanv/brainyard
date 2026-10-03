/**
 * Sessions a person comes back to, read from each CLI's own store.
 *
 * Runs started by Brainyard are headless, and Claude Code keeps headless
 * sessions out of its `/resume` picker. The sessions a person works in —
 * terminal, IDE, background — live in three stores with three formats:
 *
 * - Claude Code: `~/.claude/projects/<folder>/<session-id>.jsonl`, where the
 *   folder is the working directory with every non-alphanumeric character
 *   turned into `-`. A name you gave the session is a `custom-title` entry, the
 *   generated one an `ai-title`; `entrypoint: sdk-*` marks a headless run.
 * - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`. The first line
 *   is `session_meta` with `cwd` and `source` (`exec` is headless); thread
 *   names are in `~/.codex/session_index.jsonl`.
 * - Antigravity: `~/.gemini/antigravity-cli/conversation_summaries.db`
 *   (SQLite: title, workspace, status), or `history.jsonl` — one line per
 *   prompt with `workspace` and `conversationId` — where `node:sqlite` is
 *   missing.
 *
 * None of these is a public API. Every reader skips what it does not
 * understand instead of failing, and a store that is not there is an empty
 * list, not an error.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { BRAINS } from './brains/info.js';
import { codexPaneStates, codexRolloutState } from './codex-live.js';
import { BrainyardError } from './errors.js';
import { oneLine } from './humanize.js';
import { resolveBrain } from './options.js';
import type { PaneSettings } from './panes.js';
import { capture, resolveCommand, withoutSessionVars } from './process.js';
import type { BrainId } from './types.js';
import { BRAIN_IDS } from './types.js';

/** What a session is doing right now, as its CLI tells it (see `liveSessions`). */
export interface LiveState {
  /** `busy` — working; `waiting` — needs you (`waitingFor` says why); `idle` — its turn is over. */
  status: 'busy' | 'waiting' | 'idle' | (string & {});
  waitingFor?: string;
  /** `interactive` — open in a terminal; `background` — started with `--bg`. */
  kind: 'interactive' | 'background' | (string & {});
  pid?: number;
  /** What `claude attach` takes. */
  shortId?: string;
  /** Background sessions: `working`, `done`… */
  state?: string;
}

export interface SessionInfo {
  brain: BrainId;
  /**
   * What resuming takes: Claude Code's session id, Codex's thread id,
   * Antigravity's conversation id.
   */
  id: string;
  /** The working directory the session belongs to. */
  cwd?: string;
  /** The name you gave it, the title the CLI generated, or the first prompt. */
  title?: string;
  titleSource?: 'name' | 'generated' | 'prompt';
  /** ISO time. */
  startedAt?: string;
  /** ISO time of the last write. */
  updatedAt?: string;
  /** Started by a person (terminal, IDE, background), not by a headless run. These are what the CLI's own picker lists. */
  interactive: boolean;
  /** Claude Code: started with `--bg`. */
  background?: boolean;
  /** Present while the session is running (Claude Code). */
  live?: LiveState;
}

export interface SessionsOptions {
  /** The folder whose sessions to list. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Which CLIs to look at. Defaults to all three. */
  brains?: ReadonlyArray<BrainId | string>;
  /** Include headless runs (`claude -p`, `codex exec`). Default false: they are not sessions a person returns to. */
  headless?: boolean;
  /** At most this many per CLI, newest first. Default 200. */
  limit?: number;
  /** Ask Claude Code which of its sessions are running now. Default true. */
  live?: boolean;
  /** Read these stores instead of the defaults (tests, another account). */
  homes?: Partial<Record<BrainId, string>>;
  /** Executable for `claude agents`, as in `run()`. */
  command?: string | string[];
  env?: NodeJS.ProcessEnv;
}

/** Where Claude Code keeps its data: `CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

/** Where Codex keeps its data: `CODEX_HOME` or `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/** Where the Antigravity CLI keeps its conversations. */
export function agyHome(): string {
  return join(homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Claude Code's folder name for a working directory. Names over 200
 * characters get a hash appended that is not reproduced here; those are
 * matched by prefix.
 */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Saved sessions of a folder across the CLIs, newest first. */
export async function sessions(options: SessionsOptions = {}): Promise<SessionInfo[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const places = pathVariants(cwd);
  const brains = [...new Set((options.brains ?? BRAIN_IDS).map((brain) => resolveBrain(String(brain))))];
  const limit = options.limit ?? 200;
  const env = options.env ?? process.env;
  const homes = options.homes ?? {};

  let found: SessionInfo[] = [];
  for (const brain of brains) {
    let list: SessionInfo[];
    if (brain === 'claude') list = claudeSessions(homes.claude ?? claudeHome(env), places);
    else if (brain === 'codex') list = codexSessions(homes.codex ?? codexHome(env), places);
    else list = await agySessions(homes.antigravity ?? agyHome(), places);
    if (!options.headless) list = list.filter((session) => session.interactive);
    found.push(...newestFirst(list).slice(0, limit));
  }

  if (options.live !== false) {
    const live = await liveSessions({
      cwd,
      brains,
      ...(options.command ? { command: options.command } : {}),
      env,
      ...(options.homes ? { homes: options.homes } : {}),
    });
    found = mergeLive(found, live);
  }
  return newestFirst(found);
}

export interface LiveOptions {
  /** Only sessions of this folder. */
  cwd?: string;
  /** Include background sessions that have finished (Claude Code). */
  all?: boolean;
  /** Which CLIs to ask. Defaults to all three. */
  brains?: ReadonlyArray<BrainId | string>;
  /** Read these stores instead of the defaults (tests). */
  homes?: Partial<Record<BrainId, string>>;
  /** Check current Codex approval dialogs in this Brainyard tmux server. Default: rollout evidence only. */
  panes?: PaneSettings;
  command?: string | string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Sessions running on this machine and what they are doing, in every CLI.
 * Each tells it differently:
 *
 * - Claude Code says it outright: `claude agents --json` lists interactive
 *   and background sessions with `busy`, `waiting` (and why) or `idle`.
 * - Codex writes a turn into its rollout as it goes and closes it with
 *   `task_complete`: a turn still open is work in progress; unanswered
 *   requests mean it waits for you. `panes` also checks native approval dialogs.
 * - Antigravity keeps a status per conversation in its summaries database.
 *
 * A CLI that is not installed, or a store that is not there, adds nothing.
 */
export async function liveSessions(options: LiveOptions = {}): Promise<SessionInfo[]> {
  const env = options.env ?? process.env;
  const brains = new Set((options.brains ?? BRAIN_IDS).map((brain) => resolveBrain(String(brain))));
  const places = options.cwd ? pathVariants(resolve(options.cwd)) : undefined;
  const homes = options.homes ?? {};
  const [claude, codex, agy] = await Promise.all([
    brains.has('claude') ? claudeLive(options, env) : [],
    brains.has('codex') ? codexLive(homes.codex ?? codexHome(env)) : [],
    brains.has('antigravity') ? agyLive(homes.antigravity ?? agyHome()) : [],
  ]);
  const codexStates =
    brains.has('codex') && options.panes
      ? await codexPaneStates(codex, { ...options.panes, env: { ...env, ...options.panes.env } })
      : codex;
  return [...claude, ...codexStates, ...agy].filter(
    (session) => !places || (session.cwd !== undefined && places.has(session.cwd)),
  );
}

export interface StopSessionOptions {
  brain: BrainId | string;
  /** The full session id, as returned by `sessions()` or `liveSessions()`. */
  sessionId: string;
  /** The session's folder. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Executable for Claude Code, as in `open()`. */
  command?: string | string[];
  env?: NodeJS.ProcessEnv;
}

/** Stops a Claude Code background session through its CLI, keeping its conversation resumable. */
export async function stopSession(options: StopSessionOptions): Promise<'stopped' | 'not-running'> {
  const brain = resolveBrain(options.brain);
  if (brain !== 'claude') {
    throw new BrainyardError('invalid_option', 'only Claude Code has background sessions to stop', { brain });
  }
  const env = withoutSessionVars({ ...process.env, ...options.env });
  // Refresh the full-id to short-id mapping; a remembered PID is not a session identity.
  const list = await claudeLive(options, env, true);
  const session = list.find((candidate) => candidate.id === options.sessionId);
  if (!session) return 'not-running';
  if (session.live?.kind !== 'background') {
    throw new BrainyardError('invalid_option', 'this session is open in another terminal, not in the background', {
      brain,
    });
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!session.cwd || !pathVariants(cwd).has(session.cwd)) {
    throw new BrainyardError('invalid_option', 'the background session belongs to another folder', { brain });
  }
  const shortId = session.live.shortId;
  if (!shortId || !/^[0-9a-f]{6,}$/i.test(shortId)) {
    throw new BrainyardError('failed', "Claude Code did not report the background session's short id", { brain });
  }
  const command = resolveCommand(options.command, BRAINS.claude.binary, BRAINS.claude.envVar, env)!;
  const got = await capture(command, ['stop', shortId], { cwd, env, timeoutMs: 15_000 });
  if (got.code !== 0 || got.timedOut || got.error) {
    throw new BrainyardError(
      got.error ? 'not_installed' : 'failed',
      got.timedOut
        ? 'Claude Code timed out stopping the background session'
        : got.stderr.trim() || got.stdout.trim() || got.error?.message || 'Claude Code did not stop the session',
      { brain },
    );
  }
  return 'stopped';
}

async function claudeLive(options: LiveOptions, env: NodeJS.ProcessEnv, strict = false): Promise<SessionInfo[]> {
  const failed = (kind: 'not_installed' | 'failed', message: string): SessionInfo[] => {
    if (strict) throw new BrainyardError(kind, message, { brain: 'claude' });
    return [];
  };
  const command = resolveCommand(options.command, BRAINS.claude.binary, BRAINS.claude.envVar, env);
  if (!command) return failed('not_installed', 'Claude Code is not installed');
  const args = ['agents', '--json'];
  if (options.all) args.push('--all');
  const got = await capture(command, args, { timeoutMs: 10_000, env });
  if (got.code !== 0 || got.timedOut || got.error) {
    return failed('failed', got.stderr.trim() || got.error?.message || 'Claude Code could not list live sessions');
  }
  let rows: unknown;
  try {
    rows = JSON.parse(got.stdout);
  } catch {
    return failed('failed', 'Claude Code returned invalid live-session JSON');
  }
  if (!Array.isArray(rows)) return failed('failed', 'Claude Code returned an invalid live-session list');
  const out: SessionInfo[] = [];
  for (const row of rows) {
    const session = liveRow(row);
    if (session) out.push(session);
  }
  return out;
}

/** A Codex turn with no write for this long is not running: the CLI was closed or killed mid-turn. */
const CODEX_STALE_MS = 10 * 60 * 1000;

function codexLive(home: string): SessionInfo[] {
  const now = Date.now();
  const out: SessionInfo[] = [];
  // Only today's and yesterday's folders can hold a turn that is still open.
  for (const path of rolloutFiles(join(home, 'sessions')).slice(0, 400)) {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > CODEX_STALE_MS) continue;
    const meta = firstLine(path);
    if (meta?.type !== 'session_meta') continue;
    const payload = record(meta.payload);
    if (payload.thread_source === 'subagent' || 'subagent' in record(payload.source)) continue;
    const id = text(payload.id) || text(payload.session_id);
    if (!id) continue;
    const state = codexRolloutState(path);
    if (!state) continue;
    const session: SessionInfo = {
      brain: 'codex',
      id,
      interactive: text(payload.source) !== 'exec',
      updatedAt: new Date(mtime).toISOString(),
      live: { ...state, kind: 'interactive' },
    };
    if (text(payload.cwd)) session.cwd = text(payload.cwd);
    out.push(session);
  }
  return out;
}

async function agyLive(home: string): Promise<SessionInfo[]> {
  const path = join(home, 'conversation_summaries.db');
  try {
    statSync(path);
  } catch {
    return [];
  }
  const open = await openSqlite();
  if (!open) return [];
  let db: Database | undefined;
  try {
    db = open(path);
    const rows = db
      .prepare(
        'SELECT conversation_id, title, workspace_uris, status, not_fully_idle, killed, last_modified_time ' +
          "FROM conversation_summaries WHERE last_modified_time > datetime('now', '-1 day')",
      )
      .all();
    const out: SessionInfo[] = [];
    for (const row of rows) {
      const r = record(row);
      const id = text(r.conversation_id);
      if (!id || Number(r.killed) === 1) continue;
      const status = text(r.status).toUpperCase();
      let state: 'busy' | 'waiting' | undefined;
      if (/WAIT|INPUT|APPROV|CONFIRM|PAUSE/.test(status)) state = 'waiting';
      else if (/RUNNING|PROGRESS|BUSY|ACTIVE/.test(status) || Number(r.not_fully_idle) === 1) state = 'busy';
      if (!state) continue;
      const session: SessionInfo = {
        brain: 'antigravity',
        id,
        interactive: true,
        live: { status: state, kind: 'interactive' },
      };
      const cwd = workspaces(text(r.workspace_uris))[0];
      if (cwd) session.cwd = cwd;
      if (text(r.title)) {
        session.title = text(r.title);
        session.titleSource = 'generated';
      }
      const updated = isoFromSql(text(r.last_modified_time));
      if (updated) session.updatedAt = updated;
      out.push(session);
    }
    return out;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function liveRow(row: unknown): SessionInfo | undefined {
  const r = record(row);
  const id = text(r.sessionId);
  if (!id) return undefined;
  const kind = text(r.kind) || 'interactive';
  const live: LiveState = { status: text(r.status) || 'idle', kind };
  if (text(r.waitingFor)) live.waitingFor = text(r.waitingFor);
  if (typeof r.pid === 'number') live.pid = r.pid;
  if (text(r.id)) live.shortId = text(r.id);
  if (text(r.state)) live.state = text(r.state);
  const session: SessionInfo = { brain: 'claude', id, interactive: true, live };
  const cwd = text(r.cwd);
  if (cwd) session.cwd = cwd;
  const name = text(r.name);
  if (name && !isDefaultLabel(name, cwd)) {
    session.title = name;
    session.titleSource = 'name';
  }
  const started = isoFromMs(r.startedAt);
  if (started) session.startedAt = started;
  if (kind === 'background') session.background = true;
  return session;
}

/**
 * Claude Code labels an unnamed session with its folder and two characters
 * (`factoyard-3f`) in listings of running sessions. That label is not a
 * title, and it is not something `--resume` accepts.
 */
function isDefaultLabel(name: string, cwd: string): boolean {
  const folder = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return new RegExp(`^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-z]{2}$`).test(name);
}

/** Stored sessions with the live state of the running ones; running sessions not on disk yet are added. */
function mergeLive(stored: SessionInfo[], live: SessionInfo[]): SessionInfo[] {
  const byId = new Map(live.map((session) => [session.id, session]));
  const out = stored.map((session) => {
    const now = byId.get(session.id);
    if (!now) return session;
    byId.delete(session.id);
    const merged: SessionInfo = { ...session };
    if (now.live) merged.live = now.live;
    if (now.background) merged.background = true;
    // A stored name wins over a default display name.
    if (!merged.title && now.title) {
      merged.title = now.title;
      merged.titleSource = 'name';
    }
    return merged;
  });
  return [...out, ...byId.values()];
}

// ── Claude Code ─────────────────────────────────────────────────────────────

const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 256 * 1024;

function claudeSessions(home: string, places: ReadonlySet<string>): SessionInfo[] {
  const root = join(home, 'projects');
  const dirs = new Set<string>();
  for (const place of places) {
    const name = claudeProjectDir(place);
    if (name.length <= 200) dirs.add(join(root, name));
    else for (const entry of listDir(root)) if (entry.startsWith(name.slice(0, 200))) dirs.add(join(root, entry));
  }
  const out: SessionInfo[] = [];
  for (const dir of dirs) {
    for (const file of listDir(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const session = claudeTranscript(join(dir, file));
      if (session) out.push(session);
    }
  }
  return out;
}

/** One transcript → a session, or undefined when it holds no conversation. */
export function claudeTranscript(path: string): SessionInfo | undefined {
  const id = basename(path, '.jsonl');
  let size: number;
  let mtime: Date;
  try {
    const stat = statSync(path);
    size = stat.size;
    mtime = stat.mtime;
  } catch {
    return undefined;
  }
  // The first user message is near the start, the latest title near the end;
  // transcripts run to many megabytes, so only those two ends are read.
  const head = jsonLines(readRange(path, 0, Math.min(size, HEAD_BYTES)), false);
  const tail = size > HEAD_BYTES ? jsonLines(readRange(path, Math.max(0, size - TAIL_BYTES), TAIL_BYTES), true) : [];
  const entries = [...head, ...tail];

  let first: Record<string, unknown> | undefined;
  for (const entry of head) {
    if (entry.type === 'user' && userText(entry) !== undefined) {
      first = entry;
      break;
    }
  }
  if (!first && !entries.some((entry) => entry.type === 'user' || entry.type === 'assistant')) return undefined;

  let name: string | undefined;
  let generated: string | undefined;
  let background = false;
  let entrypoint = first ? text(first.entrypoint) : '';
  let cwd = first ? text(first.cwd) : '';
  for (const entry of entries) {
    if (entry.type === 'custom-title' && text(entry.customTitle)) name = text(entry.customTitle);
    else if (entry.type === 'ai-title' && text(entry.aiTitle)) generated = text(entry.aiTitle);
    if (entry.sessionKind === 'bg') background = true;
    if (!entrypoint && text(entry.entrypoint)) entrypoint = text(entry.entrypoint);
    if (!cwd && text(entry.cwd)) cwd = text(entry.cwd);
  }

  const session: SessionInfo = {
    brain: 'claude',
    id,
    updatedAt: mtime.toISOString(),
    // The Agent SDK and `claude -p` say `sdk-cli`, `sdk-ts`, `sdk-py`; the
    // terminal says `cli`, the IDE extensions `claude-vscode` and the like.
    interactive: !entrypoint.startsWith('sdk'),
  };
  if (cwd) session.cwd = cwd;
  const started = first ? text(first.timestamp) : '';
  if (started) session.startedAt = started;
  if (background) session.background = true;
  const prompt = first ? userText(first) : undefined;
  if (name) {
    session.title = name;
    session.titleSource = 'name';
  } else if (generated) {
    session.title = generated;
    session.titleSource = 'generated';
  } else if (prompt) {
    session.title = oneLine(prompt).slice(0, 120);
    session.titleSource = 'prompt';
  }
  return session;
}

/** Text of a user message, skipping the wrappers Claude Code adds (`<command-name>`, reminders, tool results). */
function userText(entry: Record<string, unknown>): string | undefined {
  const message = record(entry.message);
  const content = message.content;
  let value: string | undefined;
  if (typeof content === 'string') value = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      const block = record(part);
      if (block.type === 'text' && typeof block.text === 'string') {
        value = block.text;
        break;
      }
    }
  }
  if (value === undefined) return undefined;
  const clean = value.trim();
  if (!clean || clean.startsWith('<')) return undefined;
  return clean;
}

// ── Codex ───────────────────────────────────────────────────────────────────

function codexSessions(home: string, places: ReadonlySet<string>): SessionInfo[] {
  const names = codexNames(join(home, 'session_index.jsonl'));
  const out: SessionInfo[] = [];
  for (const path of rolloutFiles(join(home, 'sessions'))) {
    // `session_meta` carries the whole base prompt, tens of kilobytes; `cwd`
    // comes before it, so a short read decides whether the file is ours.
    const start = readRange(path, 0, 4096);
    const where = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(start);
    if (!where?.[1]) continue;
    let cwd: string;
    try {
      cwd = JSON.parse(`"${where[1]}"`) as string;
    } catch {
      continue;
    }
    if (!places.has(cwd)) continue;
    const meta = firstLine(path);
    if (meta?.type !== 'session_meta') continue;
    const payload = record(meta.payload);
    const id = text(payload.id) || text(payload.session_id);
    if (!id) continue;
    // Threads Codex spawns for itself (a guardian review of an approval, a
    // sub-agent) are not anyone's session, and they start after the one that
    // spawned them — skipped, or they would pass for the newest session.
    if (payload.thread_source === 'subagent' || 'subagent' in record(payload.source)) continue;
    const source = text(payload.source);
    const session: SessionInfo = {
      brain: 'codex',
      id,
      cwd,
      interactive: source !== 'exec' && text(payload.originator) !== 'codex_exec',
    };
    const started = text(payload.timestamp) || text(meta.timestamp);
    if (started) session.startedAt = started;
    try {
      session.updatedAt = statSync(path).mtime.toISOString();
    } catch {
      // Gone between listing and reading.
    }
    const name = names.get(id);
    if (name) {
      session.title = name;
      session.titleSource = 'generated';
    } else {
      const prompt = codexFirstPrompt(path);
      if (prompt) {
        session.title = oneLine(prompt).slice(0, 120);
        session.titleSource = 'prompt';
      }
    }
    out.push(session);
  }
  return out;
}

/**
 * The first thing the person typed. Codex opens a thread with its own
 * context as user messages too (`<environment_context>`, plugin lists,
 * AGENTS.md), so the first message that is not wrapped in a tag is the one.
 */
function codexFirstPrompt(path: string): string | undefined {
  for (const entry of jsonLines(readRange(path, 0, HEAD_BYTES * 3), false)) {
    const payload = record(entry.payload);
    let value: string | undefined;
    if (entry.type === 'event_msg' && payload.type === 'user_message') value = text(payload.message);
    else if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      for (const part of Array.isArray(payload.content) ? payload.content : []) {
        const block = record(part);
        if (block.type === 'input_text' && text(block.text)) {
          value = text(block.text);
          break;
        }
      }
    }
    const clean = value?.trim();
    if (clean && !clean.startsWith('<') && !clean.startsWith('# AGENTS.md')) return clean;
  }
  return undefined;
}

function codexNames(path: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of jsonLines(readText(path), false)) {
    const id = text(entry.id);
    const name = text(entry.thread_name);
    if (id && name) names.set(id, name);
  }
  return names;
}

/** `sessions/YYYY/MM/DD/rollout-*.jsonl`, newest day first. */
function rolloutFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = listDir(dir).sort().reverse();
    for (const entry of entries) {
      const path = join(dir, entry);
      if (depth < 3) walk(path, depth + 1);
      else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) files.push(path);
    }
  };
  walk(root, 0);
  return files;
}

// ── Antigravity ─────────────────────────────────────────────────────────────

async function agySessions(home: string, places: ReadonlySet<string>): Promise<SessionInfo[]> {
  const fromHistory = agyFromHistory(join(home, 'history.jsonl'), places);
  const fromDb = await agyFromDatabase(join(home, 'conversation_summaries.db'), places);
  if (!fromDb) return fromHistory;
  // The database knows titles and times, but a conversation can sit there
  // with an empty title; the history still has what was typed first.
  const prompts = new Map(fromHistory.map((session) => [session.id, session]));
  for (const session of fromDb) {
    const typed = prompts.get(session.id);
    if (!session.title && typed?.title) {
      session.title = typed.title;
      session.titleSource = 'prompt';
    }
    if (typed?.startedAt && (!session.startedAt || typed.startedAt < session.startedAt)) {
      session.startedAt = typed.startedAt;
    }
  }
  const known = new Set(fromDb.map((session) => session.id));
  return [...fromDb, ...fromHistory.filter((session) => !known.has(session.id))];
}

type Database = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

let sqlite: Promise<((path: string) => Database) | undefined> | undefined;

/** `node:sqlite` where this Node has it, quietly: Node 22 announces it as experimental on stderr. */
function openSqlite(): Promise<((path: string) => Database) | undefined> {
  sqlite ??= (async () => {
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const message = typeof warning === 'string' ? warning : warning.message;
      if (/sqlite/i.test(message)) return;
      (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      const mod = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database;
      };
      return (path: string) => new mod.DatabaseSync(path, { readOnly: true });
    } catch {
      return undefined;
    } finally {
      process.emitWarning = emit;
    }
  })();
  return sqlite;
}

async function agyFromDatabase(path: string, places: ReadonlySet<string>): Promise<SessionInfo[] | undefined> {
  try {
    statSync(path);
  } catch {
    return undefined;
  }
  const open = await openSqlite();
  if (!open) return undefined;
  let db: Database | undefined;
  try {
    db = open(path);
    const rows = db
      .prepare(
        'SELECT conversation_id, title, workspace_uris, status, last_modified_time, last_user_input_time ' +
          'FROM conversation_summaries ORDER BY last_modified_time DESC',
      )
      .all();
    const out: SessionInfo[] = [];
    for (const row of rows) {
      const r = record(row);
      const id = text(r.conversation_id);
      if (!id) continue;
      const cwd = workspaces(text(r.workspace_uris)).find((place) => places.has(place));
      if (!cwd) continue;
      const session: SessionInfo = { brain: 'antigravity', id, cwd, interactive: true };
      const title = text(r.title);
      if (title) {
        session.title = title;
        session.titleSource = 'generated';
      }
      const updated = isoFromSql(text(r.last_modified_time));
      if (updated) session.updatedAt = updated;
      const input = isoFromSql(text(r.last_user_input_time));
      if (input) session.startedAt = input;
      out.push(session);
    }
    return out;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function workspaces(uris: string): string[] {
  try {
    const list: unknown = JSON.parse(uris);
    if (!Array.isArray(list)) return [];
    return list
      .map((uri) => String(uri))
      .filter((uri) => uri.startsWith('file://'))
      .map((uri) => decodeURIComponent(uri.slice('file://'.length)));
  } catch {
    return [];
  }
}

function agyFromHistory(path: string, places: ReadonlySet<string>): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const entry of jsonLines(readText(path), false)) {
    const id = text(entry.conversationId);
    const workspace = text(entry.workspace);
    if (!id || !places.has(workspace)) continue;
    const at = isoFromMs(entry.timestamp);
    let session = byId.get(id);
    if (!session) {
      session = { brain: 'antigravity', id, cwd: workspace, interactive: true };
      const prompt = oneLine(text(entry.display)).slice(0, 120);
      if (prompt) {
        session.title = prompt;
        session.titleSource = 'prompt';
      }
      if (at) session.startedAt = at;
      byId.set(id, session);
    }
    if (at) session.updatedAt = at;
  }
  return [...byId.values()];
}

// ── Plumbing ────────────────────────────────────────────────────────────────

/** The folder as given and as the filesystem resolves it: `/tmp` is `/private/tmp` on macOS, and CLIs store either. */
export function pathVariants(cwd: string): Set<string> {
  const places = new Set([cwd]);
  try {
    places.add(realpathSync(cwd));
  } catch {
    // A folder that does not exist has no other name.
  }
  return places;
}

function newestFirst(list: SessionInfo[]): SessionInfo[] {
  const time = (session: SessionInfo) => Date.parse(session.updatedAt ?? session.startedAt ?? '') || 0;
  return [...list].sort((a, b) => time(b) - time(a));
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readRange(path: string, start: number, length: number): string {
  if (length <= 0) return '';
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The first line of a file, however long, parsed. */
function firstLine(path: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    for (let position = 0; position < 8 * 1024 * 1024; ) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      const piece = chunk.subarray(0, read);
      const cut = piece.indexOf(10);
      if (cut >= 0) {
        chunks.push(Buffer.from(piece.subarray(0, cut)));
        break;
      }
      chunks.push(Buffer.from(piece));
      position += read;
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return record(parsed);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** JSON objects, one per line. A cut-off first line (`fromMiddle`) and anything unparseable are skipped. */
function jsonLines(chunk: string, fromMiddle: boolean): Record<string, unknown>[] {
  const lines = chunk.split('\n');
  if (fromMiddle) lines.shift();
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // The last line of a head read is usually cut off too.
    }
  }
  return out;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isoFromMs(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/** `2026-10-01 19:19:06.687213+00:00` → ISO. */
function isoFromSql(value: string): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
