/**
 * What an event does to the state, and what the app should do about it:
 * `update(state, event)` gives the next state and the effects for the runtime
 * to carry out (start a pane, attach to it, close it…). Pure, like the view.
 */
import { BRAINS, type BrainId, type SessionInfo } from '@antondanv/brainyard';

import { parseKeys } from './keys.js';
import { listScroll, SETTINGS, type SettingName, settingValue, settingValues } from './pages.js';
import { LAYOUTS, type Layout, PAGES, type Page, type Settings } from './settings.js';
import {
  type Dialog,
  type Effect,
  type Event,
  focus,
  type Item,
  items,
  listFocus,
  listItems,
  type Note,
  type Source,
  type State,
  sections,
  stoppable,
  waitingIds,
} from './state.js';
import { bodyHeight, clampScroll, layout, newChoices, PLAIN } from './view.js';
import { focusedTile, neighbour, type Tile, tiles, wallPage } from './wall.js';

type Step = [State, Effect[]];

export function update(state: State, event: Event): Step {
  switch (event.kind) {
    case 'key':
      return onKey(state, event.key);
    case 'input':
      return onInput(state, event.data);
    case 'resize':
      return [reveal({ ...state, width: event.width, height: event.height }), []];
    case 'tick':
      return [{ ...state, now: event.now }, []];
    case 'loaded':
      return loaded(state, event.source, event.data);
    case 'failed':
      return [
        { ...state, data: { ...state.data, errors: { ...state.data.errors, [event.source]: event.message } } },
        [],
      ];
    case 'busy':
      return [withOut({ ...state, busy: event.text }, 'busy'), []];
    case 'note':
      return [withOut({ ...state, note: event.note }, 'note'), []];
    case 'select': {
      const list = items(state);
      const index = list.findIndex((item) => item.key === event.key);
      // Not listed yet (a pane just started): selected as soon as it is.
      return [index < 0 ? { ...state, want: event.key } : select(state, list, index), []];
    }
    case 'screens':
      return [{ ...state, data: { ...state.data, screens: event.screens } }, []];
    case 'focus':
      return [
        { ...state, page: 'wall', wall: { ...state.wall, focus: event.pane, typing: event.typing === true } },
        [],
      ];
  }
}

function loaded(state: State, source: Source, data: Partial<Omit<State['data'], 'errors'>>): Step {
  const { [source]: _gone, ...errors } = state.data.errors;
  let next = settle({ ...state, data: { ...state.data, ...data, errors } });
  const effects: Effect[] = [];
  // Someone new waits for the person: ring, once, and not for what was waiting at the start.
  if (data.live && state.data.live && state.settings.bell) {
    const before = waitingIds(state.data.live);
    if ([...waitingIds(data.live)].some((id) => !before.has(id))) effects.push({ kind: 'bell' });
  }
  // The pane being typed into has gone.
  if (data.panes && next.wall.typing && !data.panes.some((pane) => pane.pane === next.wall.focus)) {
    next = { ...next, wall: { ...next.wall, typing: false } };
  }
  return [next, effects];
}

/** What the terminal sent: bytes for the tile being typed into, the filter being edited, or keys. */
function onInput(state: State, data: string): Step {
  if (!state.dialog && state.page === 'wall' && state.wall.typing) {
    const here = focusedTile(wallTiles(state), state.wall.focus);
    if (!here) return [{ ...state, wall: { ...state.wall, typing: false } }, []];
    // Ctrl+Q belongs to the app; everything else, Ctrl+C included, to the CLI.
    const at = data.indexOf('\u0011');
    const typed = at < 0 ? data : data.slice(0, at);
    const effects: Effect[] = typed ? [{ kind: 'send', pane: here.pane.pane, data: typed }] : [];
    return [at < 0 ? state : { ...state, wall: { ...state.wall, typing: false } }, effects];
  }
  if (!state.dialog && state.page === 'sessions' && state.list.editing) return filterInput(state, data);
  let current = state;
  const effects: Effect[] = [];
  for (const key of parseKeys(data)) {
    const [next, more] = update(current, { kind: 'key', key });
    current = next;
    effects.push(...more);
  }
  return [current, effects];
}

/** Optional fields go away rather than stay as undefined: states compare and print cleanly. */
function withOut<K extends 'busy' | 'note' | 'dialog' | 'selected'>(state: State, key: K): State {
  if (state[key] !== undefined) return state;
  const { [key]: _gone, ...rest } = state;
  return rest as State;
}

