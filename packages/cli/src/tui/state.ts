/**
 * The app's state, the events that change it and the effects it asks for.
 * Nothing here reads a clock, a terminal or a CLI store: the runtime brings
 * data in as events, `update()` decides, `render()` draws. The same state
 * makes the same frame in a terminal and in a browser.
 */
import {
  BRAIN_IDS,
  type BrainId,
  type BrainUsage,
  type SessionInfo,
  type SessionUsage,
  type StatusReport,
} from '@antondanv/brainyard';

import type { PaneRow } from '../panes.js';

/** What the runtime reads, each on its own schedule. */
export type Source = 'status' | 'limits' | 'panes' | 'live' | 'sessions' | 'usage';

export interface Data {
  /** Undefined until read the first time. */
  status?: StatusReport;
  /** Subscription windows of each CLI. */
  limits?: BrainUsage[];
  /** False when there is no tmux to run panes. */
  tmux?: boolean;
  panes?: PaneRow[];
  /** What runs on this machine now, in every CLI. */
  live?: SessionInfo[];
  /** Saved sessions of the folder. */
  sessions?: SessionInfo[];
  /** Tokens and cost of the folder's sessions. */
  usage?: SessionUsage[];
  /** Why a source could not be read, until it can. */
  errors: Partial<Record<Source, string>>;
}

export type Effect =
  | { kind: 'quit' }
  /** Read everything again and draw the screen anew. */
  | { kind: 'refresh' }
  /** Give the pane the whole screen until the person comes back (Ctrl+Q). */
  | { kind: 'attach'; pane: string }
  /** A new pane, or a saved session continued in one; then attach to it. */
  | { kind: 'start'; brain: BrainId; cwd: string; resume?: string }
  | { kind: 'close'; pane: string }
  | { kind: 'stop'; brain: BrainId; sessionId: string; cwd: string };

export type Dialog =
  | { kind: 'new'; brain: BrainId }
  | { kind: 'confirm'; question: string; effect: Effect }
  | { kind: 'help' };

export interface Note {
  text: string;
  tone: 'info' | 'ok' | 'error';
}

export interface State {
  /** The folder whose sessions are listed and where new panes start. */
  cwd: string;
  /** Spellings of that folder (through symlinks) that a CLI may have written down. */
  places: string[];
  version: string;
  width: number;
  height: number;
  /** Milliseconds since the epoch: how long ago, how long until a reset. */
  now: number;
  data: Data;
  /** The selected item's key: it stays selected when a list reorders. */
  selected?: string;
  /** Where the selection was: the neighbour gets it when the item goes away. */
  cursor: number;
  /** An item to select as soon as it is listed: the pane the app has just started. */
  want?: string;
  /** The first body row on screen. */
  scroll: number;
  dialog?: Dialog;
  note?: Note;
  /** What the app does for the person right now: `starting Codex…`. */
  busy?: string;
}

export type Event =
  | { kind: 'key'; key: string }
  | { kind: 'resize'; width: number; height: number }
  | { kind: 'tick'; now: number }
  | { kind: 'loaded'; source: Source; data: Partial<Omit<Data, 'errors'>> }
  | { kind: 'failed'; source: Source; message: string }
  | { kind: 'busy'; text?: string }
  | { kind: 'note'; note?: Note }
  /** Select an item by its key: the pane the app has just started. */
  | { kind: 'select'; key: string };

export function initialState(options: {
  cwd: string;
  places?: string[];
  version: string;
  width: number;
  height: number;
  now: number;
}): State {
  return {
    cwd: options.cwd,
    places: options.places ?? [options.cwd],
    version: options.version,
    width: options.width,
    height: options.height,
    now: options.now,
    data: { errors: {} },
    cursor: 0,
    scroll: 0,
  };
}

export type Item =
  | { key: string; kind: 'agent'; brain: BrainId }
  | { key: string; kind: 'pane'; pane: PaneRow; live?: SessionInfo }
  /** Runs in another folder and not in a pane: a terminal elsewhere, or a background session. */
  | { key: string; kind: 'running'; session: SessionInfo }
  /** A session of this folder: saved, maybe running, maybe in a pane. */
  | { key: string; kind: 'session'; session: SessionInfo; pane?: string; usage?: SessionUsage };

