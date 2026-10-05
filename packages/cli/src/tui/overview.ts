/**
 * The overview: a card for each agent (its state, its sign-in, its limits as
 * bars), then boxes of panes, of sessions running in other folders and of
 * this folder's sessions. Each row leads with what a person recognises — the
 * title — and keeps the numbers in columns on the right.
 */
import {
  BRAINS,
  type BrainId,
  type BrainStatus,
  type BrainUsage,
  clip,
  type LimitWindow,
  tidyPaths,
} from '@antondanv/brainyard';

import { bytes, money, tokens } from '../format.js';
import { AVAILABILITY } from '../status.js';
import type { Paint } from '../term.js';
import { ago, count, type Translate, windowLabel } from './i18n.js';
import {
  box,
  type Column,
  cached,
  columns,
  doing,
  doingText,
  dot,
  folderName,
  padStart,
  split,
  titleOf,
  whyNoLimits,
} from './parts.js';
import { focus, type Item, type SectionId, type State, sections, tr } from './state.js';
import { clean } from './text.js';

export interface Row {
  text: string;
}

export interface Layout {
  rows: Row[];
  /**
   * Body rows of each item: the first one to show (its box's top, for a box's first item) and the last;
   * cards side by side also have their cells, from `left` up to but not including `right`.
   */
  spans: Map<string, { top: number; last: number; left?: number; right?: number }>;
}

/** A card's rows: its border, the sign-in, two limits, its border. */
const CARD = 5;

/** The words for each state of a CLI, for the tests that check every text has its translation. */
export const STATUS_WORDS = Object.values(AVAILABILITY).map(([word]) => word);

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** How much of a window is used, in eighths of a cell: green, yellow from 70%, red from 90%. */
export function bar(fraction: number, width: number, c: Paint): string {
  const used = Math.min(1, Math.max(0, fraction)) * width;
  const full = Math.floor(used);
  const part = full < width ? (EIGHTHS[Math.floor((used - full) * 8)] ?? '') : '';
  const tint = fraction >= 0.9 ? c.red : fraction >= 0.7 ? c.yellow : c.green;
  return `${tint(`${'█'.repeat(full)}${part}`)}${c.dim('░'.repeat(Math.max(0, width - full - (part ? 1 : 0))))}`;
}

/** A window that reset since it was seen says nothing about now. */
export function resetSince(limit: LimitWindow, now: number): boolean {
  return limit.resetsAt !== undefined && limit.resetsAt * 1000 <= now;
}

/** Who is signed in and how, in a few words; or what to do about it. */
function signIn(status: BrainStatus, c: Paint, t: Translate): string {
  switch (status.availability) {
    case 'not_installed':
      return c.dim(status.fix ?? '');
    case 'needs_login':
      return c.yellow(`${t('sign in')}${status.fix ? `: ${status.fix}` : ''}`);
    case 'limited':
    case 'error':
      return c.red(clean(status.ping?.error?.message ?? status.summary));
    case 'unknown':
      return c.yellow(t('sign-in not confirmed'));
    default: {
      const how = [status.auth.method, status.auth.plan].filter(Boolean).join(' · ');
      return how ? clean(how) : t('signed in');
    }
  }
}

/** Up to two windows: the first two of one pool, or the busiest of each of two pools. */
function shownWindows(limits: readonly LimitWindow[]): { limit: LimitWindow; pool?: string }[] {
  const pools = new Map<string, LimitWindow[]>();
  for (const limit of limits) {
    const pool = limit.group ?? '';
    pools.set(pool, [...(pools.get(pool) ?? []), limit]);
  }
  if (pools.size <= 1) return limits.slice(0, 2).map((limit) => ({ limit }));
  return [...pools]
    .slice(0, 2)
    .map(([pool, list]) => ({ limit: list.reduce((a, b) => (b.utilization > a.utilization ? b : a)), pool }));
}

/** A limit as a line of a card: its name, a bar, the share used. */
export function limitBar(
  limit: LimitWindow,
  name: string,
  width: number,
  c: Paint,
  t: Translate,
  now: number,
  label = 8,
): string {
  const head = clip(name, label).padEnd(label);
  if (resetSince(limit, now)) return `${head} ${c.dim(t('reset since seen'))}`;
  const used = Math.round(limit.utilization * 100);
  return `${head} ${bar(limit.utilization, Math.max(4, width - label - 6), c)} ${padStart(`${used}%`, 4)}`;
}

function limitLines(found: BrainUsage | undefined, state: State, c: Paint, t: Translate, width: number): string[] {
  if (!found) return [c.dim(state.data.errors.limits ? clean(state.data.errors.limits) : t('limits: checking…'))];
  if (!found.limits?.length) return [c.dim(whyNoLimits(found, t))];
  return shownWindows(found.limits).map(({ limit, pool }) =>
    limitBar(limit, pool ? (pool.split(/\s+/)[0] ?? pool) : windowLabel(t, limit), width, c, t, state.now),
  );
}

