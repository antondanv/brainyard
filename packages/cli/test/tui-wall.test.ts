import type { PaneScreen } from '@antondanv/brainyard';
import { describe, expect, it } from 'vitest';

import type { PaneRow } from '../src/panes.js';
import { palette, plain as uncoloured } from '../src/term.js';
import type { Effect, State } from '../src/tui/state.js';
import { cells } from '../src/tui/text.js';
import { update } from '../src/tui/update.js';
import { render } from '../src/tui/view.js';
import { capacity, neighbour, tiles, wallPage } from '../src/tui/wall.js';
import { NOW, PANES, world } from './tui-world.js';

const plain = palette(false);

function screen(lines: string[], cursor = { x: 0, y: 0 }): PaneScreen {
  return {
    lines,
    width: 80,
    height: 24,
    cursor: { ...cursor, visible: true },
    historySize: 0,
    scrollOffset: 0,
    mouseTracking: false,
    mouseSgr: false,
    alternate: false,
  };
}

const pane = (name: string, minutes: number): PaneRow => ({
  pane: name,
  brain: 'codex',
  attached: false,
  width: 80,
  height: 24,
  startedAt: new Date(NOW - minutes * 60_000).toISOString(),
});

/** The wall with these panes, 120×40, the body below the header. */
function wall(panes: PaneRow[], over: Partial<State> = {}): State {
  return world({ page: 'wall', width: 120, height: 40, ...over }, { panes, screens: {} });
}

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

describe('the wall’s tiles', () => {
  it('fill the body exactly, in a grid that keeps tiles terminal-shaped', () => {
    const body = { width: 120, height: 37 };
    for (const count of [1, 2, 3, 4, 5, 6]) {
      const state = wall(Array.from({ length: count }, (_, index) => pane(`codex-${index}`, 10 - index)));
      const list = tiles(state, body.width, body.height);
      expect(list).toHaveLength(count);
      // Every cell belongs to exactly one tile.
      const area = list.reduce((sum, tile) => sum + tile.width * tile.height, 0);
      expect(area).toBe(body.width * body.height);
    }
    const two = tiles(wall([pane('a', 2), pane('b', 1)]), 120, 37);
    expect(two.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
      { x: 0, y: 0, width: 60, height: 37 },
      { x: 60, y: 0, width: 60, height: 37 },
    ]);
  });

  it('keep the oldest pane first, so a new one goes to the end', () => {
    const list = tiles(wall([pane('new', 1), pane('old', 30)]), 120, 37);
    expect(list.map((tile) => tile.pane.pane)).toEqual(['old', 'new']);
  });

  it('lay out as main and stack, as columns, or one zoomed tile', () => {
    const panes = [pane('a', 3), pane('b', 2), pane('c', 1)];
    const main = tiles(wall(panes, { wall: { layout: 'main', zoom: false, typing: false, page: 0 } }), 120, 37);
    expect(main.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
      [0, 0, 72, 37],
      [72, 0, 48, 19],
      [72, 19, 48, 18],
    ]);
    const columns = tiles(wall(panes, { wall: { layout: 'columns', zoom: false, typing: false, page: 0 } }), 120, 37);
    expect(columns.map((tile) => tile.width)).toEqual([40, 40, 40]);
    const zoomed = tiles(
      wall(panes, { wall: { layout: 'grid', zoom: true, typing: false, page: 0, focus: 'b' } }),
      120,
      37,
    );
    expect(zoomed.map((tile) => [tile.pane.pane, tile.width, tile.height])).toEqual([['b', 120, 37]]);
  });

  it('page when more panes than fit, and find the neighbour in each direction', () => {
    expect(capacity(120, 37)).toBe(9);
    expect(capacity(80, 20)).toBe(4);
    const many = Array.from({ length: 6 }, (_, index) => pane(`p${index}`, 10 - index));
    const small = wall(many, { width: 80, height: 23 });
    expect(wallPage(small, 80, 20)).toMatchObject({ page: 0, pages: 2 });
    expect(tiles(small, 80, 20)).toHaveLength(4);
    const [next] = press(small, 'pagedown');
    expect(tiles(next, 80, 20).map((tile) => tile.pane.pane)).toEqual(['p4', 'p5']);

    const grid = tiles(wall(many.slice(0, 4)), 120, 37);
    const [a, b, c] = grid;
    expect(neighbour(grid, a!, 'right')).toBe(b);
    expect(neighbour(grid, a!, 'down')).toBe(c);
    expect(neighbour(grid, a!, 'left')).toBeUndefined();
  });
});

