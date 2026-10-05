/**
 * Panes: a CLI session that runs in tmux, so another program can show its
 * screen, type into it and hand the whole terminal over to it — and the
 * session outlives that program. Claude Squad works the same way.
 *
 * - **Its own tmux server** (`tmux -L brainyard -f /dev/null`): the person's
 *   tmux and its config are never touched, and nothing of theirs leaks in.
 * - **The CLI is the same interactive session `open()` starts**, so it is
 *   resumable and shows up in `claude --resume`, `codex resume`, agy and OpenCode.
 * - **Cheap to watch**: a screen is one `capture-pane` of the visible grid,
 *   with colours; nothing is read for panes nobody looks at.
 * - **Copying works**: text selected with the mouse in a full-screen pane goes
 *   to the system clipboard (`clipboardCommand()`), not only to tmux's buffer.
 * - **Cheap to keep**: `closePane()` ends the CLI; its conversation stays in
 *   its store, and `startPane({ resume })` brings it back. `paneMemory()` says
 *   what each live pane costs, `activityAt` how long it has been quiet.
 *
 * tmux is an external program, like the CLIs themselves; `panesAvailable()`
 * says whether it is installed. Not on Windows.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrainyardError } from './errors.js';
import { findStarted, type OpenOptions, planOpen } from './open.js';
import {
  type Command,
  capture,
  resolveCommand,
  spawnInteractive,
  unsetSessionVarsScript,
  which,
  withoutSessionVars,
} from './process.js';
import type { SessionInfo } from './sessions.js';
import type { BrainId } from './types.js';
import { BRAIN_IDS } from './types.js';

export interface PaneOptions extends OpenOptions {
  /** Columns and rows of the pane's screen; a watcher resizes it to its view later. */
  width?: number;
  height?: number;
  /** Shown by watchers; defaults to the session name. */
  label?: string;
}

export interface PaneStart {
  pane: string;
  brain: BrainId;
  /** Known at once for Claude Code and for a resumed session; the others: `findPaneSession()`. */
  sessionId?: string;
  /** ISO. */
  startedAt: string;
  warnings: string[];
  /** The CLI command line, for logs. */
  display: string;
}

export interface PaneInfo {
  /** The tmux session name. */
  pane: string;
  brain?: BrainId;
  sessionId?: string;
  label?: string;
  cwd?: string;
  /** The CLI's process (the pane's first process). */
  pid?: number;
  /** What runs in the pane now, as tmux sees it (`node`, `agy`…). */
  command?: string;
  /** ISO. */
  startedAt?: string;
  /** ISO: the last time the CLI printed anything. */
  activityAt?: string;
  /** A terminal shows it full screen right now. */
  attached: boolean;
  width: number;
  height: number;
}

export interface PaneScreen {
  /** One string per row, with colours as ANSI SGR; each row sets and resets its own. */
  lines: string[];
  width: number;
  height: number;
  cursor: { x: number; y: number; visible: boolean };
  /** Available scrollback rows and the captured viewport's distance above the live screen. */
  historySize: number;
  scrollOffset: number;
  /** The CLI handles mouse events itself (coordinates are relative to its screen). */
  mouseTracking: boolean;
  mouseSgr: boolean;
  alternate: boolean;
  /** ISO: the last time the CLI printed anything. */
  activityAt?: string;
}

export interface PaneSettings {
  /** tmux executable; `BRAINYARD_TMUX_BIN`, then `tmux` on PATH. */
  command?: string | string[];
  /** Server socket name; `BRAINYARD_TMUX_SOCKET`, then `brainyard`. */
  socket?: string;
  env?: NodeJS.ProcessEnv;
}

const META = ['@brain', '@session', '@label', '@cwd', '@started'] as const;
const SEP = '\u001f';

/**
 * The fields of one line of a `-F` listing. tmux 3.4 writes a control
 * character in its format output as an octal escape, the separator as `\037`;
 * later versions write it as it is.
 */
export function formatFields(line: string): string[] {
  return line.replaceAll('\\037', SEP).split(SEP);
}

