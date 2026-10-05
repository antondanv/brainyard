/**
 * The app at run time: it reads the CLIs on a schedule, feeds what it reads
 * to `update()`, carries out the effects and hands each new frame to its
 * host. The host owns the screen: a terminal (`terminal.ts`), or later a
 * browser. Reading stops while a pane has the screen.
 */
import {
  BRAINS,
  type BrainId,
  type BrainUsage,
  BrainyardError,
  capturePane,
  closePane,
  findPaneSession,
  listPanes,
  liveSessions,
  type PaneScreen,
  type PaneStart,
  paneMemory,
  panesAvailable,
  resizePane,
  type SessionInfo,
  type SessionUsage,
  type StatusReport,
  sendToPane,
  sessions,
  startPane,
  status,
  stopSession,
  usage,
} from '@antondanv/brainyard';

import type { PaneRow } from '../panes.js';
import { type Paint, palette } from '../term.js';
import { type Settings, saveSettings, themeOf } from './settings.js';
import { type Effect, type Event, initialState, type Source, type State, tr } from './state.js';
import { update } from './update.js';
import { bodyHeight, render } from './view.js';
import { tiles } from './wall.js';

/** Where the app reads and what it changes: the API, or stand-ins in tests. */
export interface Sources {
  status(): Promise<StatusReport>;
  limits(): Promise<BrainUsage[]>;
  panes(): Promise<{ tmux: boolean; panes: PaneRow[] }>;
  live(): Promise<SessionInfo[]>;
  sessions(cwd: string): Promise<SessionInfo[]>;
  usage(cwd: string): Promise<SessionUsage[]>;
  startPane(options: {
    brain: BrainId;
    cwd: string;
    resume?: string;
    width: number;
    height: number;
  }): Promise<PaneStart>;
  closePane(pane: string): Promise<boolean>;
  stopSession(options: { brain: BrainId; sessionId: string; cwd: string }): Promise<'stopped' | 'not-running'>;
  /** A tile's screen; `scroll` rows up into its history. */
  capture(pane: string, scroll?: number): Promise<PaneScreen | undefined>;
  /** A pane made the size of its tile. */
  resize(pane: string, width: number, height: number): Promise<boolean>;
  /** Bytes typed into a tile. */
  send(pane: string, data: string): Promise<void>;
  saveSettings(settings: Settings): void;
}

export interface AppHost {
  /** A new frame: exactly the state's height in rows of its width in cells. */
  draw(lines: string[]): void;
  /**
   * Gives the pane the whole screen; resolves when the person is back (Ctrl+Q) or the CLI has ended.
   * The state is the app's at that moment: its size and language.
   */
  attach(pane: string, state: State): Promise<void>;
  /** Ctrl+L: whatever is on screen is drawn anew. */
  redraw?(): void;
  /** Someone started waiting for the person. */
  bell?(): void;
  quit(): void;
}

export interface AppOptions {
  cwd: string;
  places?: string[];
  version: string;
  width: number;
  height: number;
  colour: boolean;
  host: AppHost;
  sources?: Partial<Sources>;
  /** Milliseconds between reads of each source. */
  every?: Partial<Record<Source, number>>;
  clock?: () => number;
  settings?: Settings;
  /** Where the settings are kept, to show on the settings page. */
  settingsFile?: string;
}

export interface App {
  dispatch(event: Event): void;
  /** The frame for the current state. */
  frame(): string[];
  state(): State;
  /** Resolves when nothing is being read or done any more: for tests. */
  idle(): Promise<void>;
  stop(): void;
}

/**
 * Panes are cheap to read (one tmux call and one `ps`); `claude agents` and the
 * stores less so; quotas and status ask the CLIs, so they are read seldom.
 */
const EVERY: Record<Source, number> = {
  panes: 2_000,
  live: 10_000,
  sessions: 15_000,
  usage: 60_000,
  limits: 180_000,
  status: 300_000,
};
/** The order of the first reads: what is cheap comes first. */
const FIRST: readonly Source[] = ['panes', 'sessions', 'status', 'live', 'usage', 'limits'];

