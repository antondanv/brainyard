import { describe, expect, it } from 'vitest';

import { parseKeys } from '../src/tui/keys.js';
import { type Effect, type Event, focus, type State } from '../src/tui/state.js';
import { cells, clean, fit } from '../src/tui/text.js';
import { update } from '../src/tui/update.js';
import { HERE, PANES, world } from './tui-world.js';

/** Presses the keys one by one; the effects of all of them, in order. */
function press(state: State, ...keys: string[]): [State, Effect[]] {
  let current = state;
  const effects: Effect[] = [];
  for (const key of keys) {
    const [next, more] = update(current, { kind: 'key', key });
    current = next;
    effects.push(...more);
  }
  return [current, effects];
}

const selected = (state: State) => focus(state).item?.key;
const apply = (state: State, event: Event) => update(state, event)[0];

const CLAUDE_PANE = 'pane:claude-1a2b3c4d';
const BACKGROUND = 'running:claude:cccc3333-0000-4000-8000-000000000003';
const SAVED = 'session:claude:dddd4444-0000-4000-8000-000000000004';
const IN_PANE = 'session:claude:aaaa1111-0000-4000-8000-000000000001';

describe('moving around', () => {
  it('starts on the first pane, moves by item and by section, and stays within the list', () => {
    const state = world();
    expect(selected(state)).toBe(CLAUDE_PANE);
    expect(selected(press(state, 'down')[0])).toBe('pane:codex-5e6f7a8b');
    expect(selected(press(state, 'j', 'j')[0])).toBe(BACKGROUND);
    expect(selected(press(state, 'up', 'k')[0])).toBe('agent:antigravity');
    expect(selected(press(state, 'home', 'up')[0])).toBe('agent:claude');
    expect(selected(press(state, 'end', 'down')[0])).toBe('session:codex:eeee5555-0000-4000-8000-000000000005');
    // Tab: the first item of the next section that has any, round and round.
    expect(selected(press(state, 'tab')[0])).toBe(BACKGROUND);
    expect(selected(press(state, 'tab', 'tab')[0])).toBe(IN_PANE);
    expect(selected(press(state, 'tab', 'tab', 'tab')[0])).toBe('agent:claude');
    expect(selected(press(state, 'shift-tab')[0])).toBe('agent:claude');
  });

  it('keeps the selected item when lists change, and gives its place to a neighbour when it goes', () => {
    const [onCodex] = press(world(), 'down');
    const reordered = apply(onCodex, { kind: 'loaded', source: 'panes', data: { panes: [...PANES].reverse() } });
    expect(selected(reordered)).toBe('pane:codex-5e6f7a8b');
    const gone = apply(onCodex, { kind: 'loaded', source: 'panes', data: { panes: [PANES[0]!] } });
    // Its place (the second item) now holds the first item of the next section.
    expect(selected(gone)).toBe(BACKGROUND);
  });

  it('selects a pane the app has started as soon as it is listed', () => {
    const state = world({ selected: 'agent:codex' });
    const waiting = apply(state, { kind: 'select', key: 'pane:codex-99999999' });
    expect(selected(waiting)).toBe('agent:codex');
    const meanwhile = apply(waiting, { kind: 'loaded', source: 'live', data: {} });
    expect(meanwhile.want).toBe('pane:codex-99999999');
    const listed = apply(meanwhile, {
      kind: 'loaded',
      source: 'panes',
      data: { panes: [...PANES, { pane: 'codex-99999999', brain: 'codex', attached: false, width: 80, height: 24 }] },
    });
    expect(selected(listed)).toBe('pane:codex-99999999');
    expect(listed.want).toBeUndefined();
  });

  it('scrolls so that the selected item is on screen, with its heading when it is a section’s first', () => {
    const small = world({ height: 12 });
    const [atEnd] = press(small, 'end');
    expect(atEnd.scroll).toBeGreaterThan(0);
    const [back] = press(atEnd, 'home');
    expect(back.scroll).toBe(0);
    const [onPanes] = press(back, 'tab');
    // The blank row and `Panes · 2` above the first pane are on screen too.
    expect(onPanes.scroll).toBeLessThanOrEqual(11);
    expect(apply(atEnd, { kind: 'resize', width: 100, height: 60 }).scroll).toBe(0);
  });
});

