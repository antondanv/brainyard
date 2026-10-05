/**
 * The screen as a pure function of the state: `render(state, paint)` gives
 * exactly `state.height` rows of exactly `state.width` cells. A terminal
 * writes them as they are; a browser can draw the same rows.
 *
 * A header with the pages as tabs; the page's body (the overview scrolls,
 * overview.ts; the wall, sessions, usage and settings are pages.ts); a line
 * for a question or a note; a line of keys. All of it in the app's language.
 */
import { BRAINS, type BrainId } from '@antondanv/brainyard';

import { bytes } from '../format.js';
import { type Paint, palette } from '../term.js';
import { count, type Translate } from './i18n.js';
import { type Layout, overviewLayout } from './overview.js';
import { type Row, sessionsRows, settingsRows, usageRows, wallPages, wallRows } from './pages.js';
import { folderName, pad, type Span } from './parts.js';
import { PAGE_NAMES, PAGES, type Page } from './settings.js';
import { focus, listFocus, type State, stoppable, tr, waitingIds } from './state.js';
import { cells, clean, fit } from './text.js';
import { tiles } from './wall.js';

export type { Row } from './pages.js';

/** Below this the app says so instead of drawing a broken screen. */
export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 8;
/** The header above the body and the two lines below it. */
const CHROME = 3;

export function bodyHeight(state: State): number {
  return Math.max(1, state.height - CHROME);
}

/** The overview's body and where its items are: what `update()` scrolls by. */
export function layout(state: State, c: Paint): Layout {
  return overviewLayout(state, c);
}

/** The first body row on screen: the remembered one, kept within the body. */
export function clampScroll(scroll: number, rows: number, height: number): number {
  return Math.max(0, Math.min(scroll, rows - height));
}

/** The body rows of the page on screen, before scrolling. */
function bodyRows(state: State, c: Paint, room: number): { rows: Row[]; scrolls: boolean } {
  if (state.dialog?.kind === 'help') return { rows: helpRows(state, c), scrolls: false };
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
  const t = tr(state);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    const lines = Array.from({ length: Math.max(0, height) }, () => fit('', width));
    if (lines.length > 0)
      lines[0] = fit(t('Brainyard needs at least {size}', { size: `${MIN_WIDTH}×${MIN_HEIGHT}` }), width);
    return lines;
  }
  const room = bodyHeight(state);
  const { rows, scrolls } = bodyRows(state, c, room);
  const top = scrolls ? clampScroll(state.scroll, rows.length, room) : 0;
  const visible = rows.slice(top, top + room);
  while (visible.length < room) visible.push({ text: '' });
  return [
    fit(headerText(state, c, t), width),
    ...visible.map((row) => fit(row.text, width)),
    fit(` ${statusText(state, c, t)}`, width),
    fit(` ${keysText(state, c, t)}`, width),
  ];
}

// ---------------------------------------------------------------------------
// the header
// ---------------------------------------------------------------------------
const TABS = PAGE_NAMES;

/** The name and the pages as tabs, and where each tab is; a narrow screen names only the open page. */
function headerLeft(state: State, c: Paint, t: Translate): { text: string; tabs: Span<Page>[] } {
  const tab = (page: Page, index: number, short: boolean) => {
    const name = short && page !== state.page ? `${index + 1}` : `${index + 1} ${t(TABS[page])}`;
    return page === state.page ? c.accent(c.bold(`[${name}]`)) : c.dim(` ${name} `);
  };
  const build = (short: boolean) => {
    let text = short ? `${c.bold('Brainyard')}  ` : `${c.bold('Brainyard')} ${c.dim(state.version)}  `;
    const tabs: Span<Page>[] = [];
    for (const [index, page] of PAGES.entries()) {
      if (index > 0 && !short) text += ' ';
      const from = cells(text);
      text += tab(page, index, short);
      tabs.push({ value: page, from, to: cells(text) });
    }
    return { text, tabs };
  };
  const full = build(false);
  return cells(full.text) > state.width - 2 ? build(true) : full;
}

