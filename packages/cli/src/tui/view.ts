/**
 * The screen as a pure function of the state: `render(state, paint)` gives
 * exactly `state.height` rows of exactly `state.width` cells. A terminal
 * writes them as they are; a browser can draw the same rows.
 *
 * Top to bottom: the header, the body (agents with their limits, panes,
 * sessions running elsewhere, this folder's sessions with their usage), which
 * scrolls, then a line for a question or a note and a line of keys.
 */
import {
  BRAINS,
  type BrainId,
  type BrainUsage,
  clip,
  type SessionInfo,
  tidyPaths,
  type Usage,
} from '@antondanv/brainyard';

import { ago, bytes, money, shortPath, tokens } from '../format.js';
import { liveMark, sessionLines } from '../sessions.js';
import { AVAILABILITY, details } from '../status.js';
import { type Paint, palette, table } from '../term.js';
import { poolLines } from '../usage.js';
import { focus, type Item, type SectionId, type State, sections, stoppable } from './state.js';
import { cells, clean, fit } from './text.js';

/** Below this the app says so instead of drawing a broken screen. */
export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 8;
/** The header above the body and the two lines below it. */
const CHROME = 3;

export interface Row {
  text: string;
  /** The first row of the selected item: drawn inverted. */
  selected?: boolean;
}

export interface Layout {
  rows: Row[];
  /** Body rows of each item: the first one to show (from its heading, for a section's first item) and the last. */
  spans: Map<string, { top: number; last: number }>;
}

export function bodyHeight(state: State): number {
  return Math.max(1, state.height - CHROME);
}

const HEADINGS: Record<SectionId, string> = {
  agents: 'Agents',
  panes: 'Panes',
  running: 'Running in other folders',
  sessions: 'Sessions of',
};

/** The body: every section with its heading, before scrolling. */
export function layout(state: State, c: Paint): Layout {
  const rows: Row[] = [];
  const spans = new Map<string, { top: number; last: number }>();
  const selected = focus(state).item?.key;
  for (const section of sections(state)) {
    rows.push({ text: '' });
    const heading = rows.length;
    rows.push({ text: headingText(section.id, section.items, state, c) });
    const bodies = sectionRows(section.id, section.items, state, c);
    if (section.items.length === 0) rows.push({ text: `  ${emptyText(section.id, state, c)}` });
    for (const [index, item] of section.items.entries()) {
      const lines = bodies[index] ?? [''];
      // A section's first item shows with its heading and the blank row above it.
      const top = index === 0 ? heading - 1 : rows.length;
      for (const [at, line] of lines.entries()) {
        const mark = item.key === selected && at === 0;
        rows.push({ text: `${mark ? '›' : ' '} ${line}`, ...(mark ? { selected: true } : {}) });
      }
      spans.set(item.key, { top, last: rows.length - 1 });
    }
  }
  return { rows, spans };
}

/** The first body row on screen: the remembered one, kept within the body. */
export function clampScroll(scroll: number, rows: number, height: number): number {
  return Math.max(0, Math.min(scroll, rows - height));
}

export function render(state: State, c: Paint): string[] {
  const { width, height } = state;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    const lines = Array.from({ length: Math.max(0, height) }, () => fit('', width));
    if (lines.length > 0) lines[0] = fit(`Brainyard needs at least ${MIN_WIDTH}×${MIN_HEIGHT}`, width);
    return lines;
  }
  const room = bodyHeight(state);
  const help = state.dialog?.kind === 'help';
  const body = help ? helpRows(c) : layout(state, c).rows;
  const top = help ? 0 : clampScroll(state.scroll, body.length, room);
  const visible = body.slice(top, top + room);
  while (visible.length < room) visible.push({ text: '' });
  return [
    fit(headerText(state, c), width),
    ...visible.map((row) => (row.selected ? c.inverse(fit(row.text, width)) : fit(row.text, width))),
    fit(` ${statusText(state, c)}`, width),
    fit(` ${c.dim(keysText(state))}`, width),
  ];
}

// ---------------------------------------------------------------------------
// header and sections
// ---------------------------------------------------------------------------
function folderName(state: State): string {
  return clean(tidyPaths(state.cwd));
}