describe('the wall on screen', () => {
  it('draws each tile with its CLI, state, memory, screen and name, every row the screen’s width', () => {
    const state = world(
      { page: 'wall', width: 100, height: 20 },
      {
        screens: {
          'claude-1a2b3c4d': screen(['\u001b[31mred\u001b[0m text', 'second row']),
          'codex-5e6f7a8b': screen(['Allow command? [y/n]']),
        },
      },
    );
    const lines = render(state, plain);
    expect(lines).toHaveLength(20);
    for (const line of lines) expect(cells(line)).toBe(100);
    const text = lines.map((line) => line.trimEnd());
    // The codex pane started first: it is on the left.
    expect(text[1]).toBe(
      '╭─ Codex ─────────── waiting: approval · 120 MB ─╮╭─ Claude Code · auth refac… ─ working · 285 MB ─╮',
    );
    // The CLI's own colours come through, and end inside its tile.
    expect(text[2]).toBe(
      '│Allow command? [y/n]                            ││\u001b[31mred\u001b[0m text                                        \u001b[0m│',
    );
    expect(text[3]).toBe(`│${' '.repeat(48)}││second row${' '.repeat(38)}│`);
    expect(text[17]).toBe(
      '╰─ i type · Enter full screen ── codex-5e6f7a8b ─╯╰─ active ───────────────────── claude-1a2b3c4d ─╯',
    );
    expect(text.at(-1)).toBe(
      ' ←→↑↓ focus · i type · Enter full screen · z zoom · l grid · x close · n new · ? help · q quit',
    );
  });

  it('keeps a CLI’s colours inside its tile and shows its cursor while typing', () => {
    const state = world(
      {
        page: 'wall',
        width: 100,
        height: 20,
        wall: { layout: 'grid', zoom: false, typing: true, page: 0, focus: 'claude-1a2b3c4d' },
      },
      { screens: { 'claude-1a2b3c4d': screen(['\u001b[31mred', '> hi'], { x: 4, y: 1 }) } },
    );
    const lines = render(state, palette(true));
    for (const line of lines) expect(cells(line)).toBe(100);
    const row = lines[2]!;
    // The colour the CLI left open is reset before the border.
    expect(row).toContain('\u001b[31mred');
    expect(row).toContain(`red${' '.repeat(45)}\u001b[0m`);
    expect(lines[3]).toContain('> hi\u001b[7m \u001b[27m');
    expect(uncoloured(lines.at(-1)!).trimEnd()).toBe(' typing into the tile: every key goes to its CLI · Ctrl+Q back');
    expect(uncoloured(lines[17]!)).toContain('✎ typing · Ctrl+Q back');
  });

  it('says what to do with no panes, or without tmux', () => {
    expect(render(wall([]), plain).join('\n')).toContain('no panes yet · n starts one here');
    expect(render(world({ page: 'wall' }, { tmux: false, panes: [] }), plain).join('\n')).toContain(
      'panes need tmux: the wall shows their screens',
    );
  });
});

describe('keys on the wall', () => {
  const state = world({ page: 'wall', width: 120, height: 40 });

  it('move the focus, go full screen, zoom, and change the layout for good', () => {
    // The first tile is the oldest pane: codex.
    expect(press(state, 'enter')[1]).toEqual([{ kind: 'attach', pane: 'codex-5e6f7a8b' }]);
    const [right] = press(state, 'right');
    expect(right.wall.focus).toBe('claude-1a2b3c4d');
    expect(press(right, 'enter')[1]).toEqual([{ kind: 'attach', pane: 'claude-1a2b3c4d' }]);
    expect(press(state, 'tab')[0].wall.focus).toBe('claude-1a2b3c4d');
    expect(press(state, 'z')[0].wall).toMatchObject({ zoom: true, focus: 'codex-5e6f7a8b' });
    expect(press(state, 'z', 'esc')[0].wall.zoom).toBe(false);
    const [main, saved] = press(state, 'l');
    expect(main.wall.layout).toBe('main');
    expect(saved).toEqual([{ kind: 'save', settings: { ...state.settings, layout: 'main' } }]);
    expect(press(state, 'l', 'l', 'l')[0].wall.layout).toBe('grid');
  });

  it('i types into the tile: bytes go as they came, Ctrl+C included, until Ctrl+Q', () => {
    const [typing] = press(state, 'i');
    expect(typing.wall).toMatchObject({ typing: true, focus: 'codex-5e6f7a8b' });
    const [still, sent] = update(typing, { kind: 'input', data: 'привет\r\u0003q' });
    expect(sent).toEqual([{ kind: 'send', pane: 'codex-5e6f7a8b', data: 'привет\r\u0003q' }]);
    expect(still.wall.typing).toBe(true);
    const [back, last] = update(still, { kind: 'input', data: 'ok\u0011ignored' });
    expect(last).toEqual([{ kind: 'send', pane: 'codex-5e6f7a8b', data: 'ok' }]);
    expect(back.wall.typing).toBe(false);
    // Another page stops the typing.
    expect(press(typing, 'ctrl-q')[0].wall.typing).toBe(false);
  });

  it('x asks before closing the tile’s pane; n starts a tile to type into', () => {
    const [asking] = press(state, 'x');
    expect(asking.dialog).toMatchObject({ kind: 'confirm', effect: { kind: 'close', pane: 'codex-5e6f7a8b' } });
    expect(press(state, 'n', 'enter')[1]).toEqual([{ kind: 'start', brain: 'codex', cwd: state.cwd, after: 'type' }]);
    const [focused] = [update(state, { kind: 'focus', pane: 'claude-1a2b3c4d', typing: true })[0]];
    expect(focused.wall).toMatchObject({ focus: 'claude-1a2b3c4d', typing: true });
  });

  it('stops typing when the pane goes away', () => {
    const [typing] = press(state, 'i');
    const [gone] = update(typing, { kind: 'loaded', source: 'panes', data: { panes: [PANES[0]!] } });
    expect(gone.wall.typing).toBe(false);
  });

  it('digits and brackets open the pages from anywhere but a tile being typed into', () => {
    expect(press(world(), '2')[0].page).toBe('wall');
    expect(press(world(), ']')[0].page).toBe('wall');
    expect(press(world(), '[')[0].page).toBe('settings');
    const [typing] = press(state, 'i');
    expect(update(typing, { kind: 'input', data: '3' })[0].page).toBe('wall');
  });
});
