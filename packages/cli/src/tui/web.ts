/**
 * The app in a browser: the frames a terminal would show go to every page
 * that watches, only the rows that changed; keys come back as the bytes a
 * terminal sends, clicks and the wheel by cell. Entering a pane shows its
 * screen as tmux would, with every key going to its CLI until Ctrl+Q.
 */
import { resolve } from 'node:path';

import { BRAINS, type PaneScreen, tidyPaths } from '@antondanv/brainyard';

import { palette } from '../term.js';
import { VERSION } from '../version.js';
import { type App, type AppOptions, apiSources, type Sources, startApp } from './app.js';
import { loadSettings, type Settings, settingsPath, themeOf } from './settings.js';
import { type MouseAction, type State, tr } from './state.js';
import { placesOf } from './terminal.js';
import { cells, clean, fit, invertCell } from './text.js';

/** What a watching page gets: a frame (only the rows that changed, unless `full`), the bell, the end. */
export type WebEvent =
  | { kind: 'frame'; width: number; height: number; rows: Record<number, string>; full: boolean }
  | { kind: 'bell' }
  | { kind: 'quit' };

export interface WebScreen {
  /** The frames from now on, the whole one on screen first; gives back how to stop watching. */
  watch(listener: (event: WebEvent) => void): () => void;
  /** What was typed, as the bytes a terminal sends. */
  input(data: string): void;
  /** Pasted text: a CLI takes it as one paste, not as lines typed and sent one by one. */
  paste(text: string): void;
  /** A click, a double click or a turn of the wheel at a cell (0-based). */
  mouse(action: MouseAction, x: number, y: number): void;
  /** The page's size in cells. */
  resize(width: number, height: number): void;
  /** The pane on screen, when one is. */
  pane(): string | undefined;
  app: App;
  /** Resolves when nothing is being read, done or looked at: for tests. */
  idle(): Promise<void>;
  stop(): void;
}

export interface WebOptions {
  cwd?: string;
  width?: number;
  height?: number;
  sources?: Partial<Sources>;
  every?: AppOptions['every'];
  clock?: () => number;
  settings?: Settings;
  settingsFile?: string;
  /** The person quit (q): whoever shows the app stops too. */
  onQuit?: () => void;
  /** Milliseconds between looks at the pane on screen. */
  look?: number;
}

/** A page can be as small as a phone or as large as a wall of monitors: nothing silly either way. */
const SIZE = { width: [20, 500], height: [5, 200] } as const;
const RESET = '\u001b[0m';
const CTRL_Q = '\u0011';
/** Rows of history one turn of the wheel scrolls in a pane. */
const WHEEL = 3;

interface OnScreen {
  name: string;
  /** Rows up into the history; 0 is the live screen. */
  scroll: number;
  screen?: PaneScreen;
  /** The app's state when the pane was entered: its language, its theme, what the pane is. */
  state: State;
  leave(): void;
}