function noted(state: State, text: string, tone: Note['tone'] = 'info'): Step {
  return [{ ...state, note: { text, tone } }, []];
}

function closeDialog(state: State): State {
  const { dialog: _gone, ...rest } = state;
  return rest;
}

/** After new data: the selected item stays selected, or its neighbour takes its place; it stays in view. */
function settle(state: State): State {
  if (state.want !== undefined) {
    const list = items(state);
    const index = list.findIndex((item) => item.key === state.want);
    if (index >= 0) {
      const { want: _done, ...rest } = state;
      return select(rest, list, index);
    }
  }
  if (state.selected === undefined) return reveal(state);
  const { item, index } = focus(state);
  const next = item ? { ...state, selected: item.key, cursor: index } : withOut({ ...state, cursor: 0 }, 'selected');
  return reveal(next);
}

/** Scrolls the body so that the selected item (with its heading, for a section's first) is on screen. */
function reveal(state: State): State {
  if (state.dialog?.kind === 'help') return state;
  const { rows, spans } = layout(state, PLAIN);
  const room = bodyHeight(state);
  let scroll = state.scroll;
  const item = focus(state).item;
  const span = item ? spans.get(item.key) : undefined;
  if (span) {
    if (span.last >= scroll + room) scroll = span.last - room + 1;
    if (span.top < scroll) scroll = span.top;
  }
  scroll = clampScroll(scroll, rows.length, room);
  return scroll === state.scroll ? state : { ...state, scroll };
}

function select(state: State, list: readonly Item[], index: number): State {
  if (list.length === 0) return state;
  const at = Math.max(0, Math.min(list.length - 1, index));
  return reveal({ ...state, selected: list[at]!.key, cursor: at });
}

function onKey(state: State, key: string): Step {
  if (key === 'ctrl-c') return [state, [{ kind: 'quit' }]];
  if (state.dialog) return dialogKey(state, state.dialog, key);
  if (state.page === 'wall' && state.wall.typing) {
    return key === 'ctrl-q' ? [{ ...state, wall: { ...state.wall, typing: false } }, []] : [state, []];
  }
  if (state.page === 'sessions' && state.list.editing) return filterKey(state, key);
  // A note answers the last key; the next one clears it.
  const s = withOut({ ...state, note: undefined }, 'note');
  const digit = Number(key);
  if (Number.isInteger(digit) && digit >= 1 && digit <= PAGES.length) return [toPage(s, PAGES[digit - 1]!), []];
  if (key === '[' || key === ']') {
    const at = PAGES.indexOf(state.page) + (key === ']' ? 1 : -1);
    return [toPage(s, PAGES[(at + PAGES.length) % PAGES.length]!), []];
  }
  switch (key) {
    case 'q':
      return [state, [{ kind: 'quit' }]];
    case '?':
      return [{ ...s, dialog: { kind: 'help' } }, []];
    case 'ctrl-l':
      return [s, [{ kind: 'refresh' }]];
  }
  switch (state.page) {
    case 'overview':
      return overviewKey(state, s, key);
    case 'wall':
      return wallKey(state, s, key);
    case 'sessions':
      return sessionsKey(state, s, key);
    case 'settings':
      return settingsKey(state, s, key);
    case 'usage':
      return key === 'n' ? openNew(s, undefined) : [state, []];
  }
}

function toPage(state: State, page: Page): State {
  return { ...state, page, wall: { ...state.wall, typing: false } };
}

function overviewKey(state: State, s: State, key: string): Step {
  const list = items(state);
  const { item, index } = focus(state, list);
  const page = Math.max(1, bodyHeight(state) - 2);
  switch (key) {
    case 'up':
    case 'k':
      return [select(s, list, index - 1), []];
    case 'down':
    case 'j':
      return [select(s, list, index + 1), []];
    case 'pageup':
      return [select(s, list, index - page), []];
    case 'pagedown':
      return [select(s, list, index + page), []];
    case 'home':
    case 'g':
      return [select(s, list, 0), []];
    case 'end':
    case 'G':
      return [select(s, list, list.length - 1), []];
    case 'tab':
    case 'shift-tab':
      return [jump(s, list, item, key === 'tab' ? 1 : -1), []];
    case 'enter':
      return enter(s, item);
    case 'n':
      return openNew(s, item);
    case 'x':
      return close(s, item);
    case 's':
      return stop(s, item);
    case 'r':
      return resume(s, item);
    case 'esc':
      return [s, []];
    default:
      return [state, []];
  }
}

