/**
 * The screen as a pure function of the state: `render(state, paint)` gives
 * exactly `state.height` rows of exactly `state.width` cells. A terminal
 * writes them as they are; a browser can draw the same rows.
 *
 * A header with the pages as tabs; the page's body (the overview scrolls;
 * the wall, sessions, usage and settings are pages.ts); a line for a
 * question or a note; a line of keys.
 */
import { BRAINS, type BrainId, clip, tidyPaths } from '@antondanv/brainyard';

import { ago, bytes, money, shortPath, tokens } from '../format.js';
import { liveMark, sessionLines } from '../sessions.js';
import { AVAILABILITY, details } from '../status.js';
import { type Paint, palette, table } from '../term.js';
import { poolLines } from '../usage.js';
import { type Row, sessionsRows, settingsRows, usageRows, wallPages, wallRows } from './pages.js';
import { cached, folderName, LABEL_WIDTH, pad, paneState, titleOf, whyNoLimits } from './parts.js';
import { PAGES, type Page } from './settings.js';
import { focus, type Item, listFocus, type SectionId, type State, sections, stoppable, waitingIds } from './state.js';
import { cells, clean, fit } from './text.js';
import { tiles } from './wall.js';

export type { Row } from './pages.js';

/** Below this the app says so instead of drawing a broken screen. */
export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 8;
/** The header above the body and the two lines below it. */
const CHROME = 3;

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

/** The body rows of the page on screen, before scrolling. */
function bodyRows(state: State, c: Paint, room: number): { rows: Row[]; scrolls: boolean } {
  if (state.dialog?.kind === 'help') return { rows: helpRows(c), scrolls: false };
  switch (state.page) {
    case 'overview':
      return { rows: layout(state, c).rows, scrolls: true };
    case 'wall':
      return { rows: wallRows(state, c, state.width, room), scrolls: false };
    case 'sessions':
      return { rows: sessionsRows(state, c, state.width, room), scrolls: false };
    case 'usage':
      return { rows: usageRows(state, c), scrolls: false };
    case 'settings':
      return { rows: settingsRows(state, c), scrolls: false };
  }
}

export function render(state: State, c: Paint): string[] {
  const { width, height } = state;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    const lines = Array.from({ length: Math.max(0, height) }, () => fit('', width));
    if (lines.length > 0) lines[0] = fit(`Brainyard needs at least ${MIN_WIDTH}×${MIN_HEIGHT}`, width);
    return lines;
  }
  const room = bodyHeight(state);
  const { rows, scrolls } = bodyRows(state, c, room);
  const top = scrolls ? clampScroll(state.scroll, rows.length, room) : 0;
  const visible = rows.slice(top, top + room);
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
const TABS: Record<Page, string> = {
  overview: 'Overview',
  wall: 'Wall',
  sessions: 'Sessions',
  usage: 'Usage',
  settings: 'Settings',
};

/** The name, the pages as tabs (digits open them), and on the right who waits and what the panes cost. */
function headerText(state: State, c: Paint): string {
  const tab = (page: Page, index: number, short: boolean) => {
    const name = short && page !== state.page ? `${index + 1}` : `${index + 1} ${TABS[page]}`;
    return page === state.page ? c.accent(c.bold(`[${name}]`)) : c.dim(` ${name} `);
  };
  // A narrow screen names only the open page; the others keep their digits.
  let left = `${c.bold('Brainyard')} ${c.dim(state.version)}  ${PAGES.map((page, index) => tab(page, index, false)).join(' ')}`;
  if (cells(left) > state.width - 2)
    left = `${c.bold('Brainyard')}  ${PAGES.map((page, index) => tab(page, index, true)).join('')}`;
  const waiting = waitingIds(state.data.live).size;
  const panes = state.data.panes ?? [];
  const memory = panes.reduce((sum, pane) => sum + (pane.memory ?? 0), 0);
  const count = panes.length > 0 ? `${panes.length} pane${panes.length === 1 ? '' : 's'}` : '';
  const alert = waiting > 0 ? c.yellow(`⚠ ${waiting} waiting`) : '';
  // What does not fit goes, the cost of the panes first.
  const options = [
    [alert, c.dim([count, memory > 0 ? bytes(memory) : ''].filter(Boolean).join(' · '))],
    [alert, c.dim(count)],
    [alert],
  ];
  for (const parts of options) {
    const right = parts.filter((part) => cells(part) > 0).join(c.dim(' · '));
    const gap = state.width - cells(left) - cells(right);
    if (!right) return left;
    if (gap >= 2) return `${left}${' '.repeat(gap)}${right}`;
  }
  return left;
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
        paneState(item.pane.attached, item.live, c),
        quiet === 'now' ? c.green('active') : quiet ? c.dim(`quiet ${quiet}`) : '',
        pane.cwd ? shortPath(clean(tidyPaths(pane.cwd)), 40) : '',
        pane.label ? clip(clean(pane.label), 60) : '',
      ],
    ];
  });
  return table(cells, new Set([3]));
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