export type SectionId = 'agents' | 'panes' | 'running' | 'sessions';

export interface Section {
  id: SectionId;
  items: Item[];
}

const time = (session: SessionInfo) => Date.parse(session.updatedAt ?? session.startedAt ?? '') || 0;
const sessionKey = (session: SessionInfo) => `${session.brain}:${session.id}`;

/** The screen's sections and what can be selected in them, top to bottom. */
export function sections(state: State): Section[] {
  const { data } = state;
  const order = data.status?.brains.map((brain) => brain.id) ?? [...BRAIN_IDS];
  const agents: Item[] = order.map((brain) => ({ key: `agent:${brain}`, kind: 'agent', brain }));

  const live = new Map((data.live ?? []).map((session) => [sessionKey(session), session]));
  const liveById = new Map((data.live ?? []).map((session) => [session.id, session]));
  const panes: Item[] = (data.panes ?? []).map((pane) => {
    const session = pane.sessionId ? liveById.get(pane.sessionId) : undefined;
    return { key: `pane:${pane.pane}`, kind: 'pane', pane, ...(session ? { live: session } : {}) };
  });
  const paneOf = new Map<string, string>();
  for (const pane of data.panes ?? []) if (pane.sessionId) paneOf.set(pane.sessionId, pane.pane);

  // This folder's sessions: the saved ones, and running ones not written down yet.
  const saved = new Map((data.sessions ?? []).map((session) => [sessionKey(session), session]));
  const places = new Set(state.places);
  for (const session of data.live ?? []) {
    const here = session.cwd !== undefined && places.has(session.cwd);
    if (here && session.interactive && !saved.has(sessionKey(session))) saved.set(sessionKey(session), session);
  }
  const usage = new Map((data.usage ?? []).map((entry) => [sessionKey(entry), entry]));
  const folder = [...saved.values()]
    .map((session) => {
      const running = live.get(sessionKey(session));
      return running ? { ...session, live: running.live ?? { status: 'busy', kind: 'interactive' } } : session;
    })
    // What runs comes first, then the newest.
    .sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)) || time(b) - time(a));
  const sessionItems: Item[] = folder.map((session) => {
    const pane = paneOf.get(session.id);
    const counted = usage.get(sessionKey(session));
    return {
      key: `session:${sessionKey(session)}`,
      kind: 'session',
      session,
      ...(pane ? { pane } : {}),
      ...(counted ? { usage: counted } : {}),
    };
  });

  const running: Item[] = (data.live ?? [])
    .filter(
      (session) =>
        session.interactive &&
        !saved.has(sessionKey(session)) &&
        !paneOf.has(session.id) &&
        !(session.cwd !== undefined && places.has(session.cwd)),
    )
    .sort((a, b) => time(b) - time(a))
    .map((session) => ({ key: `running:${sessionKey(session)}`, kind: 'running', session }));

  const list: Section[] = [
    { id: 'agents', items: agents },
    { id: 'panes', items: panes },
  ];
  // Only when something runs elsewhere: an empty heading is noise.
  if (running.length > 0) list.push({ id: 'running', items: running });
  list.push({ id: 'sessions', items: sessionItems });
  return list;
}

export function items(state: State): Item[] {
  return sections(state).flatMap((section) => section.items);
}

/**
 * The selected item and its place: the remembered one, or its neighbour if it
 * went away. Before the person moves, the first pane: going back into one is
 * what the app is opened for most.
 */
export function focus(state: State, list: readonly Item[] = items(state)): { item?: Item; index: number } {
  if (list.length === 0) return { index: 0 };
  let found = state.selected === undefined ? -1 : list.findIndex((item) => item.key === state.selected);
  if (state.selected === undefined) found = list.findIndex((item) => item.kind === 'pane');
  const index = found >= 0 ? found : Math.min(Math.max(0, state.cursor), list.length - 1);
  return { item: list[index], index };
}

/** Background sessions are the ones `s` stops: Claude Code's, started with --bg. */
export function stoppable(session: SessionInfo): boolean {
  return session.brain === 'claude' && session.live?.kind === 'background';
}
