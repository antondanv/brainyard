import { describe, expect, it } from 'vitest';

import { targetAt } from '../src/tui/mouse.js';
import { DEFAULT_SETTINGS } from '../src/tui/settings.js';
import { listFocus, type State } from '../src/tui/state.js';
import { update } from '../src/tui/update.js';
import { PLAIN, render } from '../src/tui/view.js';
import { tiles } from '../src/tui/wall.js';
import { PANES, world } from './tui-world.js';

/** Where a text is on screen, as a person would point at it: its first cell. */
function find(state: State, text: string, row?: number): { x: number; y: number } {
  const frame = render(state, PLAIN);
  for (const [y, line] of frame.entries()) {
    if (row !== undefined && y !== row) continue;
    const x = line.indexOf(text);
    if (x >= 0) return { x: [...line.slice(0, x)].length, y };
  }
  throw new Error(`"${text}" is not on screen:\n${frame.join('\n')}`);
}

const click = (state: State, at: { x: number; y: number }, action: 'click' | 'double' = 'click') =>
  update(state, { kind: 'mouse', action, ...at });

describe('where a click lands', () => {
  it('on a tab: its page, on a wide screen and on a narrow one', () => {
    const wide = world({ width: 120 });
    expect(targetAt(wide, find(wide, 'Wall').x, 0)).toEqual({ kind: 'tab', page: 'wall' });
    expect(targetAt(wide, find(wide, '5 Settings').x + 3, 0)).toEqual({ kind: 'tab', page: 'settings' });
    // The name and the version are not a tab.
    expect(targetAt(wide, 2, 0)).toBeUndefined();
    const narrow = world({ width: 44 });
    const header = render(narrow, PLAIN)[0]!;
    expect(header).toContain('[1 Overview]');
    expect(targetAt(narrow, header.indexOf('3'), 0)).toEqual({ kind: 'tab', page: 'sessions' });
  });

  it('on the overview: an agent card by its column, a pane and a session by their rows', () => {
    const state = world({ width: 120, height: 40 });
    expect(targetAt(state, find(state, 'Codex').x, find(state, 'Codex').y)).toEqual({
      kind: 'item',
      key: 'agent:codex',
    });
    expect(targetAt(state, find(state, 'Antigravity').x, find(state, 'Antigravity').y + 1)).toEqual({
      kind: 'item',
      key: 'agent:antigravity',
    });
    expect(targetAt(state, 10, find(state, 'auth refactor').y)).toEqual({ kind: 'item', key: 'pane:claude-1a2b3c4d' });
    expect(targetAt(state, 10, find(state, 'Fix the flaky test').y)).toEqual({
      kind: 'item',
      key: 'session:claude:dddd4444-0000-4000-8000-000000000004',
    });
    // The two lines below the body are not items.
    expect(targetAt(state, 10, state.height - 1)).toBeUndefined();
  });

  it('on the overview scrolled: the row on screen, not the row it would be unscrolled', () => {
    const state = world({ width: 80, height: 14, selected: 'session:codex:eeee5555-0000-4000-8000-000000000005' });
    const [scrolled] = update(state, { kind: 'resize', width: 80, height: 14 });
    expect(scrolled.scroll).toBeGreaterThan(0);
    const at = find(scrolled, 'Explain CRDTs');
    expect(targetAt(scrolled, at.x, at.y)).toEqual({
      kind: 'item',
      key: 'session:codex:eeee5555-0000-4000-8000-000000000005',
    });
  });

  it('on the wall: the tile under it', () => {
    const state = world({ page: 'wall', width: 120, height: 34 });
    const list = tiles(state, state.width, state.height - 3);
    expect(list).toHaveLength(2);
    const second = list[1]!;
    expect(targetAt(state, second.x + 3, second.y + 1 + 2)).toEqual({ kind: 'tile', pane: second.pane.pane });
  });

  it('on the sessions page: a row of the list, its filter, not the card beside it', () => {
    const state = world({ page: 'sessions', width: 120, height: 30 });
    const at = find(state, 'Explain CRDTs');
    expect(targetAt(state, 4, at.y)).toMatchObject({ kind: 'listed' });
    const [picked] = click(state, { x: 4, y: at.y });
    expect(listFocus(picked).item?.key).toBe('session:codex:eeee5555-0000-4000-8000-000000000005');
    expect(targetAt(state, 4, 1)).toEqual({ kind: 'filter' });
    expect(targetAt(state, 110, at.y)).toBeUndefined();
  });

  it('on a setting: the setting, and the value under it', () => {
    const state = world({ page: 'settings', width: 140, height: 30 });
    const ember = find(state, 'ember');
    expect(targetAt(state, ember.x, ember.y)).toEqual({ kind: 'setting', index: 1, value: 'ember' });
    expect(targetAt(state, 4, ember.y)).toEqual({ kind: 'setting', index: 1 });
  });

  it('on the new pane dialog: the CLI under it', () => {
    const state = world({ dialog: { kind: 'new', brain: 'claude' } });
    const codex = find(state, 'Codex', state.height - 2);
    expect(targetAt(state, codex.x, codex.y)).toEqual({ kind: 'choice', brain: 'codex' });
  });
});

