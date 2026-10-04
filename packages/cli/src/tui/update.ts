/**
 * What an event does to the state, and what the app should do about it:
 * `update(state, event)` gives the next state and the effects for the runtime
 * to carry out (start a pane, attach to it, close it…). Pure, like the view.
 */
import { BRAINS, type BrainId, type SessionInfo } from '@antondanv/brainyard';

import {
  type Dialog,
  type Effect,
  type Event,
  focus,
  type Item,
  items,
  type Note,
  type State,
  sections,
  stoppable,
} from './state.js';
import { bodyHeight, clampScroll, layout, newChoices, PLAIN } from './view.js';

type Step = [State, Effect[]];

export function update(state: State, event: Event): Step {
  switch (event.kind) {
    case 'key':
      return onKey(state, event.key);
    case 'resize':
      return [reveal({ ...state, width: event.width, height: event.height }), []];
    case 'tick':
      return [{ ...state, now: event.now }, []];
    case 'loaded': {
      const { [event.source]: _gone, ...errors } = state.data.errors;
      return [settle({ ...state, data: { ...state.data, ...event.data, errors } }), []];
    }
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
  }
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
  const list = items(state);
  const { item, index } = focus(state, list);
  // A note answers the last key; the next one clears it.
  const s = withOut({ ...state, note: undefined }, 'note');
  const page = Math.max(1, bodyHeight(state) - 2);
  switch (key) {
    case 'q':
      return [state, [{ kind: 'quit' }]];
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
    case '?':
      return [{ ...s, dialog: { kind: 'help' } }, []];
    case 'ctrl-l':
      return [s, [{ kind: 'refresh' }]];
    case 'esc':
      return [s, []];
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

function startNew(state: State, brain: BrainId): Effect {
  return { kind: 'start', brain, cwd: state.cwd };
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