function headerText(state: State, c: Paint): string {
  const left = `${c.bold('Brainyard')} ${c.dim(state.version)} ${c.dim('·')} ${folderName(state)}`;
  const panes = state.data.panes;
  if (!panes || panes.length === 0) return left;
  const memory = panes.reduce((sum, pane) => sum + (pane.memory ?? 0), 0);
  const right = c.dim(`${panes.length} pane${panes.length === 1 ? '' : 's'}${memory > 0 ? ` · ${bytes(memory)}` : ''}`);
  const gap = state.width - cells(left) - cells(right);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : left;
}

function headingText(id: SectionId, list: readonly Item[], state: State, c: Paint): string {
  const { data } = state;
  const error = (message: string | undefined) => (message ? c.yellow(` · ${clean(message)}`) : '');
  switch (id) {
    case 'agents':
      return `${c.bold(HEADINGS.agents)}${error(data.errors.status)}`;
    case 'panes':
      return `${c.bold(HEADINGS.panes)}${data.panes ? c.dim(` · ${list.length}`) : ''}${error(data.errors.panes)}`;
    case 'running':
      return `${c.bold(HEADINGS.running)}${c.dim(` · ${list.length}`)}${error(data.errors.live)}`;
    case 'sessions': {
      const head = `${c.bold(`${HEADINGS.sessions} ${folderName(state)}`)}${data.sessions ? c.dim(` · ${list.length}`) : ''}`;
      return `${head}${totals(state, c)}${error(data.errors.sessions ?? data.errors.usage)}`;
    }
  }
}

/** The folder's tokens and dollars, from the sessions whose counters were read. */
function totals(state: State, c: Paint): string {
  const counted = (state.data.usage ?? []).filter((entry) => entry.usage);
  if (counted.length === 0) return '';
  const input = counted.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0);
  const output = counted.reduce((sum, entry) => sum + (entry.usage?.outputTokens ?? 0), 0);
  const cache = counted.reduce((sum, entry) => sum + (entry.usage ? cached(entry.usage) : 0), 0);
  const priced = counted.filter((entry) => entry.costUsd !== null);
  const dollars = priced.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const unpriced = counted.length - priced.length;
  const cost = priced.length > 0 ? ` · ${money(dollars)}${unpriced > 0 ? ` + ${unpriced} unpriced` : ''}` : '';
  return c.dim(`${cost} · ${tokens(input)} in · ${tokens(output)} out${cache > 0 ? ` · ${tokens(cache)} cache` : ''}`);
}

function emptyText(id: SectionId, state: State, c: Paint): string {
  const { data } = state;
  switch (id) {
    case 'panes':
      if (data.tmux === false) {
        return c.dim(`panes need tmux${process.platform === 'darwin' ? ' · brew install tmux' : ''}`);
      }
      return c.dim(data.panes ? 'no panes · n starts one' : 'reading…');
    case 'sessions':
      return c.dim(data.sessions ? 'no sessions in this folder yet · n starts one' : 'reading…');
    default:
      return '';
  }
}

/** Each item's rows, in the order of the section's items. */
function sectionRows(id: SectionId, list: readonly Item[], state: State, c: Paint): string[][] {
  switch (id) {
    case 'agents':
      return list.map((item) => (item.kind === 'agent' ? agentRows(item.brain, state, c) : []));
    case 'panes':
      return paneRows(list, state, c).map((row) => [row]);
    case 'running': {
      const running = list.flatMap((item) => (item.kind === 'running' ? [item.session] : []));
      return sessionLines(
        running.map((session) => ({ ...session, ...(session.title ? { title: clean(session.title) } : {}) })),
        c,
        { folders: true, now: state.now },
      ).map((row) => [row]);
    }
    case 'sessions':
      return folderRows(list, state, c).map((row) => [row]);
  }
}

const LABEL_WIDTH = Math.max(...Object.values(BRAINS).map((brain) => brain.label.length));