export function startApp(options: AppOptions): App {
  const clock = options.clock ?? Date.now;
  const sources = { ...apiSources(), ...options.sources };
  const host = options.host;
  let state = initialState({
    cwd: options.cwd,
    ...(options.places ? { places: options.places } : {}),
    version: options.version,
    width: options.width,
    height: options.height,
    now: clock(),
    ...(options.settings ? { settings: options.settings } : {}),
  });
  if (options.settingsFile) state = { ...state, settingsFile: options.settingsFile };
  // The theme can change on the settings page: the palette follows it.
  let painted: { settings: Settings; paint: Paint } | undefined;
  const paintOf = (settings: Settings) => {
    if (painted?.settings !== settings) painted = { settings, paint: palette(options.colour, themeOf(settings)) };
    return painted.paint;
  };
  let stopped = false;
  let attached = false;
  let drawing = false;
  const reading = new Set<Source>();
  const again = new Set<Source>();
  const work = new Set<Promise<unknown>>();
  const timers: NodeJS.Timeout[] = [];

  const track = <T>(promise: Promise<T>): Promise<T> => {
    work.add(promise);
    void promise.finally(() => work.delete(promise)).catch(() => undefined);
    return promise;
  };

  const frame = () => render({ ...state, now: clock() }, paintOf(state.settings));

  function schedule(): void {
    if (drawing) return;
    drawing = true;
    setImmediate(() => {
      drawing = false;
      if (stopped || attached) return;
      host.draw(frame());
      fitTiles();
    });
  }

  // The wall: each pane is made the size of its tile, as a compositor sizes its windows.
  const sized = new Map<string, string>();
  function fitTiles(): void {
    if (state.page !== 'wall') return;
    for (const tile of tiles(state, state.width, bodyHeight(state))) {
      const width = Math.max(20, tile.width - 2);
      const height = Math.max(5, tile.height - 2);
      const size = `${width}x${height}`;
      // A pane someone has full screen belongs to that terminal's size.
      if (tile.pane.attached || sized.get(tile.pane.pane) === size) continue;
      sized.set(tile.pane.pane, size);
      void track(sources.resize(tile.pane.pane, width, height).catch(() => false));
    }
  }

  // The tiles' screens: read often while someone types into one, less when only watched.
  let capturing = false;
  let captured = 0;
  async function captureTiles(): Promise<void> {
    if (stopped || attached || capturing || state.page !== 'wall' || state.dialog?.kind === 'help') return;
    const now = clock();
    if (!state.wall.typing && now - captured < 300) return;
    capturing = true;
    captured = now;
    try {
      const list = tiles(state, state.width, bodyHeight(state));
      const screens: Record<string, PaneScreen> = {};
      await Promise.all(
        list.map(async (tile) => {
          const screen = await sources.capture(tile.pane.pane).catch(() => undefined);
          if (screen) screens[tile.pane.pane] = screen;
        }),
      );
      if (list.length > 0) dispatch({ kind: 'screens', screens });
    } finally {
      capturing = false;
    }
  }

  // Keys typed into a tile keep their order, one pane after another.
  let typing: Promise<void> = Promise.resolve();

  function dispatch(event: Event): void {
    if (stopped) return;
    const [next, effects] = update(state, event);
    state = next;
    schedule();
    for (const effect of effects) void track(perform(effect));
  }

  const loaders: Record<Source, () => Promise<Partial<State['data']>>> = {
    status: async () => ({ status: await sources.status() }),
    limits: async () => ({ limits: await sources.limits() }),
    panes: () => sources.panes(),
    live: async () => ({ live: await sources.live() }),
    sessions: async () => ({ sessions: await sources.sessions(options.cwd) }),
    usage: async () => ({ usage: await sources.usage(options.cwd) }),
  };

  /** Reads a source; asked while it is being read, it reads once more after, so nothing stale wins. */
  function read(source: Source): void {
    if (stopped) return;
    if (reading.has(source)) {
      again.add(source);
      return;
    }
    reading.add(source);
    void track(
      loaders[source]()
        .then(
          (data) => dispatch({ kind: 'loaded', source, data }),
          (error: unknown) => dispatch({ kind: 'failed', source, message: messageOf(error) }),
        )
        .finally(() => {
          reading.delete(source);
          if (again.delete(source)) read(source);
        }),
    );
  }

  async function attach(pane: string): Promise<void> {
    attached = true;
    try {
      await host.attach(pane, state);
    } catch (error) {
      dispatch({ kind: 'note', note: { text: messageOf(error), tone: 'error' } });
    } finally {
      attached = false;
      // Full screen, the pane took the screen's size: on the wall it gets its tile's again.
      sized.delete(pane);
      dispatch({ kind: 'resize', width: state.width, height: state.height });
      for (const source of ['panes', 'live', 'sessions', 'usage'] as const) read(source);
    }
  }

  async function perform(effect: Effect): Promise<void> {
    switch (effect.kind) {
      case 'quit':
        stop();
        host.quit();
        return;
      case 'refresh':
        host.redraw?.();
        for (const source of FIRST) read(source);
        return;
      case 'attach':
        return attach(effect.pane);
      case 'start': {
        const label = BRAINS[effect.brain].label;
        const t = tr(state);
        dispatch({
          kind: 'busy',
          text: effect.resume ? t('continuing in {cli}…', { cli: label }) : t('starting {cli}…', { cli: label }),
        });
        let started: PaneStart;
        try {
          started = await sources.startPane({
            brain: effect.brain,
            cwd: effect.cwd,
            ...(effect.resume ? { resume: effect.resume } : {}),
            width: state.width,
            height: state.height,
          });
        } catch (error) {
          dispatch({ kind: 'busy' });
          dispatch({ kind: 'note', note: { text: messageOf(error), tone: 'error' } });
          return;
        }
        dispatch({ kind: 'busy' });
        if (started.warnings.length > 0)
          dispatch({ kind: 'note', note: { text: started.warnings.join(' · '), tone: 'info' } });
        dispatch({ kind: 'select', key: `pane:${started.pane}` });
        read('panes');
        // From the wall: a new tile to type into, the wall stays.
        if (effect.after === 'type') {
          dispatch({ kind: 'focus', pane: started.pane, typing: true });
          return;
        }
        return attach(started.pane);
      }
      case 'send':
        typing = typing
          .then(() => sources.send(effect.pane, effect.data))
          .catch((error: unknown) => dispatch({ kind: 'note', note: { text: messageOf(error), tone: 'error' } }));
        await typing;
        // What was typed shows at once, not at the next look.
        captured = 0;
        void track(captureTiles());
        return;
      case 'bell':
        host.bell?.();
        return;
      case 'save':
        try {
          sources.saveSettings(effect.settings);
        } catch (error) {
          const text = tr(state)('settings not kept: {reason}', { reason: messageOf(error) });
          dispatch({ kind: 'note', note: { text, tone: 'error' } });
        }
        return;
      case 'close': {
        try {
          const closed = await sources.closePane(effect.pane);
          dispatch({
            kind: 'note',
            note: closed
              ? {
                  text: tr(state)('closed {pane} · what was said in it stays: r continues it from Sessions', {
                    pane: effect.pane,
                  }),
                  tone: 'ok',
                }
              : { text: tr(state)('{pane} has already ended', { pane: effect.pane }), tone: 'info' },
          });
        } catch (error) {
          dispatch({ kind: 'note', note: { text: messageOf(error), tone: 'error' } });
        }
        for (const source of ['panes', 'live', 'sessions'] as const) read(source);
        return;
      }
      case 'stop': {
        const id = effect.sessionId.slice(0, 8);
        dispatch({ kind: 'busy', text: tr(state)('stopping {id}…', { id }) });
        try {
          const result = await sources.stopSession({
            brain: effect.brain,
            sessionId: effect.sessionId,
            cwd: effect.cwd,
          });
          dispatch({
            kind: 'note',
            note:
              result === 'stopped'
                ? {
                    text: tr(state)('stopped {id} · its conversation stays: r continues it in a pane', { id }),
                    tone: 'ok',
                  }
                : { text: tr(state)('{id} has already stopped', { id }), tone: 'info' },
          });
        } catch (error) {
          dispatch({ kind: 'note', note: { text: messageOf(error), tone: 'error' } });
        } finally {
          dispatch({ kind: 'busy' });
        }
        for (const source of ['live', 'sessions'] as const) read(source);
        return;
      }
    }
  }

  function stop(): void {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
  }

  for (const source of FIRST) {
    read(source);
    const every = options.every?.[source] ?? EVERY[source];
    timers.push(
      setInterval(() => {
        if (!attached) read(source);
      }, every),
    );
  }
  // How long ago and how long until a reset move on even when nothing is read.
  timers.push(setInterval(() => dispatch({ kind: 'tick', now: clock() }), 15_000));
  timers.push(setInterval(() => void track(captureTiles()), 100));

  return {
    dispatch,
    frame,
    state: () => state,
    idle: async () => {
      while (work.size > 0) await Promise.allSettled([...work]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    stop,
  };
}

function messageOf(error: unknown): string {
  if (error instanceof BrainyardError) return error.fix ? `${error.message} → ${error.fix}` : error.message;
  return (error as Error)?.message ?? String(error);
}

/** How many sessions of each CLI the folder list shows. */
const FOLDER_LIMIT = 20;

/** The app's reads and changes through the API. */
export function apiSources(): Sources {
  // Codex, Antigravity and OpenCode name a pane's session only after it starts:
  // once found in the store it is remembered; until then it is looked up now and then.
  const found = new Map<string, string>();
  const lookedUp = new Map<string, number>();
  return {
    status: () => status(),
    // Quota requests only: a paid call (Claude Code's windows) is `brainyard usage --live`.
    limits: async () => (await usage({ limit: 0 })).brains,
    panes: async () => {
      if (!panesAvailable()) return { tmux: false, panes: [] };
      const now = Date.now();
      const listed = await listPanes();
      const named = await Promise.all(
        listed.map(async (pane) => {
          if (pane.sessionId) return pane;
          const known = found.get(pane.pane);
          if (known) return { ...pane, sessionId: known };
          if (now - (lookedUp.get(pane.pane) ?? 0) < 10_000) return pane;
          lookedUp.set(pane.pane, now);
          const session = await findPaneSession(pane).catch(() => undefined);
          if (!session) return pane;
          found.set(pane.pane, session.id);
          return { ...pane, sessionId: session.id };
        }),
      );
      const memory = await paneMemory(named);
      const panes = named
        .map((pane) => {
          const used = memory.get(pane.pane);
          return used === undefined ? pane : { ...pane, memory: used };
        })
        .sort((a, b) => (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0));
      return { tmux: true, panes };
    },
    // Codex shows some approval dialogs only on screen: look at the panes too.
    live: () => liveSessions({ panes: {} }),
    sessions: (cwd) => sessions({ cwd, live: false, limit: FOLDER_LIMIT }),
    // Saved stores only: the quotas are read on their own, less often.
    usage: async (cwd) => (await usage({ cwd, limit: FOLDER_LIMIT, offline: true })).sessions,
    startPane: (options) => startPane(options),
    closePane: (pane) => closePane(pane),
    stopSession: (options) => stopSession(options),
    capture: (pane, scroll) => capturePane(pane, scroll ? { scroll } : {}),
    resize: (pane, width, height) => resizePane(pane, width, height),
    send: (pane, data) => sendToPane(pane, data),
    saveSettings: (settings) => saveSettings(settings),
  };
}
