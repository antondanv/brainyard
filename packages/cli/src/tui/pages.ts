/**
 * The pages besides the overview, each a pure function of the state: the
 * wall of live tiles, the sessions with a card for the selected one, usage
 * with bars, and the settings with a preview of the theme.
 */
import {
  BRAINS,
  type BrainId,
  clip,
  type LimitWindow,
  type SessionInfo,
  type SessionUsage,
  tidyPaths,
} from '@antondanv/brainyard';

import { ago, bytes, money, shortPath, tokens, until, windowName } from '../format.js';
import { liveMark, sessionLines } from '../sessions.js';
import { type Paint, table } from '../term.js';
import { cached, folderName, LABEL_WIDTH, liveById, pad, paneState, titleOf, whyNoLimits } from './parts.js';
import { ACCENT_NAMES, LAYOUTS, PAGES, type Settings, THEME_NAMES } from './settings.js';
import { type Item, listFocus, listItems, type State, stoppable } from './state.js';
import { cells, clean, fit, invertCell } from './text.js';
import { focusedTile, type Tile, tiles, wallPage } from './wall.js';

export interface Row {
  text: string;
  /** The first row of the selected item: drawn inverted. */
  selected?: boolean;
}

const RESET = '\u001b[0m';

// ---------------------------------------------------------------------------
// the wall
// ---------------------------------------------------------------------------

/** A tile's top or bottom: corners, a title on the left, a note on the right; exactly `width` cells. */
function border(
  width: number,
  [open, close]: [string, string],
  left: string,
  right: string,
  tint: (text: string) => string,
): string {
  const room = Math.max(0, width - 4);
  let tail = right ? ` ${right} ` : '';
  if (cells(tail) > room) tail = '';
  let head = left ? ` ${left} ` : '';
  // At least one rule between the title and the note; a title too long is cut.
  const space = room - cells(tail) - (tail && head ? 1 : 0);
  if (cells(head) > space) head = space > 3 ? `${fit(head.trimEnd(), space - 1)} ` : '';
  const fill = Math.max(0, room - cells(head) - cells(tail));
  return `${tint(`${open}─`)}${head}${tint('─'.repeat(fill))}${tail}${tint(`─${close}`)}`;
}

/** One tile: its box, the CLI's screen inside, the cursor where the person types. */
function tileLines(tile: Tile, state: State, c: Paint, focused: boolean): string[] {
  const { pane } = tile;
  const inner = { width: Math.max(0, tile.width - 2), height: Math.max(0, tile.height - 2) };
  const live = pane.sessionId ? liveById(state).get(pane.sessionId) : undefined;
  const waiting = live?.live?.status === 'waiting';
  const typing = focused && state.wall.typing;
  const tint = typing ? c.magenta : focused ? c.accent : waiting ? c.yellow : c.gray;
  const label = pane.brain ? BRAINS[pane.brain].label : '?';
  const name = clean(pane.label || live?.title || '');
  const left = `${focused ? c.bold(label) : label}${name ? c.dim(` · ${clip(name, 80)}`) : ''}`;
  const right = [paneState(pane.attached, live, c), pane.memory === undefined ? '' : c.dim(bytes(pane.memory))]
    .filter(Boolean)
    .join(c.dim(' · '));
  const screen = state.data.screens?.[pane.pane];
  const lines = [border(tile.width, ['╭', '╮'], left, right, tint)];
  for (let row = 0; row < inner.height; row++) {
    let text = screen ? clean(screen.lines[row] ?? '') : row === 0 ? c.dim('reading the screen…') : '';
    if (typing && screen?.cursor.visible && screen.cursor.y === row) text = invertCell(text, screen.cursor.x);
    const content = fit(text, inner.width);
    // The CLI's own colours end inside its tile.
    lines.push(`${tint('│')}${content}${content.includes('\u001b') ? RESET : ''}${tint('│')}`);
  }
  const quiet = pane.activityAt ? ago(Date.parse(pane.activityAt), state.now) : '';
  let hint = quiet === 'now' ? c.green('active') : quiet ? c.dim(`quiet ${quiet}`) : '';
  if (focused) hint = 'i type · Enter full screen';
  if (typing) hint = c.magenta('✎ typing · Ctrl+Q back');
  lines.push(border(tile.width, ['╰', '╯'], hint, c.dim(clean(pane.pane)), tint));
  return lines;
}

