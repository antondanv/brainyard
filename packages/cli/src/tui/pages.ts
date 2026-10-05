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

import { bytes, money, tokens } from '../format.js';
import { type Paint, palette, table } from '../term.js';
import { ago, count, LANGUAGE_NAMES, LANGUAGES, type Translate, until, windowLabel } from './i18n.js';
import { bar, itemRow, limitBar, resetSince } from './overview.js';
import {
  border,
  box,
  cached,
  doing,
  doingText,
  dot,
  folderName,
  LABEL_WIDTH,
  liveById,
  pad,
  type Span,
  split,
  titleOf,
  whyNoLimits,
} from './parts.js';
import { ACCENT_NAMES, LAYOUTS, PAGE_NAMES, PAGES, type Settings, THEME_NAMES } from './settings.js';
import { type Item, listFocus, listItems, type State, stoppable, tr } from './state.js';
import { cells, clean, fit, invertCell } from './text.js';
import { focusedTile, type Tile, tiles, wallPage } from './wall.js';

export { bar } from './overview.js';

export interface Row {
  text: string;
}

const RESET = '\u001b[0m';
/** No colours: where things are, not how they look. */
const PLAIN = palette(false);

// ---------------------------------------------------------------------------
// the wall
// ---------------------------------------------------------------------------

/** One tile: its box, the CLI's screen inside, the cursor where the person types. */
function tileLines(tile: Tile, state: State, c: Paint, t: Translate, focused: boolean): string[] {
  const { pane } = tile;
  const inner = { width: Math.max(0, tile.width - 2), height: Math.max(0, tile.height - 2) };
  const live = pane.sessionId ? liveById(state).get(pane.sessionId) : undefined;
  const waiting = live?.live?.status === 'waiting';
  const typing = focused && state.wall.typing;
  const tint = typing ? c.magenta : focused ? c.accent : waiting ? c.yellow : c.gray;
  const label = pane.brain ? BRAINS[pane.brain].label : '?';
  const name = clean(pane.label || live?.title || '');
  const left = `${focused ? c.bold(label) : label}${name ? c.dim(` · ${clip(name, 80)}`) : ''}`;
  const right = [doingText(live, pane.attached, c, t), pane.memory === undefined ? '' : c.dim(bytes(pane.memory))]
    .filter(Boolean)
    .join(c.dim(' · '));
  const screen = state.data.screens?.[pane.pane];
  const lines = [border(tile.width, ['╭', '╮'], left, right, tint)];
  for (let row = 0; row < inner.height; row++) {
    let text = screen ? clean(screen.lines[row] ?? '') : row === 0 ? c.dim(t('reading the screen…')) : '';
    if (typing && screen?.cursor.visible && screen.cursor.y === row) text = invertCell(text, screen.cursor.x);
    const content = fit(text, inner.width);
    // The CLI's own colours end inside its tile.
    lines.push(`${tint('│')}${content}${content.includes('\u001b') ? RESET : ''}${tint('│')}`);
  }
  const quiet = pane.activityAt ? ago(t, Date.parse(pane.activityAt), state.now) : '';
  let hint = quiet === t('now') ? c.green(t('active')) : quiet ? c.dim(t('quiet {ago}', { ago: quiet })) : '';
  if (focused) hint = t('i type · Enter full screen');
  if (typing) hint = c.magenta(t('✎ typing · Ctrl+Q back'));
  lines.push(border(tile.width, ['╰', '╯'], hint, c.dim(clean(pane.pane)), tint));
  return lines;
}