function overviewKeys(state: State, tail: string): string {
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

function keysText(state: State): string {
  const { dialog } = state;
  if (dialog?.kind === 'new') return '←→ choose · Enter start · Esc cancel';
  if (dialog?.kind === 'confirm') return 'y yes · any other key no';
  if (dialog?.kind === 'help') return 'any key — back';
  const tail = 'n new · ? help · q quit';
  switch (state.page) {
    case 'overview':
      return overviewKeys(state, tail);
    case 'wall': {
      if (state.wall.typing) return 'typing into the tile: every key goes to its CLI · Ctrl+Q back';
      const room = bodyHeight(state);
      if (tiles(state, state.width, room).length === 0) return tail;
      const more = wallPages(state, state.width, room);
      const zoom = state.wall.zoom ? 'z all tiles' : 'z zoom';
      return `←→↑↓ focus · i type · Enter full screen · ${zoom} · l ${state.wall.layout} · x close${more ? ` · PgDn ${more}` : ''} · ${tail}`;
    }
    case 'sessions': {
      if (state.list.editing) return 'type to filter · Enter keep it · Esc clear it';
      const item = listFocus(state).item;
      let act = '';
      if (item?.kind === 'session' && item.pane) act = 'Enter go in · x close the pane · ';
      else if (item && (item.kind === 'session' || item.kind === 'running') && item.session.live) {
        act = stoppable(item.session) ? 's stop · ' : '';
      } else if (item) act = 'Enter or r continue in a pane · ';
      return `↑↓ move · ${act}/ filter · ${tail}`;
    }
    case 'usage':
      return tail;
    case 'settings':
      return `↑↓ choose · ←→ change, kept at once · ${tail}`;
  }
}

const HELP: [keys: string, what: string][] = [
  ['1–5  [ ]', 'pages: overview, wall, sessions, usage, settings'],
  ['', ''],
  ['Overview', ''],
  ['↑ ↓  j k  Tab', 'move · the next section; PgUp PgDn, Home End'],
  ['Enter', 'into the pane, full screen; Ctrl+Q — back'],
  ['', 'on an agent — a new pane; on a saved session — continue it'],
  ['n  x', 'a new pane · close the pane (the conversation stays)'],
  ['s  r', 'stop a background session · continue a session in a pane'],
  ['', ''],
  ['Wall', "the panes' live screens side by side"],
  ['←→↑↓  Tab', 'the tile in focus'],
  ['i', 'type into it: every key goes to its CLI until Ctrl+Q'],
  ['Enter', 'full screen; Ctrl+Q — back to the wall'],
  ['z  l  PgDn', 'zoom the tile · grid, main and stack, columns · more panes'],
  ['n  x', "a new tile, ready to type into · close the tile's pane"],
  ['', ''],
  ['Sessions', '/ filters; Enter or r continues, s stops, x closes its pane'],
  ['Settings', '↑↓ choose, ←→ change: theme, accent, layout, bell, first page'],
  ['', ''],
  ['Ctrl+L', 'read everything again'],
  ['q  Ctrl+C', 'quit: the panes keep running'],
];

function helpRows(c: Paint): Row[] {
  const rows: Row[] = [{ text: '' }, { text: c.bold('Keys') }];
  for (const [keys, what] of HELP)
    rows.push({ text: what ? `  ${pad(keys, 16)} ${what}` : keys ? `  ${c.bold(keys)}` : '' });
  rows.push(
    { text: '' },
    { text: c.dim('  Panes are CLI sessions in tmux (tmux -L brainyard): they outlive this app and this terminal.') },
    { text: c.dim('  Limits come without a paid call; Claude Code shows its own with brainyard usage --live.') },
  );
  return rows;
}

/** A colourless palette: where rows are, not how they look. */
export const PLAIN = palette(false);