/** The tab at this cell of the header: what a click opens. */
export function tabAt(state: State, x: number): Page | undefined {
  return headerLeft(state, PLAIN, tr(state)).tabs.find((span) => x >= span.from && x < span.to)?.value;
}

/** The name, the pages as tabs (digits open them), and on the right who waits and what the panes cost. */
function headerText(state: State, c: Paint, t: Translate): string {
  const left = headerLeft(state, c, t).text;
  const waiting = waitingIds(state.data.live).size;
  const panes = state.data.panes ?? [];
  const memory = panes.reduce((sum, pane) => sum + (pane.memory ?? 0), 0);
  const alert = waiting > 0 ? c.yellow(`⚠ ${count(t, waiting, 'waiting')}`) : '';
  const many = panes.length > 0 ? count(t, panes.length, 'pane') : '';
  // What does not fit goes, the memory first.
  const options = [
    [alert, c.dim([many, memory > 0 ? bytes(memory) : ''].filter(Boolean).join(' · '))],
    [alert, c.dim(many)],
    [alert],
  ];
  for (const parts of options) {
    const right = parts.filter((part) => cells(part) > 0).join(c.dim(' · '));
    if (!right) return left;
    const gap = state.width - cells(left) - cells(right);
    if (gap >= 2) return `${left}${' '.repeat(gap)}${right}`;
  }
  return left;
}

// ---------------------------------------------------------------------------
// the two lines below the body
// ---------------------------------------------------------------------------
function statusText(state: State, c: Paint, t: Translate): string {
  const { dialog } = state;
  if (dialog?.kind === 'new') return newLine(state, dialog.brain, c, t).text;
  if (dialog?.kind === 'confirm') return c.yellow(dialog.question);
  if (state.busy) return c.cyan(state.busy);
  const note = state.note;
  if (!note) return '';
  const text = clean(note.text);
  return note.tone === 'error' ? c.red(text) : note.tone === 'ok' ? c.green(text) : text;
}

/** The question of the new pane dialog with the CLIs to choose from, and where each is on its row. */
function newLine(state: State, chosen: BrainId, c: Paint, t: Translate): { text: string; choices: Span<BrainId>[] } {
  let text = `${c.bold(t('New pane'))} ${t('in {folder}', { folder: folderName(state) })}:  `;
  const choices: Span<BrainId>[] = [];
  for (const [index, brain] of newChoices(state).entries()) {
    if (index > 0) text += ' ';
    const label = BRAINS[brain].label;
    // The row starts one cell in.
    const from = cells(text) + 1;
    text += brain === chosen ? c.accent(c.bold(`[${label}]`)) : ` ${label} `;
    choices.push({ value: brain, from, to: cells(text) + 1 });
  }
  return { text, choices };
}

/** The CLI at this cell of the new pane dialog's row: what a click starts. */
export function choiceAt(state: State, x: number): BrainId | undefined {
  if (state.dialog?.kind !== 'new') return undefined;
  const { choices } = newLine(state, state.dialog.brain, PLAIN, tr(state));
  return choices.find((span) => x >= span.from && x < span.to)?.value;
}

/** The CLIs a new pane can run: all but the ones known not to be installed. */
export function newChoices(state: State): BrainId[] {
  const known = state.data.status?.brains;
  if (!known) return Object.keys(BRAINS) as BrainId[];
  return known.filter((brain) => brain.availability !== 'not_installed').map((brain) => brain.id);
}

/** Keys and what they do: the key bright, the words dim. */
function hints(c: Paint, list: readonly (readonly [key: string, what: string])[]): string {
  return list.map(([key, what]) => (what ? `${c.accent(key)} ${c.dim(what)}` : c.dim(key))).join(c.dim(' · '));
}

function overviewKeys(state: State, t: Translate): [string, string][] {
  const item = focus(state).item;
  switch (item?.kind) {
    case 'agent':
      return [['Enter', t('new {brain} pane', { brain: BRAINS[item.brain].label })]];
    case 'pane':
      return [
        ['Enter', t('go in (Ctrl+Q back)')],
        ['x', t('close')],
      ];
    case 'session':
      if (item.pane) {
        return [
          ['Enter', t('go in (Ctrl+Q back)')],
          ['x', t('close the pane')],
        ];
      }
      if (item.session.live) return stoppable(item.session) ? [['s', t('stop')]] : [];
      return [['Enter', t('continue in a pane')]];
    case 'running':
      return stoppable(item.session) ? [['s', t('stop')]] : [];
    default:
      return [];
  }
}