describe('what a click does', () => {
  it('opens a tab, also while typing into a tile', () => {
    const state = world({ width: 120 });
    const [next] = click(state, find(state, 'Usage'));
    expect(next.page).toBe('usage');
    const typing = world({ page: 'wall', width: 120, wall: { ...state.wall, focus: PANES[0]!.pane, typing: true } });
    const [back] = click(typing, find(typing, 'Overview'));
    expect(back.page).toBe('overview');
    expect(back.wall.typing).toBe(false);
  });

  it('selects an item; a double click is Enter on it', () => {
    const state = world({ width: 120, height: 40 });
    const at = find(state, 'Fix the flaky test');
    const [selected, none] = click(state, at);
    expect(selected.selected).toBe('session:claude:dddd4444-0000-4000-8000-000000000004');
    expect(none).toEqual([]);
    const [, effects] = click(state, find(state, 'auth refactor'), 'double');
    expect(effects).toEqual([{ kind: 'attach', pane: 'claude-1a2b3c4d' }]);
  });

  it('the wheel moves the selection as ↑ and ↓ do', () => {
    const state = world({ width: 120, height: 40 });
    const [down] = update(state, { kind: 'mouse', action: 'wheel-down', x: 5, y: 5 });
    const [byKey] = update(state, { kind: 'key', key: 'down' });
    expect(down.selected).toBe(byKey.selected);
    const [up] = update(down, { kind: 'mouse', action: 'wheel-up', x: 5, y: 5 });
    expect(up.selected).toBe(update(down, { kind: 'key', key: 'up' })[0].selected);
  });

  it('focuses a tile; a double click takes it full screen; typing goes on in the tile clicked', () => {
    const state = world({ page: 'wall', width: 120, height: 34 });
    const second = tiles(state, state.width, state.height - 3)[1]!;
    const at = { x: second.x + 3, y: second.y + 3 };
    const [focused] = click(state, at);
    expect(focused.wall.focus).toBe(second.pane.pane);
    expect(click(state, at, 'double')[1]).toEqual([{ kind: 'attach', pane: second.pane.pane }]);
    const typing = { ...focused, wall: { ...focused.wall, typing: true } };
    expect(click(typing, at)[0]).toBe(typing);
  });

  it('a value of a setting is chosen and kept at once', () => {
    const state = world({ page: 'settings', width: 140, height: 30 });
    const [next, effects] = click(state, find(state, 'ember'));
    expect(next.settings.theme).toBe('ember');
    expect(next.setting).toBe(1);
    expect(effects).toEqual([{ kind: 'save', settings: { ...DEFAULT_SETTINGS, theme: 'ember' } }]);
  });

  it('in a dialog: a CLI starts it; anywhere else is Esc', () => {
    const state = world({ dialog: { kind: 'new', brain: 'claude' } });
    const [closed, effects] = click(state, find(state, 'Codex', state.height - 2));
    expect(closed.dialog).toBeUndefined();
    expect(effects).toEqual([{ kind: 'start', brain: 'codex', cwd: state.cwd }]);
    const asked = world({
      dialog: { kind: 'confirm', question: 'Close it?', effect: { kind: 'close', pane: 'claude-1a2b3c4d' } },
    });
    const [answered, none] = click(asked, { x: 10, y: 10 });
    expect(answered.dialog).toBeUndefined();
    expect(none).toEqual([]);
  });
});