/** One agent's card. */
function agentCard(brain: BrainId, state: State, c: Paint, t: Translate, width: number, selected: boolean): string[] {
  const label = BRAINS[brain].label;
  const status = state.data.status?.brains.find((entry) => entry.id === brain);
  const found = state.data.limits?.find((entry) => entry.brain === brain);
  const inner = width - 4;
  const lines: string[] = [];
  let note = c.dim(t('checking…'));
  if (status) {
    const [word, colour] = AVAILABILITY[status.availability];
    note = c[colour](t(word));
    lines.push(`${c.dim(status.version ?? '—')}  ${signIn(status, c, t)}`);
    if (status.availability !== 'not_installed') lines.push(...limitLines(found, state, c, t, inner));
  } else if (state.data.errors.status) {
    note = c.yellow(t('unknown'));
    lines.push(c.yellow(clean(state.data.errors.status)));
  }
  while (lines.length < CARD - 2) lines.push('');
  // How old the limits are, when they are not fresh.
  let footer = '';
  if (found?.limits?.length && found.limitsObservedAt) {
    const seen = ago(t, Date.parse(found.limitsObservedAt), state.now);
    if (seen !== t('now')) footer = c.dim(t('seen {ago} ago', { ago: seen }));
  }
  return box(width, lines.slice(0, CARD - 2), {
    title: selected ? c.accent(c.bold(label)) : c.bold(label),
    note,
    footer,
    tint: selected ? c.accent : c.gray,
  });
}

/** A row of the panes box: what it does, its label, then CLI, state, quiet time, memory and name. */
function paneColumns(item: Extract<Item, { kind: 'pane' }>, state: State, c: Paint, t: Translate, mark: boolean) {
  const { pane, live } = item;
  const places = new Set(state.places);
  let title = clean(pane.label || live?.title || '') || c.dim(t('(no label)'));
  if (mark) title = c.bold(title);
  if (pane.cwd && !places.has(pane.cwd)) title += c.dim(` · ${clip(clean(tidyPaths(pane.cwd)), 40)}`);
  const quiet = pane.activityAt ? ago(t, Date.parse(pane.activityAt), state.now) : '';
  const list: Column[] = [
    { text: `${dot(doing(live, pane.attached), c)} ${title}` },
    { text: pane.brain ? BRAINS[pane.brain].label : '?', width: 11, drop: 3 },
    { text: doingText(live, pane.attached, c, t), width: 20, drop: 2 },
    {
      text: quiet === t('now') ? c.green(t('active')) : quiet ? c.dim(t('quiet {ago}', { ago: quiet })) : '',
      width: 13,
      right: true,
      drop: 4,
    },
    { text: pane.memory === undefined ? '' : bytes(pane.memory), width: 7, right: true, drop: 5 },
    { text: c.dim(clean(pane.pane)), width: 17, drop: 6 },
  ];
  return list;
}

/** A row of a sessions box: what it does, its title, then CLI, age, where it runs or what it does, tokens and cost. */
function sessionColumns(
  item: Extract<Item, { kind: 'session' | 'running' }>,
  state: State,
  c: Paint,
  t: Translate,
  mark: boolean,
  aligned: boolean,
) {
  const { session } = item;
  const pane = item.kind === 'session' ? item.pane : undefined;
  const usage = item.kind === 'session' ? item.usage : undefined;
  let title = titleOf(session, c, t);
  if (mark || session.live) title = c.bold(title);
  // Another folder goes after the title, dim: the columns stay the same for every row.
  if (item.kind === 'running') title += c.dim(` · ${clip(clean(tidyPaths(session.cwd ?? '?')), 40)}`);
  const when = session.updatedAt ?? session.startedAt;
  const where = pane ? c.dim(`▣ ${pane}`) : doingText(session, false, c, t);
  const counters = usage?.usage;
  const total = counters ? counters.inputTokens + counters.outputTokens + cached(counters) : 0;
  let cost = '';
  if (counters) cost = usage.costUsd === null ? c.dim(t('no price')) : money(usage.costUsd);
  const list: Column[] = [
    { text: `${dot(doing(session), c)} ${title}` },
    { text: BRAINS[session.brain].label, width: 11, drop: 3 },
    { text: when ? c.dim(ago(t, Date.parse(when), state.now)) : '', width: 6, right: true, drop: 4 },
    { text: where, width: 20, drop: 2 },
  ];
  // Running elsewhere has no counters: its own box leaves their columns out, a mixed list keeps them.
  if (item.kind === 'session' || aligned) {
    list.push(
      { text: counters ? tokens(total) : '', width: 6, right: true, drop: 6 },
      { text: cost, width: 9, right: true, drop: 7 },
    );
  }
  return list;
}