/** The wall: exactly `height` rows of tiles side by side. */
export function wallRows(state: State, c: Paint, width: number, height: number): Row[] {
  const t = tr(state);
  const rows: Row[] = [];
  if (state.data.tmux === false) {
    rows.push({ text: '' }, { text: `  ${c.dim(t('panes need tmux: the wall shows their screens'))}` });
  } else {
    const list = tiles(state, width, height);
    if (list.length === 0) {
      const empty = state.data.panes ? t('no panes yet · n starts one here') : t('reading…');
      rows.push({ text: '' }, { text: `  ${c.dim(empty)}` });
    } else {
      const focus = focusedTile(list, state.wall.focus);
      const parts = Array.from({ length: height }, () => [] as { x: number; text: string }[]);
      for (const tile of list) {
        for (const [index, line] of tileLines(tile, state, c, t, tile === focus).entries()) {
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
  return pages > 1 ? tr(state)('screen {page}/{pages}', { page: page + 1, pages }) : '';
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

function when(t: Translate, iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const age = ago(t, Date.parse(iso), now);
  return age === t('now') ? age : t('{ago} ago', { ago: age });
}

/** The selected session in full: where, when, what it does, what it used, how to go on with it. */
function card(item: Item | undefined, state: State, c: Paint, t: Translate, width: number): string[] {
  if (!item || (item.kind !== 'session' && item.kind !== 'running')) return [c.dim(t('nothing selected'))];
  const { session } = item;
  const usage = item.kind === 'session' ? item.usage : undefined;
  const pane = item.kind === 'session' ? item.pane : undefined;
  const field = (name: string, value: string) => `${c.dim(pad(t(name), 11))}${value}`;
  const now = doingText(session, false, c, t);
  const lines = [
    `${BRAINS[session.brain].label}  ${c.dim(session.id)}`,
    '',
    field('folder', session.cwd ? clip(clean(tidyPaths(session.cwd)), Math.max(10, width - 11)) : '?'),
    field('started', when(t, session.startedAt, state.now)),
    field('updated', when(t, session.updatedAt, state.now)),
    field('now', `${dot(doing(session), c)} ${now || c.dim(t('saved'))}${pane ? c.dim(` ▣ ${pane}`) : ''}`),
  ];
  const counters = usage?.usage;
  if (counters) {
    const cache = cached(counters);
    lines.push(
      field(
        'used',
        `${tokens(counters.inputTokens)} ${t('in')} · ${tokens(counters.outputTokens)} ${t('out')}${cache ? ` · ${tokens(cache)} ${t('cache')}` : ''}`,
      ),
      field('cost', usage.costUsd === null ? c.dim(t('no price')) : money(usage.costUsd)),
    );
    for (const model of usage.byModel.slice(0, 4)) {
      const used = model.usage.inputTokens + model.usage.outputTokens + cached(model.usage);
      const cost = model.costUsd === null ? '' : ` · ${money(model.costUsd)}`;
      lines.push(`${' '.repeat(11)}${c.dim(`${clip(model.model ?? t('unknown model'), 30)} ${tokens(used)}${cost}`)}`);
    }
  }
  lines.push('');
  if (pane) lines.push(`${c.accent('Enter')} ${t('into its pane')} · ${c.accent('x')} ${t('close the pane')}`);
  else if (session.live) {
    lines.push(
      stoppable(session)
        ? `${c.accent('s')} ${t('stop it: the conversation stays')}`
        : c.dim(t('open in another terminal')),
    );
  } else lines.push(`${c.accent('Enter')} ${t('or')} ${c.accent('r')} ${t('continue it in a pane')}`);
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

/** The rows inside a list box that the sessions page shows. */
export function listRoom(height: number): number {
  return Math.max(1, height - 2);
}

/** The widths of the sessions page's list and of the card beside it: none below 100 cells. */
export function sessionsWidths(width: number): [list: number, card: number] {
  if (width < 100) return [width, 0];
  const [list = 0, card = 0] = split(width, 2);
  return [list + 8, card - 8];
}

/** The sessions page: a filtered list in a box, and the selected one's card beside it. */
export function sessionsRows(state: State, c: Paint, width: number, height: number): Row[] {
  const t = tr(state);
  const list = listItems(state);
  const { item: selected } = listFocus(state, list);
  const [left, right] = sessionsWidths(width);
  const room = listRoom(height);
  const scroll = listScroll(state, room);
  const { filter, editing } = state.list;
  const search =
    editing || filter
      ? `  ${c.accent('/')} ${clean(filter)}${editing ? c.accent('▏') : ''}`
      : c.dim(`  / ${t('filter')}`);
  const lines = list
    .slice(scroll, scroll + room)
    .map((item) => itemRow(item, state, c, left - 4, item.key === selected?.key, true));
  if (list.length === 0) {
    lines.push(`  ${c.dim(filter ? t('nothing fits the filter · Esc clears it') : t('no sessions yet'))}`);
  }
  while (lines.length < room) lines.push('');
  const listBox = box(left, lines, {
    title: `${c.accent(c.bold(t('Sessions')))}${search}`,
    note: c.dim(String(list.length)),
    tint: c.gray,
  });
  if (!right) return listBox.map((text) => ({ text }));
  const details = card(selected, state, c, t, right - 4).slice(0, room);
  while (details.length < room) details.push('');
  const session =
    selected && (selected.kind === 'session' || selected.kind === 'running') ? selected.session : undefined;
  const cardBox = box(right, details, {
    title: c.bold(session ? titleOf(session, c, t, 60) : t('Session')),
    tint: c.gray,
  });
  return listBox.map((text, index) => ({ text: `${text}${cardBox[index] ?? ''}` }));
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------
function windowCells(limit: LimitWindow, c: Paint, t: Translate, now: number): string[] {
  if (resetSince(limit, now)) return [windowLabel(t, limit), c.dim('░'.repeat(24)), '', c.dim(t('reset since seen'))];
  const used = Math.round(limit.utilization * 100);
  let resets = '';
  if (limit.resetsAt) {
    const left = until(t, limit.resetsAt * 1000, now);
    resets = c.dim(left === t('now') ? t('resetting') : t('resets in {time}', { time: left }));
  }
  return [windowLabel(t, limit), bar(limit.utilization, 24, c), `${used}%`, resets];
}

const volume = (entry: SessionUsage) =>
  entry.usage ? entry.usage.inputTokens + entry.usage.outputTokens + cached(entry.usage) : 0;

/** The usage page: every subscription window as a bar, then what this folder's sessions used. */
export function usageRows(state: State, c: Paint): Row[] {
  const t = tr(state);
  const { data } = state;
  const width = state.width;
  const order = data.status?.brains.map((brain) => brain.id) ?? (Object.keys(BRAINS) as BrainId[]);
  const cellsOf: string[][] = [];
  for (const brain of order) {
    const label = BRAINS[brain].label;
    const status = data.status?.brains.find((entry) => entry.id === brain);
    const found = data.limits?.find((entry) => entry.brain === brain);
    if (status?.availability === 'not_installed') {
      cellsOf.push([label, c.dim(t('not installed'))]);
      continue;
    }
    if (!found?.limits?.length) {
      const why = found ? whyNoLimits(found, t) : data.errors.limits ? clean(data.errors.limits) : t('checking…');
      cellsOf.push([label, c.dim(why)]);
      continue;
    }
    const pooled = new Set(found.limits.map((limit) => limit.group ?? limit.limitId ?? '')).size > 1;
    let last: string | undefined;
    const seen = found.limitsObservedAt ? ago(t, Date.parse(found.limitsObservedAt), state.now) : t('now');
    for (const [index, limit] of found.limits.entries()) {
      // A pool is named on its first window only; how old the snapshot is, on the CLI's first.
      const pool = pooled ? clean(limit.group ?? limit.limitId ?? '') : '';
      const age = index === 0 && seen !== t('now') ? c.dim(t('seen {ago} ago', { ago: seen })) : '';
      cellsOf.push([index === 0 ? label : '', pool === last ? '' : pool, ...windowCells(limit, c, t, state.now), age]);
      last = pool;
    }
  }
  const rows: Row[] = [];
  const push = (title: string, lines: string[], note = '') => {
    for (const text of box(width, lines, { title: c.accent(c.bold(title)), note, tint: c.gray })) rows.push({ text });
  };
  push(t('Subscription limits'), table(cellsOf, new Set([4])));

  const counted = (data.usage ?? []).filter((entry) => entry.usage);
  const folderTitle = t('Sessions of {folder}', { folder: folderName(state) });
  if (counted.length === 0) {
    push(folderTitle, [c.dim(data.usage ? t('nothing counted here yet') : t('reading…'))]);
    return rows;
  }
  const byBrain = new Map<BrainId, SessionUsage[]>();
  for (const entry of counted) byBrain.set(entry.brain, [...(byBrain.get(entry.brain) ?? []), entry]);
  const sum = (list: SessionUsage[], pick: (entry: SessionUsage) => number) =>
    list.reduce((total, entry) => total + pick(entry), 0);
  const line = (name: string, list: SessionUsage[]) => {
    const priced = list.filter((entry) => entry.costUsd !== null);
    const unpriced = list.length - priced.length;
    return [
      name,
      String(list.length),
      tokens(sum(list, (entry) => entry.usage?.inputTokens ?? 0)),
      tokens(sum(list, (entry) => entry.usage?.outputTokens ?? 0)),
      tokens(sum(list, (entry) => (entry.usage ? cached(entry.usage) : 0))),
      priced.length > 0 ? money(sum(priced, (entry) => entry.costUsd ?? 0)) : '',
      unpriced > 0 ? c.dim(count(t, unpriced, 'unpriced')) : '',
    ];
  };
  const header = ['', t('sessions'), t('in'), t('out'), t('cache'), t('cost'), ''].map((title) => c.dim(title));
  const body = [...byBrain].map(([brain, list]) => line(BRAINS[brain].label, list));
  push(
    folderTitle,
    table([header, ...body, line(c.bold(t('total')), counted)], new Set([1, 2, 3, 4, 5])),
    c.dim(t('by CLI')),
  );

  const top = [...counted]
    .sort((a, b) => volume(b) - volume(a))
    .slice(0, 5)
    .map((entry) => [
      `${dot(doing(entry), c)} ${titleOf(entry, c, t, 60)}`,
      BRAINS[entry.brain].label,
      tokens(volume(entry)),
      entry.costUsd === null ? c.dim(t('no price')) : money(entry.costUsd),
    ]);
  push(t('Most tokens'), table(top, new Set([2, 3])));
  return rows;
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
export const SETTINGS = ['language', 'theme', 'accent', 'layout', 'bell', 'start'] as const;
export type SettingName = (typeof SETTINGS)[number];

export const SETTING_LABELS: Record<SettingName, string> = {
  language: 'Language',
  theme: 'Theme',
  accent: 'Accent',
  layout: 'Wall layout',
  bell: 'Bell when an agent waits',
  start: 'Open on',
};

/** The values a setting goes through with ← and →. */
export function settingValues(name: SettingName): readonly string[] {
  switch (name) {
    case 'language':
      return LANGUAGES;
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

/** How a value reads: a language by its own name, a page as its tab, the rest in the app's language. */
function valueName(name: SettingName, value: string, t: Translate): string {
  if (name === 'language') return LANGUAGE_NAMES[value as keyof typeof LANGUAGE_NAMES] ?? value;
  if (name === 'start') return t(PAGE_NAMES[value as keyof typeof PAGE_NAMES] ?? value);
  return t(value);
}

/**
 * All the values with the chosen one marked, and where each is in the text; where they do not fit, the
 * chosen one between arrows, which stand for the values before and after it.
 */
function valuesText(
  name: SettingName,
  chosen: string,
  width: number,
  c: Paint,
  t: Translate,
): { text: string; spans: Span<string>[] } {
  const values = settingValues(name);
  let text = '';
  const spans: Span<string>[] = [];
  for (const [index, value] of values.entries()) {
    if (index > 0) text += ' ';
    const shown = valueName(name, value, t);
    const from = cells(text);
    text += value === chosen ? c.accent(c.bold(`[${shown}]`)) : ` ${shown} `;
    spans.push({ value, from, to: cells(text) });
  }
  if (cells(text) <= width) return { text, spans };
  const at = values.indexOf(chosen);
  const before = values[(at - 1 + values.length) % values.length]!;
  const after = values[(at + 1) % values.length]!;
  const marked = `[${valueName(name, chosen, t)}]`;
  return {
    text: `${c.dim('◂')} ${c.accent(c.bold(marked))} ${c.dim('▸')}  ${c.dim(`${at + 1}/${values.length}`)}`,
    spans: [
      { value: before, from: 0, to: 1 },
      { value: chosen, from: 2, to: 2 + cells(marked) },
      { value: after, from: 3 + cells(marked), to: 4 + cells(marked) },
    ],
  };
}

/** A setting's row: the mark, its name, its values; and where the values start on it. */
function settingLine(state: State, index: number, c: Paint, t: Translate): { text: string; spans: Span<string>[] } {
  const name = SETTINGS[index]!;
  const mark = index === state.setting;
  const label = pad(t(SETTING_LABELS[name]), 30);
  const values = valuesText(name, settingValue(state.settings, name), state.width - 4 - 2 - 30, c, t);
  const text = `${mark ? c.accent('▌') : ' '} ${mark ? c.bold(label) : label}`;
  // Inside the box, the row starts two cells in.
  const from = 2 + cells(text);
  return {
    text: `${text}${values.text}`,
    spans: values.spans.map((span) => ({ ...span, from: span.from + from, to: span.to + from })),
  };
}

/** The setting on this body row of the settings page, and the value at this cell of it, if any. */
export function settingAt(state: State, x: number, y: number): { index: number; value?: string } | undefined {
  const index = y - 1;
  if (index < 0 || index >= SETTINGS.length) return undefined;
  const value = settingLine(state, index, PLAIN, tr(state)).spans.find((span) => x >= span.from && x < span.to);
  return value ? { index, value: value.value } : { index };
}

/** The settings page: each setting with all its values, the chosen one marked; then a preview. */
export function settingsRows(state: State, c: Paint): Row[] {
  const t = tr(state);
  const width = state.width;
  const lines = SETTINGS.map((_, index) => settingLine(state, index, c, t).text);
  const rows: Row[] = [];
  const kept = t('kept in {file}', { file: state.settingsFile ?? '~/.config/brainyard/app.json' });
  for (const text of box(width, lines, { title: c.accent(c.bold(t('Settings'))), note: c.dim(kept), tint: c.gray })) {
    rows.push({ text });
  }
  const sample: LimitWindow = { window: 'five_hour', utilization: 0.34, windowMinutes: 300 };
  const preview = [
    `${c.accent(c.bold(`[1 ${t('Overview')}]`))}  ${c.green(`● ${t('ready')}`)}  ${c.yellow(`● ${t('sign in')}`)}  ${c.red(`● ${t('error')}`)}  ${c.cyan(t('working'))}  ${c.yellow(`${t('waiting')}: approval`)}  ${c.green(t('idle'))}  ${c.dim(t('quiet {ago}', { ago: ago(t, state.now - 5 * 60_000, state.now) }))}`,
    `${limitBar(sample, windowLabel(t, sample), 30, c, t, state.now)}   ${limitBar({ ...sample, window: 'weekly', utilization: 0.76, windowMinutes: 10_080 }, t('weekly'), 30, c, t, state.now)}   ${limitBar({ ...sample, utilization: 0.93 }, t('monthly'), 30, c, t, state.now)}`,
    `${c.accent(`╭─ ${t('in focus')} ─╮`)}  ${c.magenta(`╭─ ${t('typing')} ─╮`)}  ${c.yellow(`╭─ ${t('waits for you')} ─╮`)}  ${c.gray(`╭─ ${t('quiet')} ─╮`)}`,
    '',
    c.dim(t('Your own colours: "colors": {"accent": "#ff8700"} in the file — hex, or a number of the 256.')),
  ];
  for (const text of box(width, preview, { title: c.accent(c.bold(t('Preview'))), tint: c.gray })) rows.push({ text });
  return rows;
}

export { LABEL_WIDTH };