// ---------------------------------------------------------------------------
// the wall
// ---------------------------------------------------------------------------
function wallTiles(state: State): Tile[] {
  return tiles(state, state.width, bodyHeight(state));
}

function wallKey(state: State, s: State, key: string): Step {
  const list = wallTiles(state);
  const here = focusedTile(list, state.wall.focus);
  const wall = (change: Partial<State['wall']>): Step => [{ ...s, wall: { ...s.wall, ...change } }, []];
  switch (key) {
    case 'left':
    case 'right':
    case 'up':
    case 'down': {
      const next = here ? neighbour(list, here, key) : undefined;
      return next ? wall({ focus: next.pane.pane }) : [s, []];
    }
    case 'tab':
    case 'shift-tab': {
      if (list.length === 0) return [s, []];
      const at = Math.max(0, list.indexOf(here!)) + (key === 'tab' ? 1 : -1);
      return wall({ focus: list[(at + list.length) % list.length]!.pane.pane });
    }
    case 'enter':
      return here ? [s, [{ kind: 'attach', pane: here.pane.pane }]] : [s, []];
    case 'i':
      return here ? wall({ focus: here.pane.pane, typing: true }) : noted(s, 'no tile to type into: n starts one');
    case 'z':
      return here ? wall({ focus: here.pane.pane, zoom: !state.wall.zoom }) : [s, []];
    case 'l': {
      const layout = LAYOUTS[(LAYOUTS.indexOf(state.wall.layout) + 1) % LAYOUTS.length]!;
      const settings: Settings = { ...s.settings, layout };
      return [{ ...s, settings, wall: { ...s.wall, layout, zoom: false } }, [{ kind: 'save', settings }]];
    }
    case 'pagedown':
    case 'pageup': {
      const { page, pages } = wallPage(state, state.width, bodyHeight(state));
      const next = Math.min(pages - 1, Math.max(0, page + (key === 'pagedown' ? 1 : -1)));
      const { focus: _old, ...rest } = s.wall;
      return next === page ? [s, []] : [{ ...s, wall: { ...rest, page: next } }, []];
    }
    case 'x':
      return here ? close(s, { key: `pane:${here.pane.pane}`, kind: 'pane', pane: here.pane }) : [s, []];
    case 'n':
      return openNew(s, here ? { key: `pane:${here.pane.pane}`, kind: 'pane', pane: here.pane } : undefined);
    case 'esc':
      return state.wall.zoom ? wall({ zoom: false }) : [s, []];
    default:
      return [state, []];
  }
}

// ---------------------------------------------------------------------------
// the sessions page
// ---------------------------------------------------------------------------
function pickListed(state: State, list: readonly Item[], index: number): State {
  if (list.length === 0) return state;
  const at = Math.max(0, Math.min(list.length - 1, index));
  const next = { ...state, list: { ...state.list, selected: list[at]!.key, cursor: at } };
  return { ...next, list: { ...next.list, scroll: listScroll(next, Math.max(1, bodyHeight(next) - 2)) } };
}

function sessionsKey(state: State, s: State, key: string): Step {
  const list = listItems(state);
  const { item, index } = listFocus(state, list);
  const page = Math.max(1, bodyHeight(state) - 4);
  switch (key) {
    case 'up':
    case 'k':
      return [pickListed(s, list, index - 1), []];
    case 'down':
    case 'j':
      return [pickListed(s, list, index + 1), []];
    case 'pageup':
      return [pickListed(s, list, index - page), []];
    case 'pagedown':
      return [pickListed(s, list, index + page), []];
    case 'home':
    case 'g':
      return [pickListed(s, list, 0), []];
    case 'end':
    case 'G':
      return [pickListed(s, list, list.length - 1), []];
    case '/':
      return [{ ...s, list: { ...s.list, editing: true } }, []];
    case 'esc':
      return [filtered(s, ''), []];
    case 'enter':
      return enter(s, item);
    case 'r':
      return resume(s, item);
    case 's':
      return stop(s, item);
    case 'x':
      return close(s, item);
    case 'n':
      return openNew(s, item);
    default:
      return [state, []];
  }
}

/** A new filter: the list starts from its top again. */
function filtered(state: State, filter: string, editing = false): State {
  const { selected: _gone, ...rest } = state.list;
  return { ...state, list: { ...rest, filter, editing, cursor: 0, scroll: 0 } };
}