/** An item as a row of `width` cells: the selection mark, then its columns; `aligned` when kinds mix in one list. */
export function itemRow(item: Item, state: State, c: Paint, width: number, mark: boolean, aligned = false): string {
  const t = tr(state);
  const list =
    item.kind === 'pane'
      ? paneColumns(item, state, c, t, mark)
      : item.kind === 'session' || item.kind === 'running'
        ? sessionColumns(item, state, c, t, mark, aligned)
        : [];
  return `${mark ? c.accent('▌') : ' '} ${columns(list, Math.max(0, width - 2))}`;
}

function boxHead(id: SectionId, list: readonly Item[], state: State, c: Paint, t: Translate) {
  const { data } = state;
  const error = (message: string | undefined) => (message ? ` ${c.yellow(clip(clean(message), 60))}` : '');
  switch (id) {
    case 'panes': {
      const memory = (data.panes ?? []).reduce((sum, pane) => sum + (pane.memory ?? 0), 0);
      const note = data.panes ? [count(t, list.length, 'pane'), memory > 0 ? bytes(memory) : ''] : [];
      return { title: t('Panes'), note: `${c.dim(note.filter(Boolean).join(' · '))}${error(data.errors.panes)}` };
    }
    case 'running':
      return { title: t('Running in other folders'), note: `${c.dim(String(list.length))}${error(data.errors.live)}` };
    default: {
      const counted = (data.usage ?? []).filter((entry) => entry.usage);
      const parts = data.sessions ? [count(t, list.length, 'session')] : [];
      const priced = counted.filter((entry) => entry.costUsd !== null);
      if (priced.length > 0) parts.push(money(priced.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)));
      const volume = counted.reduce(
        (sum, entry) =>
          sum + (entry.usage ? entry.usage.inputTokens + entry.usage.outputTokens + cached(entry.usage) : 0),
        0,
      );
      if (volume > 0) parts.push(`${tokens(volume)} ${t('tokens')}`);
      return {
        title: `${t('Sessions')} · ${folderName(state)}`,
        note: `${c.dim(parts.join(' · '))}${error(data.errors.sessions ?? data.errors.usage)}`,
      };
    }
  }
}

function emptyText(id: SectionId, state: State, t: Translate): string {
  const { data } = state;
  if (id === 'panes') {
    if (data.tmux === false) return t('panes need tmux');
    return data.panes ? t('no panes yet · n starts one') : t('reading…');
  }
  return data.sessions ? t('no sessions in this folder yet · n starts one') : t('reading…');
}

/** The overview's body, before scrolling, and where each item is in it. */
export function overviewLayout(state: State, c: Paint): Layout {
  const t = tr(state);
  const rows: Row[] = [];
  const spans: Layout['spans'] = new Map();
  const selected = focus(state).item?.key;
  const all = sections(state);
  const agents = all.find((section) => section.id === 'agents')?.items ?? [];
  // Four cards side by side when there is room, two, or one.
  const perRow = state.width >= 120 ? 4 : state.width >= 64 ? 2 : 1;
  for (let at = 0; at < agents.length; at += perRow) {
    const chunk = agents.slice(at, at + perRow);
    const widths = split(state.width, chunk.length);
    const cards = chunk.map((item, index) =>
      item.kind === 'agent' ? agentCard(item.brain, state, c, t, widths[index]!, item.key === selected) : [],
    );
    const top = rows.length;
    for (let line = 0; line < CARD; line++) rows.push({ text: cards.map((card) => card[line] ?? '').join('') });
    let left = 0;
    for (const [index, item] of chunk.entries()) {
      const right = left + widths[index]!;
      spans.set(item.key, { top, last: rows.length - 1, left, right });
      left = right;
    }
  }
  for (const section of all) {
    if (section.id === 'agents') continue;
    const head = boxHead(section.id, section.items, state, c, t);
    const inner = state.width - 4;
    const lines =
      section.items.length > 0
        ? section.items.map((item) => itemRow(item, state, c, inner, item.key === selected))
        : [`  ${c.dim(emptyText(section.id, state, t))}`];
    const top = rows.length;
    const drawn = box(state.width, lines, { title: c.accent(c.bold(head.title)), note: head.note, tint: c.gray });
    for (const text of drawn) rows.push({ text });
    for (const [index, item] of section.items.entries()) {
      const row = top + 1 + index;
      // The first shows with its box's title, the last with its box's bottom.
      spans.set(item.key, {
        top: index === 0 ? top : row,
        last: index === section.items.length - 1 ? row + 1 : row,
      });
    }
  }
  return { rows, spans };
}
