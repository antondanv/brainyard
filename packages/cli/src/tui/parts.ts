/** Pieces every page draws the same way: names, states, titles, numbers. */
import { BRAINS, type BrainUsage, clip, type SessionInfo, tidyPaths, type Usage } from '@antondanv/brainyard';

import type { Paint } from '../term.js';
import type { State } from './state.js';
import { cells, clean } from './text.js';

export const LABEL_WIDTH = Math.max(...Object.values(BRAINS).map((brain) => brain.label.length));

export function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(0, size - cells(text)));
}

export function folderName(state: State): string {
  return clean(tidyPaths(state.cwd));
}

/** Cache reads and writes: most of what Claude Code takes in goes through its cache. */
export function cached(usage: Usage): number {
  return usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** What a pane's CLI does: attached, working, waiting for the person, or idle. */
export function paneState(attached: boolean, live: SessionInfo | undefined, c: Paint): string {
  if (attached) return c.cyan('attached');
  const state = live?.live;
  if (!state) return '';
  if (state.status === 'busy') return c.cyan('working');
  if (state.status === 'waiting') {
    return c.yellow(`waiting${state.waitingFor ? `: ${clip(clean(state.waitingFor), 30)}` : ''}`);
  }
  if (state.status === 'idle') return c.green('idle');
  return c.dim(String(state.status));
}

export function titleOf(session: SessionInfo, c: Paint, limit = 60): string {
  const tags = [session.background ? 'bg' : '', session.interactive ? '' : 'headless']
    .filter(Boolean)
    .map((tag) => c.dim(` ${tag}`))
    .join('');
  return `${session.title ? clip(clean(session.title), limit) : c.dim('(untitled)')}${tags}`;
}

/** The app makes no paid call on its own: Claude Code's windows come from `brainyard usage --live`. */
export function whyNoLimits(brain: BrainUsage): string {
  if (brain.limitsUnavailable === 'not_requested') {
    return brain.brain === 'claude' ? 'not checked: brainyard usage --live (one tiny real call)' : 'not checked';
  }
  return brain.detail ?? (brain.limits ? 'no windows' : 'unknown');
}

/** The live sessions by id: what a pane's session is doing. */
export function liveById(state: State): Map<string, SessionInfo> {
  return new Map((state.data.live ?? []).map((session) => [session.id, session]));
}
