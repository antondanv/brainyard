/**
 * Where a click lands: a cell of the frame mapped back to what the view drew
 * there — a tab, an item, a tile, a setting, a CLI to choose. Pure geometry,
 * as the view is: a browser sends clicks by cell, and a terminal could too.
 */
import type { BrainId } from '@antondanv/brainyard';

import { listRoom, listScroll, sessionsWidths, settingAt } from './pages.js';
import type { Page } from './settings.js';
import { listItems, type State } from './state.js';
import { bodyHeight, choiceAt, clampScroll, layout, MIN_HEIGHT, MIN_WIDTH, PLAIN, tabAt } from './view.js';
import { tiles } from './wall.js';

export type Target =
  | { kind: 'tab'; page: Page }
  /** An item of the overview, by its key. */
  | { kind: 'item'; key: string }
  /** A row of the sessions page's list, by its place in the list. */
  | { kind: 'listed'; index: number }
  /** The title of the sessions page's list, where its filter is. */
  | { kind: 'filter' }
  | { kind: 'tile'; pane: string }
  /** A setting, and the value clicked on its row, if one was. */
  | { kind: 'setting'; index: number; value?: string }
  /** A CLI of the new pane dialog. */
  | { kind: 'choice'; brain: BrainId };

/** What the view drew at this cell (0-based, the frame's top left is 0, 0); nothing that a click does is undefined. */
export function targetAt(state: State, x: number, y: number): Target | undefined {
  if (state.width < MIN_WIDTH || state.height < MIN_HEIGHT) return undefined;
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return undefined;
  if (state.dialog?.kind === 'new') {
    // The dialog is the row above the keys.
    const brain = y === state.height - 2 ? choiceAt(state, x) : undefined;
    return brain ? { kind: 'choice', brain } : undefined;
  }
  if (state.dialog) return undefined;
  if (y === 0) {
    const page = tabAt(state, x);
    return page ? { kind: 'tab', page } : undefined;
  }
  const room = bodyHeight(state);
  const row = y - 1;
  if (row >= room) return undefined;
  switch (state.page) {
    case 'overview': {
      const { rows, spans } = layout(state, PLAIN);
      const at = clampScroll(state.scroll, rows.length, room) + row;
      for (const [key, span] of spans) {
        if (at < span.top || at > span.last) continue;
        if (span.left !== undefined && (x < span.left || x >= (span.right ?? state.width))) continue;
        return { kind: 'item', key };
      }
      return undefined;
    }
    case 'wall': {
      const tile = tiles(state, state.width, room).find(
        (each) => x >= each.x && x < each.x + each.width && row >= each.y && row < each.y + each.height,
      );
      return tile ? { kind: 'tile', pane: tile.pane.pane } : undefined;
    }
    case 'sessions': {
      const [list] = sessionsWidths(state.width);
      if (x >= list) return undefined;
      if (row === 0) return { kind: 'filter' };
      const inside = listRoom(room);
      if (row > inside) return undefined;
      const index = listScroll(state, inside) + row - 1;
      return index < listItems(state).length ? { kind: 'listed', index } : undefined;
    }
    case 'settings': {
      const found = settingAt(state, x, row);
      return found ? { kind: 'setting', ...found } : undefined;
    }
    case 'usage':
      return undefined;
  }
}