/** Keys while the filter is edited, as tests and named keys give them. */
function filterKey(state: State, key: string): Step {
  if (key === 'enter') return [{ ...state, list: { ...state.list, editing: false } }, []];
  if (key === 'esc') return [filtered(state, ''), []];
  if (key === 'backspace') return [filtered(state, [...state.list.filter].slice(0, -1).join(''), true), []];
  if ([...key].length === 1) return [filtered(state, state.list.filter + key, true), []];
  return [state, []];
}

/** Text typed into the filter as the terminal sent it: letters of any layout stay what they are. */
function filterInput(state: State, data: string): Step {
  let current = state;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are keys, not text.
  for (const part of data.split(/(\u001b\[[0-9;]*[A-Za-z~]|\u001b|\r|\n|\u007f|\u0008)/)) {
    if (!part) continue;
    if (!current.list.editing) break;
    if (part === '\r' || part === '\n') current = onKey(current, 'enter')[0];
    else if (part === '\u001b') current = onKey(current, 'esc')[0];
    else if (part === '\u007f' || part === '\u0008') current = onKey(current, 'backspace')[0];
    else if (!part.startsWith('\u001b')) {
      const text = [...part].filter((char) => char >= ' ').join('');
      if (text) current = filtered(current, current.list.filter + text, true);
    }
  }
  return [current, []];
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
function withSetting(settings: Settings, name: SettingName, value: string): Settings {
  switch (name) {
    case 'bell':
      return { ...settings, bell: value === 'on' };
    case 'theme':
      return { ...settings, theme: value as Settings['theme'] };
    case 'accent':
      return { ...settings, accent: value as Settings['accent'] };
    case 'layout':
      return { ...settings, layout: value as Layout };
    case 'start':
      return { ...settings, start: value as Page };
  }
}

function settingsKey(state: State, s: State, key: string): Step {
  const at = Math.min(Math.max(0, state.setting), SETTINGS.length - 1);
  switch (key) {
    case 'up':
    case 'k':
      return [{ ...s, setting: Math.max(0, at - 1) }, []];
    case 'down':
    case 'j':
      return [{ ...s, setting: Math.min(SETTINGS.length - 1, at + 1) }, []];
    case 'left':
    case 'right':
    case 'h':
    case 'l':
    case 'enter':
    case ' ': {
      const name = SETTINGS[at]!;
      const values = settingValues(name);
      const step = key === 'left' || key === 'h' ? -1 : 1;
      const index = values.indexOf(settingValue(state.settings, name));
      const settings = withSetting(state.settings, name, values[(index + step + values.length) % values.length]!);
      const wall = name === 'layout' ? { ...s.wall, layout: settings.layout } : s.wall;
      return [{ ...s, settings, wall }, [{ kind: 'save', settings }]];
    }
    case 'n':
      return openNew(s, undefined);
    default:
      return [state, []];
  }
}

/** The first item of the next (or previous) section that has any. */
function jump(state: State, list: readonly Item[], item: Item | undefined, step: 1 | -1): State {
  const filled = sections(state).filter((section) => section.items.length > 0);
  if (filled.length === 0) return state;
  const here = filled.findIndex((section) => section.items.some((entry) => entry.key === item?.key));
  const next = filled[(here + step + filled.length) % filled.length]!;
  const first = next.items[0]!.key;
  return select(
    state,
    list,
    list.findIndex((entry) => entry.key === first),
  );
}

function dialogKey(state: State, dialog: Dialog, key: string): Step {
  switch (dialog.kind) {
    case 'help':
      return [closeDialog(state), []];
    case 'confirm':
      return key === 'y' || key === 'Y' ? [closeDialog(state), [dialog.effect]] : [closeDialog(state), []];
    case 'new': {
      const choices = newChoices(state);
      const at = Math.max(0, choices.indexOf(dialog.brain));
      const pick = (index: number): Step => [
        { ...state, dialog: { kind: 'new', brain: choices[(index + choices.length) % choices.length]! } },
        [],
      ];
      if (['left', 'up', 'shift-tab', 'h', 'k'].includes(key)) return pick(at - 1);
      if (['right', 'down', 'tab', 'l', 'j'].includes(key)) return pick(at + 1);
      if (key === 'esc' || key === 'q') return [closeDialog(state), []];
      const digit = Number(key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
        return [closeDialog(state), [startNew(state, choices[digit - 1]!)]];
      }
      if (key === 'enter') return [closeDialog(state), [startNew(state, dialog.brain)]];
      return [state, []];
    }
  }
}

/** From the wall a new pane becomes a tile to type into; elsewhere it takes the screen. */
function startNew(state: State, brain: BrainId): Effect {
  return { kind: 'start', brain, cwd: state.cwd, ...(state.page === 'wall' ? { after: 'type' as const } : {}) };
}

/** Why panes cannot start, if they cannot. */
function noPanes(state: State): string | undefined {
  if (state.data.tmux !== false) return undefined;
  return process.platform === 'win32'
    ? 'panes need tmux, which Windows does not have'
    : `panes need tmux${process.platform === 'darwin' ? ': brew install tmux' : ''}`;
}

function brainOf(item: Item | undefined): BrainId | undefined {
  switch (item?.kind) {
    case 'agent':
      return item.brain;
    case 'pane':
      return item.pane.brain;
    case 'session':
    case 'running':
      return item.session.brain;
    default:
      return undefined;
  }
}

function openNew(state: State, item: Item | undefined): Step {
  const blocked = noPanes(state);
  if (blocked) return noted(state, blocked, 'error');
  const choices = newChoices(state);
  if (choices.length === 0)
    return noted(state, 'no CLI is installed: brainyard status says how to install one', 'error');
  const wanted = brainOf(item);
  const brain = wanted && choices.includes(wanted) ? wanted : choices[0]!;
  return [{ ...state, dialog: { kind: 'new', brain } }, []];
}

/** Where a running session is, and how to get to it from here. */
function elsewhere(state: State, session: SessionInfo): Step {
  if (stoppable(session)) return noted(state, 'it runs in the background: s stops it, then r continues it here');
  return noted(state, 'it is open in another terminal: continue it there, or end it there and r continues it here');
}

function enter(state: State, item: Item | undefined): Step {
  switch (item?.kind) {
    case 'agent': {
      const blocked = noPanes(state);
      if (blocked) return noted(state, blocked, 'error');
      const status = state.data.status?.brains.find((brain) => brain.id === item.brain);
      if (status?.availability === 'not_installed') {
        return noted(state, `${status.label} is not installed${status.fix ? `: ${status.fix}` : ''}`, 'error');
      }
      return [state, [startNew(state, item.brain)]];
    }
    case 'pane':
      return [state, [{ kind: 'attach', pane: item.pane.pane }]];
    case 'session':
      if (item.pane) return [state, [{ kind: 'attach', pane: item.pane }]];
      if (item.session.live) return elsewhere(state, item.session);
      return resumeIn(state, item.session);
    case 'running':
      return elsewhere(state, item.session);
    default:
      return [state, []];
  }
}

function resumeIn(state: State, session: SessionInfo): Step {
  const blocked = noPanes(state);
  if (blocked) return noted(state, blocked, 'error');
  return [state, [{ kind: 'start', brain: session.brain, cwd: session.cwd ?? state.cwd, resume: session.id }]];
}

function close(state: State, item: Item | undefined): Step {
  const pane = item?.kind === 'pane' ? item.pane.pane : item?.kind === 'session' ? item.pane : undefined;
  if (!pane) return noted(state, 'x closes a pane: select one under Panes');
  return [
    {
      ...state,
      dialog: {
        kind: 'confirm',
        question: `Close ${pane}? Its CLI ends; what was said in it stays, and r continues it.`,
        effect: { kind: 'close', pane },
      },
    },
    [],
  ];
}

function stop(state: State, item: Item | undefined): Step {
  const session = item?.kind === 'session' || item?.kind === 'running' ? item.session : undefined;
  if (session && stoppable(session)) {
    const title = session.title ? ` (${session.title.slice(0, 40)})` : '';
    return [
      {
        ...state,
        dialog: {
          kind: 'confirm',
          question: `Stop ${session.id.slice(0, 8)}${title}? It stops working; the conversation stays.`,
          effect: { kind: 'stop', brain: session.brain, sessionId: session.id, cwd: session.cwd ?? state.cwd },
        },
      },
      [],
    ];
  }
  if (item?.kind === 'pane' || (item?.kind === 'session' && item.pane)) {
    return noted(state, 'a pane is closed with x: its CLI ends, the conversation stays');
  }
  return noted(state, `s stops a ${BRAINS.claude.label} background session; this is not one`);
}

function resume(state: State, item: Item | undefined): Step {
  switch (item?.kind) {
    case 'pane':
      return [state, [{ kind: 'attach', pane: item.pane.pane }]];
    case 'session':
      if (item.pane) return [state, [{ kind: 'attach', pane: item.pane }]];
      if (item.session.live) return elsewhere(state, item.session);
      return resumeIn(state, item.session);
    case 'running':
      return elsewhere(state, item.session);
    default:
      return noted(state, 'r continues a saved session: select one under Sessions');
  }
}
