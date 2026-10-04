/**
 * `brainyard panes` and `brainyard pane …`: CLI sessions in Brainyard's own
 * tmux server. They outlive the terminal that started them: a person looks at
 * one (`show`), types into it (`send`), takes it full screen (`attach`) and
 * ends it (`close`); its conversation stays resumable.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import {
  attachPane,
  BRAINS,
  capturePane,
  clip,
  closePane,
  findPaneSession,
  listPanes,
  type PaneInfo,
  paneMemory,
  panesAvailable,
  sendToPane,
  startPane,
  tidyPaths,
} from '@antondanv/brainyard';

import { brainArg, countArg, Failure, parse, readStdin, UsageError } from './args.js';
import { ago, bytes, cwdFlag } from './format.js';
import { colourful, type Paint, paint, plain, table } from './term.js';

const out = paint(process.stdout);
const err = paint(process.stderr);

/** A live pane and the memory its CLI uses, as `panes` lists it. */
export type PaneRow = PaneInfo & { memory?: number };

/** Keys `pane send --key` knows by name, as a terminal sends them. */
export const KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  tab: '\t',
  'shift-tab': '\u001b[Z',
  esc: '\u001b',
  escape: '\u001b',
  space: ' ',
  backspace: '\u007f',
  delete: '\u001b[3~',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  home: '\u001b[H',
  end: '\u001b[F',
  pageup: '\u001b[5~',
  pagedown: '\u001b[6~',
};

/** A key by name: `enter`, `esc`, `up`, `shift-tab`, `ctrl-c`… */
export function keyBytes(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  if (Object.hasOwn(KEYS, key)) return KEYS[key];
  const ctrl = /^ctrl-([a-z])$/.exec(key);
  return ctrl ? String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96) : undefined;
}

/** A CLI that reads a fast burst at once may take text plus Enter for a paste and keep the Enter. */
const KEY_PAUSE_MS = 80;

/**
 * Types into a pane: named keys first (Esc stops a turn), then the text, then
 * Enter, each on its own after a short pause, so the CLI sees them as
 * separate keypresses.
 */
export async function typeInto(
  pane: string,
  text: string,
  options: { keys?: readonly string[]; enter?: boolean } = {},
): Promise<void> {
  const parts = [...(options.keys ?? []), ...(text ? [text] : []), ...(options.enter ? ['\r'] : [])];
  for (const [index, part] of parts.entries()) {
    if (index > 0) await sleep(KEY_PAUSE_MS);
    await sendToPane(pane, part);
  }
}

/**
 * A pane as a person names it: its name, or the start of its name or of the
 * id of the session in it. The API then gets the exact name, never a prefix.
 */
export function resolvePane(ref: string, panes: readonly PaneInfo[]): PaneInfo {
  if (!ref) throw new UsageError('name a pane: brainyard panes lists them');
  const exact = panes.find((pane) => pane.pane === ref);
  if (exact) return exact;
  const matches = panes.filter((pane) => pane.pane.startsWith(ref) || pane.sessionId?.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Failure(`no such pane: ${ref}`, 'brainyard panes lists them');
  throw new UsageError(`"${ref}" fits ${matches.length} panes: ${matches.map((pane) => pane.pane).join(', ')}`);
}

/** One line per pane, in columns: name, CLI, session, memory, state, folder, label. */
export function paneLines(rows: readonly PaneRow[], c: Paint, now = Date.now()): string[] {
  const cells = rows.map((row) => {
    const quiet = row.activityAt ? ago(Date.parse(row.activityAt), now) : '';
    let state = quiet ? c.dim(`quiet ${quiet}`) : '';
    if (quiet === 'now') state = c.green('active');
    if (row.attached) state = c.cyan('attached');
    return [
      c.bold(row.pane),
      row.brain ? BRAINS[row.brain].label : c.dim('?'),
      c.dim(row.sessionId ? row.sessionId.slice(0, 8) : '—'),
      row.memory === undefined ? '' : bytes(row.memory),
      state,
      row.cwd ? tidyPaths(row.cwd) : '',
      row.label ? clip(row.label, 60) : '',
    ];
  });
  return table(cells);
}

function needTmux(): void {
  if (panesAvailable()) return;
  if (process.platform === 'win32') throw new Failure('panes need tmux, which Windows does not have');
  throw new Failure(
    'panes need tmux',
    process.platform === 'darwin' ? 'brew install tmux' : "install tmux with the system's package manager",
  );
}

function needTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError('attaching takes a terminal');
}

function noMore(extra: string[]): void {
  if (extra.length > 0) throw new UsageError(`unexpected: ${extra.join(' ')}`);
}

/** Codex, Antigravity and OpenCode name their session only after it starts: look it up in their stores. */
export async function withSessions(panes: readonly PaneInfo[]): Promise<PaneInfo[]> {
  return Promise.all(
    panes.map(async (pane) => {
      if (pane.sessionId) return pane;
      const found = await findPaneSession(pane);
      return found ? { ...pane, sessionId: found.id } : pane;
    }),
  );
}

/** The pane a person named; session ids are looked up only when the name alone does not settle it. */
async function findPane(ref: string | undefined): Promise<PaneInfo> {
  if (!ref) throw new UsageError('name a pane: brainyard panes lists them');
  needTmux();
  const panes = await listPanes();
  return panes.find((pane) => pane.pane === ref) ?? resolvePane(ref, await withSessions(panes));
}