export function startWeb(options: WebOptions = {}): WebScreen {
  const cwd = resolve(options.cwd ?? process.cwd());
  const sources: Sources = { ...apiSources(), ...options.sources };
  const listeners = new Set<(event: WebEvent) => void>();
  let size = {
    width: clamp(options.width ?? 120, SIZE.width),
    height: clamp(options.height ?? 36, SIZE.height),
  };
  let shown: string[] = [];
  /** The next frame goes whole: after a resize or Ctrl+L. */
  let whole = true;
  let pane: OnScreen | undefined;
  let looking = false;
  let typing: Promise<void> = Promise.resolve();
  const work = new Set<Promise<unknown>>();

  const track = <T>(promise: Promise<T>): Promise<T> => {
    work.add(promise);
    void promise.finally(() => work.delete(promise)).catch(() => undefined);
    return promise;
  };

  const emit = (event: WebEvent) => {
    for (const listener of listeners) listener(event);
  };

  function draw(lines: string[]): void {
    const rows: Record<number, string> = {};
    let changed = whole || lines.length !== shown.length;
    for (const [row, line] of lines.entries()) {
      if (!whole && shown[row] === line) continue;
      rows[row] = line;
      changed = true;
    }
    shown = lines;
    if (!changed) return;
    const full = whole;
    whole = false;
    emit({ kind: 'frame', width: size.width, height: lines.length, rows, full });
  }

  // ---------------------------------------------------------------------------
  // a pane on screen
  // ---------------------------------------------------------------------------
  async function look(): Promise<void> {
    const here = pane;
    if (!here || looking) return;
    looking = true;
    try {
      const screen = await sources.capture(here.name, here.scroll || undefined).catch(() => undefined);
      if (pane !== here) return;
      // The CLI ended, or the pane was closed from elsewhere: back to the app.
      if (!screen) return here.leave();
      here.screen = screen;
      draw(paneLines(here, screen, size.width, size.height));
    } finally {
      looking = false;
    }
  }

  function attach(name: string, state: State): Promise<void> {
    return new Promise<void>((done) => {
      // Looks on a schedule are not work to wait for: they go on as long as the pane is on screen.
      const timer = setInterval(() => void look(), options.look ?? 100);
      pane = {
        name,
        scroll: 0,
        state,
        leave: () => {
          clearInterval(timer);
          if (pane?.name === name) pane = undefined;
          done();
        },
      };
      // One row stays for the bar below the CLI, as tmux keeps its status line.
      void track(
        sources
          .resize(name, size.width, size.height - 1)
          .catch(() => false)
          .then(() => look()),
      );
    });
  }

  /** Bytes for the pane on screen, in the order they were typed; what was typed shows at once. */
  function type(here: OnScreen, data: string): void {
    here.scroll = 0;
    typing = typing.then(() => sources.send(here.name, data)).catch(() => undefined);
    void track(typing.then(() => look()));
  }

  function paneInput(here: OnScreen, data: string): void {
    // Ctrl+Q belongs to Brainyard; everything else, Ctrl+C and Esc included, to the CLI.
    const at = data.indexOf(CTRL_Q);
    const typed = at < 0 ? data : data.slice(0, at);
    if (typed) type(here, typed);
    if (at >= 0) here.leave();
  }

  function paneMouse(here: OnScreen, action: MouseAction, x: number, y: number): void {
    // The bar below the CLI leads back.
    if (y >= size.height - 1) {
      if (action === 'click' || action === 'double') here.leave();
      return;
    }
    const screen = here.screen;
    if (screen?.mouseTracking && screen.mouseSgr) {
      // The CLI handles the mouse itself: it gets the reports its terminal would send.
      const at = `${x + 1};${y + 1}`;
      if (action === 'wheel-up') type(here, `\u001b[<64;${at}M`);
      else if (action === 'wheel-down') type(here, `\u001b[<65;${at}M`);
      else type(here, `\u001b[<0;${at}M\u001b[<0;${at}m`);
      return;
    }
    if (action !== 'wheel-up' && action !== 'wheel-down') return;
    // Otherwise the wheel goes through what the CLI printed before, as tmux's copy mode does.
    const step = action === 'wheel-up' ? WHEEL : -WHEEL;
    const scroll = Math.max(0, Math.min(screen?.historySize ?? 0, here.scroll + step));
    if (scroll === here.scroll) return;
    here.scroll = scroll;
    void track(look());
  }

  // ---------------------------------------------------------------------------
  // the app
  // ---------------------------------------------------------------------------
  const file = settingsPath();
  const app = startApp({
    cwd,
    places: placesOf(cwd),
    version: VERSION,
    ...size,
    colour: true,
    settings: options.settings ?? loadSettings(file),
    settingsFile: options.settingsFile ?? tidyPaths(file),
    ...(options.sources ? { sources: options.sources } : {}),
    ...(options.every ? { every: options.every } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    host: {
      draw,
      attach,
      redraw: () => {
        whole = true;
      },
      bell: () => emit({ kind: 'bell' }),
      quit: () => {
        pane?.leave();
        emit({ kind: 'quit' });
        options.onQuit?.();
      },
    },
  });

  function input(data: string): void {
    if (!data) return;
    if (pane) paneInput(pane, data);
    else app.dispatch({ kind: 'input', data });
  }

  return {
    watch(listener) {
      listeners.add(listener);
      const rows = Object.fromEntries(shown.entries());
      listener({ kind: 'frame', width: size.width, height: shown.length, rows, full: true });
      return () => {
        listeners.delete(listener);
      };
    },
    input,
    paste(text) {
      // As a terminal pastes: lines end in CR, and control characters that would act as keys go.
      const body = text
        .replace(/\r?\n/g, '\r')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what goes.
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      if (body) input(`\u001b[200~${body}\u001b[201~`);
    },
    mouse(action, x, y) {
      if (pane) paneMouse(pane, action, x, y);
      else app.dispatch({ kind: 'mouse', action, x, y });
    },
    resize(width, height) {
      const next = { width: clamp(width, SIZE.width), height: clamp(height, SIZE.height) };
      if (next.width === size.width && next.height === size.height) return;
      size = next;
      whole = true;
      app.dispatch({ kind: 'resize', ...size });
      if (pane) {
        const here = pane;
        void track(
          sources
            .resize(here.name, size.width, size.height - 1)
            .catch(() => false)
            .then(() => look()),
        );
      }
    },
    pane: () => pane?.name,
    app,
    idle: async () => {
      // While a pane is on screen the app waits for the person to come back: that is not work.
      if (!pane) await app.idle();
      while (work.size > 0) await Promise.allSettled([...work]);
    },
    stop() {
      pane?.leave();
      app.stop();
      listeners.clear();
    },
  };
}

/**
 * A pane on screen: the CLI's rows, its cursor where its terminal would show it, and a bar below, as
 * `brainyard pane attach` has from tmux: what runs there and the way back.
 */
function paneLines(here: OnScreen, screen: PaneScreen, width: number, height: number): string[] {
  const { state } = here;
  const c = palette(true, themeOf(state.settings));
  const t = tr(state);
  const lines: string[] = [];
  for (let row = 0; row < height - 1; row++) {
    let text = clean(screen.lines[row] ?? '');
    if (!here.scroll && screen.cursor.visible && screen.cursor.y === row) text = invertCell(text, screen.cursor.x);
    const content = fit(text, width);
    // The CLI's own colours end on its row.
    lines.push(content.includes('\u001b') ? `${content}${RESET}` : content);
  }
  const info = state.data.panes?.find((each) => each.pane === here.name);
  const label = info?.brain ? BRAINS[info.brain].label : '';
  const where = here.scroll
    ? c.yellow(t('↑ {rows} rows back · the wheel down returns', { rows: here.scroll }))
    : c.dim([label, here.name, info?.label ? clean(info.label) : ''].filter(Boolean).join(' · '));
  const left = ` ${c.accent('◂ Brainyard')}  ${where}`;
  const right = `${c.gray(t('Ctrl+Q — back to Brainyard'))} `;
  const gap = width - cells(left) - cells(right);
  lines.push(fit(gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : left, width));
  return lines;
}

function clamp(value: number, [least, most]: readonly [number, number]): number {
  return Math.max(least, Math.min(most, Math.round(Number.isFinite(value) ? value : least)));
}