function agentRows(brain: BrainId, state: State, c: Paint): string[] {
  const label = BRAINS[brain].label;
  const status = state.data.status?.brains.find((entry) => entry.id === brain);
  if (!status) return [`${c.dim('○')} ${pad(c.bold(label), LABEL_WIDTH)}  ${c.dim('checking…')}`];
  const [word, colour] = AVAILABILITY[status.availability];
  const tint = c[colour];
  const head = `${tint('●')} ${pad(c.bold(label), LABEL_WIDTH)}  ${pad(c.dim(status.version ?? '—'), 9)} ${pad(tint(word), 13)} ${clean(details(status, c))}`;
  if (status.availability === 'not_installed') return [head];
  const limits = limitRows(brain, state, c);
  return [head, ...limits.map((line, index) => `  ${index === 0 ? c.dim('limits') : '      '}  ${line}`)];
}

function limitRows(brain: BrainId, state: State, c: Paint): string[] {
  const { data } = state;
  const found = data.limits?.find((entry) => entry.brain === brain);
  if (!found) return [c.dim(data.errors.limits ? clean(data.errors.limits) : 'checking…')];
  return poolLines(found, c, state.now, whyNoLimits).map(clean);
}

/** The app makes no paid call on its own: Claude Code's windows come from `brainyard usage --live`. */
function whyNoLimits(brain: BrainUsage): string {
  if (brain.limitsUnavailable === 'not_requested') {
    return brain.brain === 'claude' ? 'not checked: brainyard usage --live (one tiny real call)' : 'not checked';
  }
  return brain.detail ?? (brain.limits ? 'no windows' : 'unknown');
}

function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(0, size - cells(text)));
}

/** What a pane's CLI does: attached, working, waiting for the person, or idle. */
function paneState(item: Extract<Item, { kind: 'pane' }>, c: Paint): string {
  if (item.pane.attached) return c.cyan('attached');
  const live = item.live?.live;
  if (!live) return '';
  if (live.status === 'busy') return c.cyan('working');
  if (live.status === 'waiting')
    return c.yellow(`waiting${live.waitingFor ? `: ${clip(clean(live.waitingFor), 30)}` : ''}`);
  if (live.status === 'idle') return c.green('idle');
  return c.dim(String(live.status));
}

/** Name, CLI, session, memory, state, how long it has been quiet, folder, label. */
function paneRows(list: readonly Item[], state: State, c: Paint): string[] {
  const cells = list.flatMap((item) => {
    if (item.kind !== 'pane') return [];
    const { pane } = item;
    const quiet = pane.activityAt ? ago(Date.parse(pane.activityAt), state.now) : '';
    return [
      [
        c.bold(clean(pane.pane)),
        pane.brain ? BRAINS[pane.brain].label : c.dim('?'),
        c.dim(pane.sessionId ? pane.sessionId.slice(0, 8) : '—'),
        pane.memory === undefined ? '' : bytes(pane.memory),
        paneState(item, c),
        quiet === 'now' ? c.green('active') : quiet ? c.dim(`quiet ${quiet}`) : '',
        pane.cwd ? shortPath(clean(tidyPaths(pane.cwd)), 40) : '',
        pane.label ? clip(clean(pane.label), 60) : '',
      ],
    ];
  });
  return table(cells, new Set([3]));
}