function keysText(state: State, c: Paint, t: Translate): string {
  const { dialog } = state;
  if (dialog?.kind === 'new') {
    return hints(c, [
      ['←→', t('choose')],
      ['Enter', t('start')],
      ['Esc', t('cancel')],
    ]);
  }
  if (dialog?.kind === 'confirm') {
    return hints(c, [
      ['y', t('yes')],
      [t('any other key'), t('no')],
    ]);
  }
  if (dialog?.kind === 'help') return hints(c, [[t('any key'), t('back')]]);
  const tail: [string, string][] = [
    ['n', t('new')],
    ['?', t('help')],
    ['q', t('quit')],
  ];
  switch (state.page) {
    case 'overview':
      return hints(c, [...overviewKeys(state, t), ...tail]);
    case 'wall': {
      if (state.wall.typing)
        return hints(c, [
          [t('typing into the tile: every key goes to its CLI'), ''],
          ['Ctrl+Q', t('back')],
        ]);
      const room = bodyHeight(state);
      if (tiles(state, state.width, room).length === 0) return hints(c, tail);
      const more = wallPages(state, state.width, room);
      return hints(c, [
        ['←→↑↓', t('focus')],
        ['i', t('type')],
        ['Enter', t('full screen')],
        ['z', state.wall.zoom ? t('all tiles') : t('zoom')],
        ['l', t(state.wall.layout)],
        ['x', t('close')],
        ...(more ? ([['PgDn', more]] as [string, string][]) : []),
        ...tail,
      ]);
    }
    case 'sessions': {
      if (state.list.editing) {
        return hints(c, [
          [t('type to filter'), ''],
          ['Enter', t('keep it')],
          ['Esc', t('clear it')],
        ]);
      }
      const item = listFocus(state).item;
      const act: [string, string][] = [];
      if (item?.kind === 'session' && item.pane) {
        act.push(['Enter', t('go in')], ['x', t('close the pane')]);
      } else if (item && (item.kind === 'session' || item.kind === 'running') && item.session.live) {
        if (stoppable(item.session)) act.push(['s', t('stop')]);
      } else if (item) act.push(['Enter', t('continue in a pane')]);
      return hints(c, [['↑↓', t('move')], ...act, ['/', t('filter')], ...tail]);
    }
    case 'usage':
      return hints(c, tail);
    case 'settings':
      return hints(c, [['↑↓', t('choose')], ['←→', t('change, kept at once')], ...tail]);
  }
}

/** The help: keys by page. Headings are rows with keys and no words. */
export const HELP: [keys: string, what: string][] = [
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
  ['Settings', '↑↓ choose, ←→ change: language, theme, accent, layout, bell, first page'],
  ['', ''],
  ['Click  wheel', 'in a browser: a click selects, a double click is Enter, the wheel moves'],
  ['Ctrl+L', 'read everything again'],
  ['q  Ctrl+C', 'quit: the panes keep running'],
];

function helpRows(state: State, c: Paint): Row[] {
  const t = tr(state);
  const rows: Row[] = [{ text: '' }, { text: c.accent(c.bold(t('Keys'))) }];
  for (const [keys, what] of HELP) {
    // A page's name heads its keys; keys stay as they are, but for the mouse's words.
    const name = t(keys);
    rows.push({ text: what ? `  ${pad(c.accent(name), 16)} ${t(what)}` : keys ? `  ${c.bold(name)}` : '' });
  }
  rows.push(
    { text: '' },
    {
      text: c.dim(
        `  ${t('Panes are CLI sessions in tmux (tmux -L brainyard): they outlive this app and this terminal.')}`,
      ),
    },
    { text: c.dim(`  ${t('Limits come without a paid call: Claude Code’s are the ones its /usage fetched last.')}`) },
  );
  return rows;
}

/** A colourless palette: where rows are, not how they look. */
export const PLAIN = palette(false);