/** tmux refuses to start inside tmux, and a pane is not inside the terminal that started it. */
const NESTING = ['TMUX', 'TMUX_PANE'];
/** tmux takes at most 16 KB per command; hex input is three characters a byte. */
const SEND_CHUNK = 2_000;

interface Tmux {
  command: Command;
  socket: string;
  env: NodeJS.ProcessEnv;
}

function tmux(settings: PaneSettings = {}): Tmux | undefined {
  if (process.platform === 'win32') return undefined;
  // The server keeps the environment of whoever started it, for every pane to come.
  const env = withoutSessionVars({ ...process.env, ...settings.env });
  for (const name of NESTING) delete env[name];
  const command = resolveCommand(settings.command, 'tmux', 'BRAINYARD_TMUX_BIN', env);
  if (!command) return undefined;
  return { command, socket: settings.socket ?? env.BRAINYARD_TMUX_SOCKET?.trim() ?? 'brainyard', env };
}

function need(settings: PaneSettings = {}): Tmux {
  const found = tmux(settings);
  if (!found) {
    throw new BrainyardError(
      'not_installed',
      process.platform === 'win32'
        ? 'panes need tmux, which Windows does not have'
        : 'panes need tmux: brew install tmux',
    );
  }
  return found;
}

async function call(t: Tmux, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const got = await capture(t.command, ['-L', t.socket, '-f', '/dev/null', ...args], { env: t.env, timeoutMs: 10_000 });
  return { ok: got.code === 0 && !got.error, out: got.stdout, err: (got.stderr || got.error?.message || '').trim() };
}

/**
 * In tmux's argument form a trailing `;` ends a command. Our values (labels,
 * ids) can end with one; `\;` keeps it literal.
 */
function literal(value: string): string {
  return value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;
}

/**
 * `=name:` — exactly this session (and its window), never one whose name
 * merely starts the same. Plain `=name` works only where a whole session is
 * the target, not for options, captures or keys.
 */
function target(pane: string): string {
  return `=${pane}:`;
}

/** Labels live in tab-separated listings: no tabs, line breaks or separators. */
function oneLine(value: string): string {
  return [...value]
    .map((char) => (char < ' ' ? ' ' : char))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * What tmux gives a mouse selection to: the system clipboard. Without it, text
 * selected in a full-screen pane stays in tmux's own buffer, which nothing
 * outside can paste. `BRAINYARD_COPY_COMMAND` names another command (empty:
 * none, tmux keeps the text to itself).
 */
export function clipboardCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const own = env.BRAINYARD_COPY_COMMAND;
  if (own !== undefined) return own.trim() || undefined;
  // pbcopy reads bytes in the locale's encoding, and the server may have none.
  if (platform === 'darwin') return which('pbcopy', env) ? 'LC_ALL=en_US.UTF-8 pbcopy' : undefined;
  if (env.WAYLAND_DISPLAY && which('wl-copy', env)) return 'wl-copy';
  if (env.DISPLAY && which('xclip', env)) return 'xclip -selection clipboard';
  if (env.DISPLAY && which('xsel', env)) return 'xsel --clipboard --input';
  return undefined;
}

/**
 * Mouse selections go to the clipboard. On its own: a tmux older than 3.2 has
 * no `copy-command`, and that must not stop a pane from starting.
 */
async function copyToClipboard(t: Tmux): Promise<void> {
  const command = clipboardCommand(t.env);
  if (command) await call(t, ['set-option', '-s', 'copy-command', literal(command)]);
}

/** Whether tmux is there to run panes. */
export function panesAvailable(settings: PaneSettings = {}): boolean {
  return tmux(settings) !== undefined;
}

/**
 * Starts a CLI session in a new pane and returns at once; the session runs
 * until the CLI exits or `closePane()`.
 */