/** Cache reads and writes: most of what Claude Code takes in goes through its cache. */
function cached(usage: Usage): number {
  return usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** CLI, id, age, tokens in, out and through the cache, cost, then the title and what it does now. */
function folderRows(list: readonly Item[], state: State, c: Paint): string[] {
  // Only CLIs with a cache have the column: Claude Code, and Codex.
  const caching = list.some((item) => item.kind === 'session' && item.usage?.usage && cached(item.usage.usage) > 0);
  const cells = list.flatMap((item) => {
    if (item.kind !== 'session') return [];
    const { session, usage } = item;
    const when = session.updatedAt ?? session.startedAt;
    const counters = usage?.usage;
    let cost = '';
    if (counters) cost = usage.costUsd === null ? c.dim('no price') : money(usage.costUsd);
    return [
      [
        BRAINS[session.brain].label,
        c.dim(session.id.slice(0, 8)),
        when ? ago(Date.parse(when), state.now) : '',
        counters ? `${tokens(counters.inputTokens)} in` : '',
        counters ? `${tokens(counters.outputTokens)} out` : '',
        ...(caching ? [counters && cached(counters) > 0 ? `${tokens(cached(counters))} cache` : ''] : []),
        cost,
        `${titleOf(session, c)}${liveMark(session, c)}${item.pane ? c.dim(` ▣ ${item.pane}`) : ''}`,
      ],
    ];
  });
  return table(cells, new Set(caching ? [3, 4, 5, 6] : [3, 4, 5]));
}

function titleOf(session: SessionInfo, c: Paint): string {
  const tags = [session.background ? 'bg' : '', session.interactive ? '' : 'headless']
    .filter(Boolean)
    .map((tag) => c.dim(` ${tag}`))
    .join('');
  return `${session.title ? clip(clean(session.title), 60) : c.dim('(untitled)')}${tags}`;
}

// ---------------------------------------------------------------------------
// the two lines below the body
// ---------------------------------------------------------------------------
function statusText(state: State, c: Paint): string {
  const { dialog } = state;
  if (dialog?.kind === 'new') {
    const choices = newChoices(state)
      .map((brain) => {
        const label = BRAINS[brain].label;
        return brain === dialog.brain ? c.inverse(`[${label}]`) : ` ${label} `;
      })
      .join(' ');
    return `${c.bold('New pane')} in ${folderName(state)}:  ${choices}`;
  }
  if (dialog?.kind === 'confirm') return c.yellow(dialog.question);
  if (state.busy) return c.cyan(state.busy);
  const note = state.note;
  if (!note) return '';
  const text = clean(note.text);
  return note.tone === 'error' ? c.red(text) : note.tone === 'ok' ? c.green(text) : text;
}

/** The CLIs a new pane can run: all but the ones known not to be installed. */
export function newChoices(state: State): BrainId[] {
  const known = state.data.status?.brains;
  if (!known) return Object.keys(BRAINS) as BrainId[];
  return known.filter((brain) => brain.availability !== 'not_installed').map((brain) => brain.id);
}

function keysText(state: State): string {
  const { dialog } = state;
  if (dialog?.kind === 'new') return '←→ choose · Enter start · Esc cancel';
  if (dialog?.kind === 'confirm') return 'y yes · any other key no';
  if (dialog?.kind === 'help') return 'any key — back';
  const tail = 'n new · ? help · q quit';
  const item = focus(state).item;
  switch (item?.kind) {
    case 'agent':
      return `Enter new ${BRAINS[item.brain].label} pane · ${tail}`;
    case 'pane':
      return `Enter go in (Ctrl+Q back) · x close · ${tail}`;
    case 'session': {
      if (item.pane) return `Enter go in (Ctrl+Q back) · x close the pane · ${tail}`;
      if (item.session.live) return stoppable(item.session) ? `s stop · ${tail}` : tail;
      return `Enter or r continue in a pane · ${tail}`;
    }
    case 'running':
      return stoppable(item.session) ? `s stop · ${tail}` : tail;
    default:
      return tail;
  }
}

const HELP: [keys: string, what: string][] = [
  ['↑ ↓  j k', 'move; PgUp PgDn, Home End'],
  ['Tab  Shift+Tab', 'the next or the previous section'],
  ['Enter', 'into the pane, full screen; Ctrl+Q — back here'],
  ['', 'on an agent — a new pane of it; on a saved session — continue it'],
  ['n', 'a new pane in this folder: choose the CLI'],
  ['x', 'close the pane: its CLI ends, the conversation stays'],
  ['s', 'stop a Claude Code background session: the conversation stays'],
  ['r', 'continue a saved session in a new pane'],
  ['Ctrl+L', 'read everything again'],
  ['q  Ctrl+C', 'quit: the panes keep running'],
];

function helpRows(c: Paint): Row[] {
  const rows: Row[] = [{ text: '' }, { text: c.bold('Keys') }];
  for (const [keys, what] of HELP) rows.push({ text: `  ${pad(keys, 16)} ${what}` });
  rows.push(
    { text: '' },
    { text: c.dim('  Panes are CLI sessions in tmux (tmux -L brainyard): they outlive this app and this terminal.') },
    { text: c.dim('  Limits come without a paid call; Claude Code shows its own with brainyard usage --live.') },
  );
  return rows;
}

/** A colourless palette: where rows are, not how they look. */
export const PLAIN = palette(false);