/** The wall: exactly `height` rows of tiles side by side. */
export function wallRows(state: State, c: Paint, width: number, height: number): Row[] {
  const rows: Row[] = [];
  if (state.data.tmux === false) {
    rows.push({ text: '' }, { text: `  ${c.dim('panes need tmux: the wall shows their screens')}` });
  } else {
    const list = tiles(state, width, height);
    if (list.length === 0) {
      rows.push(
        { text: '' },
        { text: `  ${c.dim(state.data.panes ? 'no panes yet · n starts one here' : 'reading…')}` },
      );
    } else {
      const focus = focusedTile(list, state.wall.focus);
      const parts = Array.from({ length: height }, () => [] as { x: number; text: string }[]);
      for (const tile of list) {
        for (const [index, line] of tileLines(tile, state, c, tile === focus).entries()) {
          parts[tile.y + index]?.push({ x: tile.x, text: line });
        }
      }
      return parts.map((row) => ({
        text: row
          .sort((a, b) => a.x - b.x)
          .map((part) => part.text)
          .join(''),
      }));
    }
  }
  while (rows.length < height) rows.push({ text: '' });
  return rows;
}

/** `screen 1/2` when more panes than tiles fit. */
export function wallPages(state: State, width: number, height: number): string {
  const { page, pages } = wallPage(state, width, height);
  return pages > 1 ? `screen ${page + 1}/${pages}` : '';
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/** How the CLI itself continues a session, for a terminal elsewhere. */
export function resumeCommand(session: SessionInfo): string {
  const how: Record<BrainId, string> = {
    claude: `claude --resume ${session.id}`,
    codex: `codex resume ${session.id}`,
    antigravity: `agy --conversation ${session.id}`,
    opencode: `opencode --session ${session.id}`,
  };
  return how[session.brain];
}

function when(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const age = ago(Date.parse(iso), now);
  return age === 'now' ? 'now' : `${age} ago`;
}

/** The selected session in full: where, when, what it does, what it used, how to go on with it. */
function card(item: Item | undefined, state: State, c: Paint, width: number): string[] {
  if (!item || (item.kind !== 'session' && item.kind !== 'running')) return [c.dim('nothing selected')];
  const { session } = item;
  const usage = item.kind === 'session' ? item.usage : undefined;
  const pane = item.kind === 'session' ? item.pane : undefined;
  const field = (name: string, value: string) => `${c.dim(pad(name, 9))}${value}`;
  const lines = [
    c.bold(clip(clean(session.title ?? '(untitled)'), width)),
    `${BRAINS[session.brain].label} ${c.dim(session.id)}`,
    '',
    field('folder', session.cwd ? shortPath(clean(tidyPaths(session.cwd)), Math.max(10, width - 9)) : '?'),
    field('started', when(session.startedAt, state.now)),
    field('updated', when(session.updatedAt, state.now)),
    field('now', `${liveMark(session, c).trim() || c.dim('saved')}${pane ? c.dim(` ▣ ${pane}`) : ''}`),
  ];
  const counters = usage?.usage;
  if (counters) {
    const cache = cached(counters);
    lines.push(
      field(
        'tokens',
        `${tokens(counters.inputTokens)} in · ${tokens(counters.outputTokens)} out${cache ? ` · ${tokens(cache)} cache` : ''}`,
      ),
      field('cost', usage.costUsd === null ? c.dim('no price') : money(usage.costUsd)),
    );
    for (const model of usage.byModel.slice(0, 4)) {
      const used = model.usage.inputTokens + model.usage.outputTokens + cached(model.usage);
      const cost = model.costUsd === null ? '' : ` · ${money(model.costUsd)}`;
      lines.push(field('', c.dim(`${clip(model.model ?? 'unknown model', 30)} ${tokens(used)}${cost}`)));
    }
  }
  lines.push('');
  if (pane) lines.push(`${c.accent('Enter')} into its pane · ${c.accent('x')} close the pane`);
  else if (session.live) {
    lines.push(
      stoppable(session) ? `${c.accent('s')} stop it: the conversation stays` : c.dim('open in another terminal'),
    );
  } else lines.push(`${c.accent('Enter')} or ${c.accent('r')} continue it in a pane`);
  lines.push(c.dim(resumeCommand(session)));
  return lines;
}

/** First visible row of the sessions list: the selected one stays on screen. */
export function listScroll(state: State, rows: number): number {
  const list = listItems(state);
  const { index } = listFocus(state, list);
  let scroll = Math.max(0, Math.min(state.list.scroll, Math.max(0, list.length - rows)));
  if (index < scroll) scroll = index;
  if (index >= scroll + rows) scroll = index - rows + 1;
  return scroll;
}

/** The sessions page: a filtered list on the left, the selected one's card on the right. */
export function sessionsRows(state: State, c: Paint, width: number, height: number): Row[] {
  const list = listItems(state);
  const { item: selected } = listFocus(state, list);
  const side = width >= 100 ? Math.min(64, Math.floor(width * 0.42)) : 0;
  const left = side ? width - side - 3 : width;
  const { filter, editing } = state.list;
  const search =
    editing || filter ? `  ${c.accent('/')} ${clean(filter)}${editing ? c.accent('▏') : ''}` : c.dim('  / filter');
  const rows: Row[] = [{ text: '' }, { text: `${c.bold('Sessions')}${c.dim(` · ${list.length}`)}${search}` }];
  const room = Math.max(1, height - rows.length);
  const paneOf = new Map(
    list.flatMap((item) => (item.kind === 'session' && item.pane ? [[item.session.id, item.pane] as const] : [])),
  );
  const sessions = list.flatMap((item) => (item.kind === 'session' || item.kind === 'running' ? [item.session] : []));
  const lines = sessionLines(
    sessions.map((session) => ({ ...session, ...(session.title ? { title: clean(session.title) } : {}) })),
    c,
    { folders: true, panes: paneOf, now: state.now },
  );
  const scroll = listScroll(state, room);
  const shown = list.slice(scroll, scroll + room);
  const details = side ? card(selected, state, c, side) : [];
  for (let row = 0; row < room; row++) {
    const item = shown[row];
    let text = '';
    if (item) {
      const mark = item.key === selected?.key;
      const line = fit(`${mark ? '›' : ' '} ${lines[scroll + row] ?? ''}`, left);
      text = mark ? c.inverse(line) : line;
    } else if (row === 0 && list.length === 0) {
      text = fit(`  ${c.dim(filter ? 'nothing fits the filter · Esc clears it' : 'no sessions yet')}`, left);
    } else text = ' '.repeat(left);
    if (side) text += ` ${c.gray('│')} ${fit(details[row] ?? '', side)}`;
    rows.push({ text });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** How much of a window is used, in eighths of a cell: green, yellow from 70%, red from 90%. */
export function bar(fraction: number, width: number, c: Paint): string {
  const used = Math.min(1, Math.max(0, fraction)) * width;
  const full = Math.floor(used);
  const part = full < width ? (EIGHTHS[Math.floor((used - full) * 8)] ?? '') : '';
  const tint = fraction >= 0.9 ? c.red : fraction >= 0.7 ? c.yellow : c.green;
  return `${tint(`${'█'.repeat(full)}${part}`)}${c.dim('░'.repeat(width - full - (part ? 1 : 0)))}`;
}

function windowCells(limit: LimitWindow, c: Paint, now: number): string[] {
  const used = Math.round(limit.utilization * 100);
  let resets = '';
  if (limit.resetsAt) {
    const left = until(limit.resetsAt * 1000, now);
    resets = c.dim(left === 'now' ? 'resetting' : `resets in ${left}`);
  }
  return [windowName(limit), bar(limit.utilization, 24, c), `${used}%`, resets];
}

/** The usage page: every subscription window as a bar, then what this folder's sessions used. */
export function usageRows(state: State, c: Paint): Row[] {
  const { data } = state;
  const rows: Row[] = [{ text: '' }, { text: c.bold('Subscription limits') }];
  const order = data.status?.brains.map((brain) => brain.id) ?? (Object.keys(BRAINS) as BrainId[]);
  const cellsOf: string[][] = [];
  const notes: [number, string][] = [];
  for (const brain of order) {
    const label = BRAINS[brain].label;
    const status = data.status?.brains.find((entry) => entry.id === brain);
    const found = data.limits?.find((entry) => entry.brain === brain);
    if (status?.availability === 'not_installed') {
      notes.push([cellsOf.length, `  ${pad(label, LABEL_WIDTH)}  ${c.dim('not installed')}`]);
      continue;
    }
    if (!found?.limits?.length) {
      const why = found ? whyNoLimits(found) : data.errors.limits ? clean(data.errors.limits) : 'checking…';
      notes.push([cellsOf.length, `  ${pad(label, LABEL_WIDTH)}  ${c.dim(why)}`]);
      continue;
    }
    const pooled = new Set(found.limits.map((limit) => limit.group ?? limit.limitId ?? '')).size > 1;
    let last: string | undefined;
    for (const [index, limit] of found.limits.entries()) {
      // A pool is named on its first window only.
      const pool = pooled ? clean(limit.group ?? limit.limitId ?? '') : '';
      cellsOf.push([index === 0 ? label : '', pool === last ? '' : pool, ...windowCells(limit, c, state.now)]);
      last = pool;
    }
  }
  const windows = table(cellsOf, new Set([4]));
  // Rows without windows keep their place among the others.
  let at = 0;
  for (const [before, note] of [...notes, [Number.POSITIVE_INFINITY, ''] as [number, string]]) {
    while (at < Math.min(before, windows.length)) rows.push({ text: `  ${windows[at++]}` });
    if (note) rows.push({ text: note });
  }

  const counted = (data.usage ?? []).filter((entry) => entry.usage);
  rows.push({ text: '' }, { text: `${c.bold(`Sessions of ${folderName(state)}`)}${c.dim(' · by CLI')}` });
  if (counted.length === 0) {
    rows.push({ text: `  ${c.dim(data.usage ? 'nothing counted here yet' : 'reading…')}` });
    return rows;
  }
  const byBrain = new Map<BrainId, typeof counted>();
  for (const entry of counted) byBrain.set(entry.brain, [...(byBrain.get(entry.brain) ?? []), entry]);
  const sum = (list: typeof counted, pick: (entry: (typeof counted)[number]) => number) =>
    list.reduce((total, entry) => total + pick(entry), 0);
  const line = (name: string, list: typeof counted) => {
    const priced = list.filter((entry) => entry.costUsd !== null);
    const unpriced = list.length - priced.length;
    const cost = priced.length > 0 ? money(sum(priced, (entry) => entry.costUsd ?? 0)) : '';
    return [
      name,
      String(list.length),
      tokens(sum(list, (entry) => entry.usage?.inputTokens ?? 0)),
      tokens(sum(list, (entry) => entry.usage?.outputTokens ?? 0)),
      tokens(sum(list, (entry) => (entry.usage ? cached(entry.usage) : 0))),
      cost,
      unpriced > 0 ? c.dim(`${unpriced} unpriced`) : '',
    ];
  };
  const header = ['', 'sessions', 'in', 'out', 'cache', 'cost', ''].map((title) => c.dim(title));
  const body = [...byBrain].map(([brain, list]) => line(BRAINS[brain].label, list));
  const total = line(c.bold('total'), counted);
  for (const text of table([header, ...body, total], new Set([1, 2, 3, 4, 5]))) rows.push({ text: `  ${text}` });

  const top = [...counted]
    .sort((a, b) => volume(b) - volume(a))
    .slice(0, 5)
    .map((entry) => [
      BRAINS[entry.brain].label,
      c.dim(entry.id.slice(0, 8)),
      tokens(volume(entry)),
      entry.costUsd === null ? c.dim('no price') : money(entry.costUsd),
      titleOf(entry, c, 70),
    ]);
  rows.push({ text: '' }, { text: c.bold('Most tokens') });
  for (const text of table(top, new Set([2, 3]))) rows.push({ text: `  ${text}` });
  return rows;
}

const volume = (entry: SessionUsage) =>
  entry.usage ? entry.usage.inputTokens + entry.usage.outputTokens + cached(entry.usage) : 0;

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
export const SETTINGS = ['theme', 'accent', 'layout', 'bell', 'start'] as const;
export type SettingName = (typeof SETTINGS)[number];

const SETTING_LABELS: Record<SettingName, string> = {
  theme: 'Theme',
  accent: 'Accent',
  layout: 'Wall layout',
  bell: 'Bell when an agent waits',
  start: 'Open on',
};

/** The values a setting goes through with ← and →. */
export function settingValues(name: SettingName): readonly string[] {
  switch (name) {
    case 'theme':
      return THEME_NAMES;
    case 'accent':
      return ACCENT_NAMES;
    case 'layout':
      return LAYOUTS;
    case 'bell':
      return ['on', 'off'];
    case 'start':
      return PAGES;
  }
}

export function settingValue(settings: Settings, name: SettingName): string {
  if (name === 'bell') return settings.bell ? 'on' : 'off';
  return settings[name];
}

/** The settings page: each setting with all its values, the chosen one marked; then a preview. */
export function settingsRows(state: State, c: Paint): Row[] {
  const rows: Row[] = [
    { text: '' },
    { text: `${c.bold('Settings')}${c.dim(` · kept in ${state.settingsFile ?? '~/.config/brainyard/app.json'}`)}` },
  ];
  for (const [index, name] of SETTINGS.entries()) {
    const chosen = settingValue(state.settings, name);
    const values = settingValues(name)
      .map((value) => (value === chosen ? c.accent(c.bold(`[${value}]`)) : ` ${value} `))
      .join(' ');
    const mark = index === state.setting;
    rows.push({
      text: `${mark ? '›' : ' '} ${pad(SETTING_LABELS[name], 26)}${values}`,
      ...(mark ? { selected: true } : {}),
    });
  }
  rows.push(
    { text: '' },
    { text: c.bold('Preview') },
    {
      text: `  ${c.accent(c.bold('[1 Overview]'))}  ${c.green('● ready')}  ${c.yellow('● sign in')}  ${c.red('● error')}  ${c.cyan('working')}  ${c.yellow('waiting: approval')}  ${c.green('idle')}  ${c.dim('quiet 5m')}`,
    },
    { text: `  5h ${bar(0.34, 16, c)} 34%   weekly ${bar(0.76, 16, c)} 76%   monthly ${bar(0.93, 16, c)} 93%` },
    {
      text: `  ${c.accent('╭─ in focus ─╮')}  ${c.magenta('╭─ typing ─╮')}  ${c.yellow('╭─ waits for you ─╮')}  ${c.gray('╭─ quiet ─╮')}`,
    },
    { text: '' },
    {
      text: c.dim(
        '  Your own colours go in the file: "colors": {"accent": "#ff8700", "green": 114} — hex or a 256-colour number.',
      ),
    },
  );
  return rows;
}