export async function startPane(options: PaneOptions, settings: PaneSettings = {}): Promise<PaneStart> {
  const t = need(settings);
  if (options.background) {
    throw new BrainyardError('invalid_option', 'a pane is already in the background; drop `background`');
  }
  const plan = await planOpen(options);
  const pane = `${plan.brain === 'antigravity' ? 'agy' : plan.brain}-${randomBytes(4).toString('hex')}`;
  const startedAt = new Date();

  // The command goes through a one-shot script, not tmux's command line: a
  // prompt can be long (tmux takes 16 KB per command) and can end with `;`.
  const dir = join(tmpdir(), `brainyard-panes-${process.getuid?.() ?? 'user'}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const script = join(dir, `${pane}.sh`);
  const exports = Object.entries(options.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new BrainyardError('invalid_option', `bad variable name: ${key}`);
    return `export ${key}=${shellQuote(value)}`;
  });
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'rm -f "$0"',
      // A server started from inside a Claude Code session remembers that session's variables.
      ...unsetSessionVarsScript(),
      `unset ${NESTING.join(' ')}`,
      ...exports,
      `cd ${shellQuote(plan.cwd)} || exit 1`,
      [plan.command.file, ...plan.command.args, ...plan.args].map(shellQuote).join(' '),
      // A CLI that fails at once would take its reason with it: keep the screen until Enter.
      'code=$?',
      `if [ "$code" -ne 0 ] && [ "$code" -lt 128 ]; then printf '\\n\\033[2m%s exited with code %s · Enter closes\\033[0m\\n' ${shellQuote(plan.brain)} "$code"; read -r _; fi`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(script, 0o700);

  const width = String(Math.max(20, Math.round(options.width ?? 100)));
  const height = String(Math.max(5, Math.round(options.height ?? 30)));
  const meta: [string, string][] = [
    ['@brain', plan.brain],
    ['@cwd', plan.cwd],
    ['@started', startedAt.toISOString()],
    ['@label', oneLine(options.label ?? options.name ?? '')],
  ];
  if (plan.sessionId) meta.push(['@session', plan.sessionId]);
  const args = ['new-session', '-d', '-s', pane, '-x', width, '-y', height, '-c', plan.cwd, '--', '/bin/sh', script];
  for (const [key, value] of meta) if (value) args.push(';', 'set-option', '-t', target(pane), key, literal(value));
  // The server's own settings: no delay after Esc (CLIs use it), the wheel
  // scrolls, Ctrl+Q leaves a full-screen pane, no status line unless attached.
  args.push(
    ';',
    'set-option',
    '-s',
    'escape-time',
    '0',
    ';',
    'set-option',
    '-g',
    'mouse',
    'on',
    ';',
    'set-option',
    '-g',
    'status',
    'off',
    ';',
    'bind-key',
    '-n',
    'C-q',
    'detach-client',
  );
  const got = await call(t, args);
  if (!got.ok) throw new BrainyardError('failed', `tmux did not start the pane: ${got.err || 'no reason given'}`);
  await copyToClipboard(t);
  const result: PaneStart = {
    pane,
    brain: plan.brain,
    startedAt: startedAt.toISOString(),
    warnings: [...plan.warnings],
    display: plan.display,
  };
  if (plan.sessionId) result.sessionId = plan.sessionId;
  return result;
}

const LIST_FORMAT = [
  '#{session_name}',
  ...META.map((key) => `#{${key}}`),
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{session_created}',
  '#{window_activity}',
  '#{session_attached}',
  '#{window_width}',
  '#{window_height}',
].join(SEP);

function iso(seconds: string | undefined): string | undefined {
  const n = Number(seconds);
  return n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

/** Every live pane of this server. Empty when tmux is missing or nothing runs. */
export async function listPanes(settings: PaneSettings = {}): Promise<PaneInfo[]> {
  const t = tmux(settings);
  if (!t) return [];
  const got = await call(t, ['list-sessions', '-F', LIST_FORMAT]);
  if (!got.ok) return [];
  const panes: PaneInfo[] = [];
  for (const line of got.out.split('\n')) {
    if (!line.trim()) continue;
    const [name, brain, session, label, cwd, started, pid, command, created, activity, attached, width, height] =
      formatFields(line);
    if (!name) continue;
    const info: PaneInfo = {
      pane: name,
      attached: Number(attached) > 0,
      width: Number(width) || 0,
      height: Number(height) || 0,
    };
    if ((BRAIN_IDS as readonly string[]).includes(brain ?? '')) info.brain = brain as BrainId;
    if (session) info.sessionId = session;
    if (label) info.label = label;
    if (cwd) info.cwd = cwd;
    if (Number(pid) > 0) info.pid = Number(pid);
    if (command) info.command = command;
    const startedAt = started || iso(created);
    if (startedAt) info.startedAt = startedAt;
    const activityAt = iso(activity);
    if (activityAt) info.activityAt = activityAt;
    panes.push(info);
  }
  return panes;
}

const SCREEN_FORMAT = [
  '#{pane_width}',
  '#{pane_height}',
  '#{cursor_x}',
  '#{cursor_y}',
  '#{cursor_flag}',
  '#{window_activity}',
  '#{history_size}',
  '#{mouse_any_flag}#{mouse_button_flag}#{mouse_standard_flag}',
  '#{mouse_sgr_flag}',
  '#{alternate_on}',
].join(SEP);

/** A screen-sized viewport, optionally scrolled into history; undefined when it is gone. */
export async function capturePane(
  pane: string,
  settings: PaneSettings & { scroll?: number } = {},
): Promise<PaneScreen | undefined> {
  const t = tmux(settings);
  if (!t) return undefined;
  const scrolled = Number.isFinite(settings.scroll) && (settings.scroll ?? 0) > 0;
  const args = ['display-message', '-p', '-t', target(pane), SCREEN_FORMAT];
  if (!scrolled) args.push(';', 'capture-pane', '-p', '-e', '-t', target(pane));
  const got = await call(t, args);
  if (!got.ok) return undefined;
  const [head = '', ...rest] = got.out.split('\n');
  const [width, height, x, y, visible, activity, history, mouse, mouseSgr, alternate] = formatFields(head);
  const rows = Number(height) || 0;
  const historySize = Number(history) || 0;
  const scrollOffset = scrolled ? Math.min(historySize, Math.floor(settings.scroll!)) : 0;
  let lines = rest.slice(0, rows);
  if (scrolled) {
    const captured = await call(t, [
      'capture-pane',
      '-p',
      '-e',
      '-t',
      target(pane),
      '-S',
      String(-scrollOffset),
      '-E',
      String(rows - scrollOffset - 1),
    ]);
    if (!captured.ok) return undefined;
    lines = captured.out.split('\n').slice(0, rows);
  }
  while (lines.length < rows) lines.push('');
  const screen: PaneScreen = {
    lines,
    width: Number(width) || 0,
    height: rows,
    cursor: { x: Number(x) || 0, y: Number(y) || 0, visible: visible === '1' },
    historySize,
    scrollOffset,
    mouseTracking: mouse?.includes('1') ?? false,
    mouseSgr: mouseSgr === '1',
    alternate: alternate === '1',
  };
  const activityAt = iso(activity);
  if (activityAt) screen.activityAt = activityAt;
  return screen;
}

/**
 * Types into the pane: the bytes go to the CLI as if typed in its terminal
 * (keys, escape sequences, pasted text in any language).
 */
export async function sendToPane(pane: string, data: string | Uint8Array, settings: PaneSettings = {}): Promise<void> {
  const t = need(settings);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  for (let from = 0; from < bytes.length; from += SEND_CHUNK) {
    const hex = [...bytes.subarray(from, from + SEND_CHUNK)].map((byte) => byte.toString(16).padStart(2, '0'));
    const got = await call(t, ['send-keys', '-t', target(pane), '-H', ...hex]);
    if (!got.ok) throw new BrainyardError('failed', `tmux did not take the keys: ${got.err || 'the pane is gone'}`);
  }
}

/** Makes the pane's screen this size, so it fits the view that shows it. */
export async function resizePane(
  pane: string,
  width: number,
  height: number,
  settings: PaneSettings = {},
): Promise<boolean> {
  const t = tmux(settings);
  if (!t) return false;
  const got = await call(t, [
    'resize-window',
    '-t',
    target(pane),
    '-x',
    String(Math.max(20, Math.round(width))),
    '-y',
    String(Math.max(5, Math.round(height))),
  ]);
  return got.ok;
}

/** Remembers which CLI session runs in the pane (all but Claude Code name it only after starting). */
export async function setPaneSession(pane: string, sessionId: string, settings: PaneSettings = {}): Promise<boolean> {
  const t = tmux(settings);
  if (!t) return false;
  return (await call(t, ['set-option', '-t', target(pane), '@session', literal(sessionId)])).ok;
}

/** The session a Codex, Antigravity or OpenCode pane started, found in the CLI's store. */
export async function findPaneSession(
  info: PaneInfo,
  options: Pick<OpenOptions, 'env' | 'homes'> = {},
): Promise<SessionInfo | undefined> {
  if (info.sessionId) return undefined;
  if (!info.brain || !info.cwd || !info.startedAt) return undefined;
  return findStarted(info.brain, info.cwd, new Date(info.startedAt), options);
}

/**
 * Shows the pane full screen in this terminal until the person leaves it
 * (Ctrl+Q, or the CLI exits). The pane takes the terminal's size; the
 * caller resizes it back to its view afterwards.
 */
export async function attachPane(pane: string, options: { hint?: string } & PaneSettings = {}): Promise<number | null> {
  const t = need(options);
  const hint = (options.hint ?? 'Ctrl+Q — back').replaceAll('#', '##');
  const style = await call(t, [
    'set-option',
    '-t',
    target(pane),
    'status',
    'on',
    ';',
    'set-option',
    '-t',
    target(pane),
    'status-style',
    'bg=default,fg=colour244',
    ';',
    'set-option',
    '-t',
    target(pane),
    'status-left',
    '',
    ';',
    'set-option',
    '-t',
    target(pane),
    'status-right',
    literal(hint),
    ';',
    'set-option',
    '-t',
    target(pane),
    'window-status-format',
    '',
    ';',
    'set-option',
    '-t',
    target(pane),
    'window-status-current-format',
    '',
    ';',
    'set-option',
    '-w',
    '-t',
    target(pane),
    'window-size',
    'latest',
  ]);
  if (!style.ok) throw new BrainyardError('failed', `no such pane: ${pane}`);
  // A server started by an older Brainyard, or by another program on its socket, copies to the clipboard too.
  await copyToClipboard(t);
  const child = spawnInteractive(t.command, ['-L', t.socket, '-f', '/dev/null', 'attach-session', '-t', target(pane)], {
    cwd: process.cwd(),
    env: t.env,
  });
  const ignore = () => undefined;
  process.on('SIGINT', ignore);
  try {
    return await new Promise<number | null>((done) => {
      child.once('error', () => done(null));
      child.once('exit', (code) => done(code));
    });
  } finally {
    process.off('SIGINT', ignore);
  }
}

/** Ends the CLI in the pane (it gets SIGHUP, as when a terminal closes); its conversation stays resumable. */
export async function closePane(pane: string, settings: PaneSettings = {}): Promise<boolean> {
  const t = tmux(settings);
  if (!t) return false;
  return (await call(t, ['kill-session', '-t', target(pane)])).ok;
}

/** Resident memory of each pane's CLI with everything it started, in bytes. */
export async function paneMemory(panes: readonly PaneInfo[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const roots = panes.filter((info) => info.pid);
  if (roots.length === 0 || process.platform === 'win32') return out;
  const ps = resolveCommand('ps', 'ps', 'BRAINYARD_PS_BIN');
  if (!ps) return out;
  const got = await capture(ps, ['-A', '-o', 'pid=,ppid=,rss='], { timeoutMs: 5_000 });
  if (got.code !== 0) return out;
  const parent = new Map<number, number>();
  const rss = new Map<number, number>();
  for (const line of got.stdout.split('\n')) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    parent.set(pid, ppid ?? 0);
    rss.set(pid, (kb ?? 0) * 1024);
  }
  const owner = new Map<number, string>(roots.map((info) => [info.pid!, info.pane]));
  for (const pid of rss.keys()) {
    let at: number | undefined = pid;
    for (let hops = 0; at && hops < 64; hops++) {
      const pane = owner.get(at);
      if (pane) {
        out.set(pane, (out.get(pane) ?? 0) + (rss.get(pid) ?? 0));
        break;
      }
      at = parent.get(at);
    }
  }
  return out;
}