describe('keys that act', () => {
  it('Enter goes into a pane, starts a new one from an agent, continues a saved session', () => {
    expect(press(world(), 'enter')[1]).toEqual([{ kind: 'attach', pane: 'claude-1a2b3c4d' }]);
    expect(press(world({ selected: IN_PANE }), 'enter')[1]).toEqual([{ kind: 'attach', pane: 'claude-1a2b3c4d' }]);
    expect(press(world({ selected: 'agent:codex' }), 'enter')[1]).toEqual([
      { kind: 'start', brain: 'codex', cwd: HERE },
    ]);
    expect(press(world({ selected: SAVED }), 'enter')[1]).toEqual([
      { kind: 'start', brain: 'claude', cwd: HERE, resume: 'dddd4444-0000-4000-8000-000000000004' },
    ]);
    const [missing, none] = press(world({ selected: 'agent:opencode' }), 'enter');
    expect(none).toEqual([]);
    expect(missing.note).toEqual({ text: 'OpenCode is not installed: npm install -g opencode-ai', tone: 'error' });
  });

  it('n asks which CLI, starting from the selected one and leaving out what is not installed', () => {
    const [asking] = press(world(), 'n');
    expect(asking.dialog).toEqual({ kind: 'new', brain: 'claude' });
    expect(press(asking, 'right', 'enter')[1]).toEqual([{ kind: 'start', brain: 'codex', cwd: HERE }]);
    // Past Antigravity comes Claude Code again: OpenCode is not installed.
    expect(press(asking, 'right', 'right', 'right')[0].dialog).toEqual({ kind: 'new', brain: 'claude' });
    expect(press(asking, 'left')[0].dialog).toEqual({ kind: 'new', brain: 'antigravity' });
    expect(press(asking, '3')[1]).toEqual([{ kind: 'start', brain: 'antigravity', cwd: HERE }]);
    const [cancelled, nothing] = press(asking, 'esc');
    expect(cancelled.dialog).toBeUndefined();
    expect(nothing).toEqual([]);
    expect(press(world({ selected: 'pane:codex-5e6f7a8b' }), 'n')[0].dialog).toEqual({ kind: 'new', brain: 'codex' });
  });

  it('x closes the pane after a yes; anything else keeps it', () => {
    const [asking] = press(world(), 'x');
    expect(asking.dialog).toMatchObject({ kind: 'confirm', effect: { kind: 'close', pane: 'claude-1a2b3c4d' } });
    expect(press(asking, 'y')[1]).toEqual([{ kind: 'close', pane: 'claude-1a2b3c4d' }]);
    const [kept, none] = press(asking, 'enter');
    expect(none).toEqual([]);
    expect(kept.dialog).toBeUndefined();
    expect(press(world({ selected: IN_PANE }), 'x', 'y')[1]).toEqual([{ kind: 'close', pane: 'claude-1a2b3c4d' }]);
    const [explained] = press(world({ selected: SAVED }), 'x');
    expect(explained.note?.text).toBe('x closes a pane: select one under Panes');
  });

  it('s stops a Claude Code background session in its own folder; elsewhere it says what does', () => {
    const [asking] = press(world({ selected: BACKGROUND }), 's');
    expect(asking.dialog).toMatchObject({
      kind: 'confirm',
      question: expect.stringContaining('Stop cccc3333 (Nightly cleanup)?'),
    });
    expect(press(asking, 'y')[1]).toEqual([
      { kind: 'stop', brain: 'claude', sessionId: 'cccc3333-0000-4000-8000-000000000003', cwd: '/work/other' },
    ]);
    expect(press(world(), 's')[0].note?.text).toBe('a pane is closed with x: its CLI ends, the conversation stays');
    expect(press(world({ selected: SAVED }), 's')[0].note?.text).toBe(
      's stops a Claude Code background session; this is not one',
    );
  });

  it('r continues a saved session in a pane, goes into one that runs in a pane, and explains the rest', () => {
    expect(press(world({ selected: SAVED }), 'r')[1]).toEqual([
      { kind: 'start', brain: 'claude', cwd: HERE, resume: 'dddd4444-0000-4000-8000-000000000004' },
    ]);
    expect(press(world({ selected: IN_PANE }), 'r')[1]).toEqual([{ kind: 'attach', pane: 'claude-1a2b3c4d' }]);
    expect(press(world({ selected: BACKGROUND }), 'r')[0].note?.text).toBe(
      'it runs in the background: s stops it, then r continues it here',
    );
    expect(press(world({ selected: 'agent:claude' }), 'r')[0].note?.text).toBe(
      'r continues a saved session: select one under Sessions',
    );
  });

  it('without tmux nothing starts, and says why', () => {
    const state = world({ selected: 'agent:claude' }, { tmux: false, panes: [] });
    for (const key of ['n', 'enter']) {
      const [next, effects] = press(state, key);
      expect(effects).toEqual([]);
      expect(next.note?.tone).toBe('error');
      expect(next.note?.text).toMatch(/^panes need tmux/);
    }
  });

  it('q and Ctrl+C quit, Ctrl+C even from a question; ? shows the keys until any key; a note lasts one key', () => {
    expect(press(world(), 'q')[1]).toEqual([{ kind: 'quit' }]);
    expect(press(world(), 'x', 'ctrl-c')[1]).toEqual([{ kind: 'quit' }]);
    expect(press(world(), 'ctrl-l')[1]).toEqual([{ kind: 'refresh' }]);
    const [help] = press(world(), '?');
    expect(help.dialog).toEqual({ kind: 'help' });
    const [closed, none] = press(help, 'q');
    expect(closed.dialog).toBeUndefined();
    expect(none).toEqual([]);
    const [noted] = press(world({ selected: SAVED }), 'x');
    expect(noted.note).toBeDefined();
    expect(press(noted, 'down')[0].note).toBeUndefined();
  });
});

