/**
 * Pieces every page draws the same way: boxes with a title on the border,
 * columns that give way on a narrow screen, a coloured dot for what a
 * session does, names, titles and numbers — all in the app's language.
 */
import { BRAINS, type BrainUsage, clip, type SessionInfo, tidyPaths, type Usage } from '@antondanv/brainyard';

import type { Paint } from '../term.js';
import type { Translate } from './i18n.js';
import type { State } from './state.js';
import { cells, clean, fit } from './text.js';

export const LABEL_WIDTH = Math.max(...Object.values(BRAINS).map((brain) => brain.label.length));

export function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(0, size - cells(text)));
}

export function padStart(text: string, size: number): string {
  return ' '.repeat(Math.max(0, size - cells(text))) + text;
}

export function folderName(state: State): string {
  return clean(tidyPaths(state.cwd));
}

/** Splits `size` cells into `parts`, the first ones a cell larger when it does not divide. */
export function split(size: number, parts: number): number[] {
  const base = Math.floor(size / parts);
  return Array.from({ length: parts }, (_, index) => base + (index < size % parts ? 1 : 0));
}

/** Cache reads and writes: most of what Claude Code takes in goes through its cache. */
export function cached(usage: Usage): number {
  return usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** What a stretch of a row stands for, and the cells it takes: from, up to but not including `to`. */
export interface Span<T> {
  value: T;
  from: number;
  to: number;
}

/** A box's top or bottom: corners, a title on the left, a note on the right; exactly `width` cells. */
export function border(
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

export interface BoxOptions {
  title: string;
  note?: string;
  /** On the bottom border, on the right. */
  footer?: string;
  tint: (text: string) => string;
}

/** A box `width` cells wide around these lines, each padded or cut to its inside. */
export function box(width: number, lines: readonly string[], options: BoxOptions): string[] {
  const inner = Math.max(0, width - 4);
  const { tint } = options;
  return [
    border(width, ['╭', '╮'], options.title, options.note ?? '', tint),
    ...lines.map((line) => `${tint('│')} ${fit(line, inner)} ${tint('│')}`),
    border(width, ['╰', '╯'], '', options.footer ?? '', tint),
  ];
}

/** A cell of a row: `width` cells, or the rest of the row when it has none. */
export interface Column {
  text: string;
  width?: number;
  /** Numbers line up on the right. */
  right?: boolean;
  /** When the row is too narrow, the column with the highest `drop` goes first. */
  drop?: number;
}

/** Columns two cells apart in exactly `width` cells; the one without a width takes what is left. */
export function columns(list: readonly Column[], width: number, least = 18): string {
  let kept = [...list];
  const fixed = () => kept.reduce((sum, column) => sum + (column.width ?? 0), 0) + 2 * (kept.length - 1);
  while (width - fixed() < least) {
    const droppable = kept.filter((column) => column.drop !== undefined);
    if (droppable.length === 0) break;
    const first = droppable.reduce((a, b) => ((b.drop ?? 0) > (a.drop ?? 0) ? b : a));
    kept = kept.filter((column) => column !== first);
  }
  const rest = Math.max(0, width - fixed());
  return kept
    .map((column) => {
      const size = column.width ?? rest;
      return column.right && cells(column.text) <= size ? padStart(column.text, size) : fit(column.text, size);
    })
    .join('  ');
}

/** What a session (or the CLI in a pane) does now. */
export type Doing = 'busy' | 'waiting' | 'idle' | 'attached' | 'open' | 'saved';

export function doing(session: SessionInfo | undefined, attached = false): Doing {
  if (attached) return 'attached';
  const status = session?.live?.status;
  if (status === 'busy' || status === 'waiting' || status === 'idle') return status as Doing;
  return session?.live ? 'open' : 'saved';
}

/** A dot in the colour of what it does: working, waiting for you, idle, or only saved. */
export function dot(what: Doing, c: Paint): string {
  switch (what) {
    case 'busy':
      return c.cyan('●');
    case 'waiting':
      return c.yellow('●');
    case 'idle':
    case 'open':
      return c.green('●');
    case 'attached':
      return c.accent('◆');
    case 'saved':
      return c.dim('○');
  }
}

/** What it does, in words: `working`, `waiting: approval`, `idle`, `full screen`… */
export function doingText(session: SessionInfo | undefined, attached: boolean, c: Paint, t: Translate): string {
  const what = doing(session, attached);
  switch (what) {
    case 'attached':
      return c.accent(t('full screen'));
    case 'busy':
      return c.cyan(t('working'));
    case 'waiting': {
      const why = session?.live?.waitingFor;
      return c.yellow(`${t('waiting')}${why ? `: ${clip(clean(why), 40)}` : ''}`);
    }
    case 'idle':
      return c.green(t('idle'));
    case 'open': {
      const state = session?.live?.state;
      // A finished background session says how it ended.
      if (session?.live?.kind === 'background' && state && state !== 'working') return c.dim(clean(state));
      return c.green(t('open'));
    }
    case 'saved':
      return '';
  }
}

export function titleOf(session: SessionInfo, c: Paint, t: Translate, limit = 80): string {
  const tags = [session.background ? 'bg' : '', session.interactive ? '' : 'headless']
    .filter(Boolean)
    .map((tag) => c.dim(` ${tag}`))
    .join('');
  return `${session.title ? clip(clean(session.title), limit) : c.dim(t('(untitled)'))}${tags}`;
}

/** Why a CLI shows no windows, in a few words. The app makes no paid call on its own. */
export function whyNoLimits(brain: BrainUsage, t: Translate): string {
  if (brain.brain === 'claude' && brain.limitsUnavailable === 'missing' && !brain.error) {
    if (/another account/.test(brain.detail ?? '')) return t('cached for another account');
    return t('not seen yet: /usage in Claude Code shows them');
  }
  if (brain.limitsUnavailable === 'not_requested') return t('not checked');
  if (brain.brain === 'opencode' && brain.limitsUnavailable === 'missing') return t('OpenCode Go is not connected');
  return brain.detail ? clean(brain.detail) : t('unknown');
}

/** The live sessions by id: what a pane's session is doing. */
export function liveById(state: State): Map<string, SessionInfo> {
  return new Map((state.data.live ?? []).map((session) => [session.id, session]));
}