/** The live panes, newest first, with their sessions and the memory their CLIs use. */
export async function readPanes(): Promise<PaneRow[]> {
  const panes = await withSessions(await listPanes());
  const memory = await paneMemory(panes);
  return panes
    .map((pane) => {
      const used = memory.get(pane.pane);
      return used === undefined ? pane : { ...pane, memory: used };
    })
    .sort((a, b) => (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0));
}

export async function panesCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  noMore(positionals);
  needTmux();
  const rows = await readPanes();
  if (values.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write(`${out.dim('no panes · start one: brainyard pane start <brain>')}\n`);
    return 0;
  }
  process.stdout.write(`${paneLines(rows, out).join('\n')}\n`);
  return 0;
}

export async function paneCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case 'start':
      return startCommand(rest);
    case 'attach':
      return attachCommand(rest);
    case 'show':
      return showCommand(rest);
    case 'send':
      return sendCommand(rest);
    case 'close':
      return closeCommand(rest);
    case undefined:
      throw new UsageError('usage: brainyard pane start|attach|show|send|close …');
    default:
      throw new UsageError(`unknown pane command "${command}": start, attach, show, send or close`);
  }
}

async function startCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    cwd: { type: 'string' },
    resume: { type: 'string' },
    name: { type: 'string' },
    label: { type: 'string' },
    system: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    mode: { type: 'string' },
    worktree: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    attach: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const [target, ...words] = positionals;
  const brain = brainArg(target);
  if (values.attach && values.json) throw new UsageError('--attach takes the terminal over; leave out --json');
  if (values.attach) needTerminal();
  const width = values.width === undefined ? undefined : countArg('--width', values.width);
  const height = values.height === undefined ? undefined : countArg('--height', values.height);
  const prompt = words.join(' ').trim();
  needTmux();
  const started = await startPane({
    brain,
    cwd: values.cwd ?? process.cwd(),
    ...(prompt ? { prompt } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values.label ? { label: values.label } : {}),
    ...(values.system ? { system: values.system } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values.mode ? { permissionMode: values.mode } : {}),
    ...(values.worktree !== undefined ? { worktree: values.worktree || true } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(started, null, 2)}\n`);
    return 0;
  }
  for (const warning of started.warnings) process.stderr.write(`${err.yellow('!')} ${warning}\n`);
  // The name alone on stdout: `pane=$(brainyard pane start claude "…")`.
  process.stdout.write(`${started.pane}\n`);
  if (values.attach) return attach(started.pane);
  const session = started.sessionId ? `session ${started.sessionId} · ` : '';
  process.stderr.write(`${err.dim(`${session}attach: brainyard pane attach ${started.pane} · Ctrl+Q — back`)}\n`);
  return 0;
}

async function attach(pane: string): Promise<number> {
  const code = await attachPane(pane);
  const running = (await listPanes()).some((info) => info.pane === pane);
  process.stderr.write(
    `${err.dim(running ? `${pane} keeps running · back: brainyard pane attach ${pane}` : `${pane} has ended`)}\n`,
  );
  return code ?? 1;
}

async function attachCommand(args: string[]): Promise<number> {
  const { positionals } = parse(args, {});
  const [ref, ...extra] = positionals;
  noMore(extra);
  needTerminal();
  return attach((await findPane(ref)).pane);
}

async function showCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { scroll: { type: 'string' }, json: { type: 'boolean' } });
  const [ref, ...extra] = positionals;
  noMore(extra);
  const scroll = values.scroll === undefined ? 0 : countArg('--scroll', values.scroll, 0);
  const pane = await findPane(ref);
  const screen = await capturePane(pane.pane, scroll > 0 ? { scroll } : {});
  if (!screen) throw new Failure(`no such pane: ${pane.pane}`);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(screen, null, 2)}\n`);
    return 0;
  }
  const colour = colourful(process.stdout);
  const lines = screen.lines.map((line) => (colour ? line : plain(line)).trimEnd());
  while (lines.length > 0 && !plain(lines.at(-1) ?? '').trim()) lines.pop();
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function sendCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    key: { type: 'string', multiple: true },
    'no-enter': { type: 'boolean' },
  });
  const [ref, ...words] = positionals;
  const keys = (values.key ?? []).map((name) => {
    const typed = keyBytes(name);
    if (typed === undefined) {
      throw new UsageError(`unknown key "${name}": ${[...Object.keys(KEYS), 'ctrl-<letter>'].join(', ')}`);
    }
    return typed;
  });
  let text = words.join(' ');
  if (text === '-') text = (await readStdin()).replace(/\r?\n$/, '');
  if (!text && keys.length === 0) throw new UsageError('nothing to send: give text, - for stdin, or --key <name>');
  const pane = await findPane(ref);
  await typeInto(pane.pane, text, { keys, enter: text !== '' && !values['no-enter'] });
  return 0;
}

async function closeCommand(args: string[]): Promise<number> {
  const { positionals } = parse(args, {});
  const [ref, ...extra] = positionals;
  noMore(extra);
  const pane = await findPane(ref);
  const sessionId = pane.sessionId ?? (await findPaneSession(pane))?.id;
  if (!(await closePane(pane.pane))) throw new Failure(`no such pane: ${pane.pane}`);
  const resume =
    sessionId && pane.brain
      ? ` · resume: brainyard pane start ${pane.brain}${cwdFlag(pane.cwd)} --resume ${sessionId}`
      : '';
  process.stderr.write(`closed ${pane.pane}${err.dim(resume)}\n`);
  return 0;
}