describe('data coming in', () => {
  it('a failure is shown until the source reads again', () => {
    const failed = apply(world(), { kind: 'failed', source: 'live', message: 'claude agents timed out' });
    expect(failed.data.errors).toEqual({ live: 'claude agents timed out' });
    const read = apply(failed, { kind: 'loaded', source: 'live', data: { live: [] } });
    expect(read.data.errors).toEqual({});
    expect(read.data.live).toEqual([]);
  });

  it('busy and notes come and go', () => {
    const busy = apply(world(), { kind: 'busy', text: 'starting Codex…' });
    expect(busy.busy).toBe('starting Codex…');
    expect('busy' in apply(busy, { kind: 'busy' })).toBe(false);
    expect(apply(world(), { kind: 'note', note: { text: 'done', tone: 'ok' } }).note).toEqual({
      text: 'done',
      tone: 'ok',
    });
  });
});

describe('keys from a terminal', () => {
  it('reads arrows, Enter, Esc, Tab, control keys and characters, several in one read', () => {
    expect(parseKeys('\u001b[A\u001b[B\u001bOC\u001b[D')).toEqual(['up', 'down', 'right', 'left']);
    expect(parseKeys('\r\n\r\t\u001b[Z')).toEqual(['enter', 'enter', 'tab', 'shift-tab']);
    expect(parseKeys('\u001b')).toEqual(['esc']);
    expect(parseKeys('\u0003\u0011\u000c\u007f')).toEqual(['ctrl-c', 'ctrl-q', 'ctrl-l', 'backspace']);
    expect(parseKeys('\u001b[5~\u001b[6~\u001b[1~\u001b[4~\u001b[3~')).toEqual([
      'pageup',
      'pagedown',
      'home',
      'end',
      'delete',
    ]);
    expect(parseKeys('nx?')).toEqual(['n', 'x', '?']);
    expect(parseKeys('\u001b[1;5A')).toEqual(['up']);
  });

  it('takes Russian letters by their place on the keyboard and leaves mouse reports out', () => {
    expect(parseKeys('йтчыкн')).toEqual(['q', 'n', 'x', 's', 'r', 'y']);
    expect(parseKeys('\u001b[<64;10;5M\u001b[<0;3;4m')).toEqual([]);
    expect(parseKeys('漢🔥')).toEqual(['漢', '🔥']);
  });

  it('leaves a paste out where nothing takes text, and gives it to the filter where it does', () => {
    // "fix query" pasted on the overview is not x, then q.
    expect(update(world(), { kind: 'input', data: '\u001b[200~fix query\u001b[201~' })).toEqual([world(), []]);
    const [, after] = update(world(), { kind: 'input', data: '\u001b[200~xq\u001b[201~?' });
    expect(after).toEqual([]);
    expect(update(world(), { kind: 'input', data: '\u001b[200~xq\u001b[201~?' })[0].dialog).toEqual({ kind: 'help' });
    const editing = world({ page: 'sessions', list: { ...world().list, editing: true } });
    expect(update(editing, { kind: 'input', data: '\u001b[200~crdt\u001b[201~' })[0].list.filter).toBe('crdt');
  });
});

describe('text in cells', () => {
  it('counts wide characters as two cells and colours as none', () => {
    expect(cells('abc')).toBe(3);
    expect(cells('Привет')).toBe(6);
    expect(cells('漢字')).toBe(4);
    expect(cells('🔥 ok')).toBe(5);
    expect(cells('\u001b[2mdim\u001b[22m')).toBe(3);
    expect(cells('é')).toBe(1);
  });

  it('fits to a width: pads, or cuts with … and closes a colour it cut', () => {
    expect(fit('abc', 5)).toBe('abc  ');
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(fit('漢字漢字', 5)).toBe('漢字…');
    expect(fit('漢字漢字', 4)).toBe('漢… ');
    expect(fit('\u001b[31mred text\u001b[39m', 5)).toBe('\u001b[31mred …\u001b[0m');
    expect(cells(fit('\u001b[31mred text\u001b[39m', 5))).toBe(5);
  });

  it('keeps colours from outside but no other escape sequence or control character', () => {
    expect(clean('a\nb\tc')).toBe('a b c');
    expect(clean('x\u001b[2J\u001b[Hy')).toBe('xy');
    expect(clean('\u001b]8;;http://x\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(clean('\u001b[1mbold\u001b[22m')).toBe('\u001b[1mbold\u001b[22m');
    expect(clean('a\u009b2Jb')).toBe('a 2Jb');
  });
});
