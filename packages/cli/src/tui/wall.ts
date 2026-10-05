/**
 * The wall: several panes on one screen, each in a tile with its live
 * screen, laid out as a tiling compositor would — a grid, one main tile and
 * a stack, or columns; one tile can take the whole wall. Pure geometry: the
 * view draws the tiles, the runtime sizes each pane to its tile.
 */
import type { PaneRow } from '../panes.js';
import { split } from './parts.js';
import type { Layout, State } from './state.js';

export interface Tile {
  pane: PaneRow;
  /** The box, border included, in body cells: the wall starts at the body's top left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A tile smaller than this shows too little of a CLI to be worth it. */
export const MIN_TILE = { width: 34, height: 9 } as const;

const time = (pane: PaneRow) => Date.parse(pane.startedAt ?? '') || 0;

/** The panes on the wall, oldest first: a new one goes to the end and the others stay put. */
export function wallPanes(state: State): PaneRow[] {
  return [...(state.data.panes ?? [])].sort((a, b) => time(a) - time(b) || a.pane.localeCompare(b.pane));
}

/** How many tiles fit in this area. */
export function capacity(width: number, height: number): number {
  const columns = Math.max(1, Math.floor(width / MIN_TILE.width));
  const rows = Math.max(1, Math.floor(height / MIN_TILE.height));
  return Math.min(9, columns * rows);
}

/** Columns for a grid of `count` tiles: the one whose tiles look most like a terminal (about 3:1 in cells). */
function gridColumns(count: number, width: number, height: number): number {
  let best = 1;
  let score = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const tileWidth = width / columns;
    const tileHeight = height / rows;
    if (tileWidth < MIN_TILE.width && columns > 1) break;
    const off = Math.abs(Math.log(tileWidth / tileHeight / 3));
    // A row left half empty looks unfinished.
    const empty = (rows * columns - count) / columns;
    if (off + empty * 0.5 < score) {
      score = off + empty * 0.5;
      best = columns;
    }
  }
  return best;
}

function place(panes: readonly PaneRow[], width: number, height: number, layout: Layout): Omit<Tile, 'pane'>[] {
  const count = panes.length;
  if (count === 0) return [];
  if (count === 1) return [{ x: 0, y: 0, width, height }];
  if (layout === 'columns') {
    let x = 0;
    return split(width, count).map((w) => {
      const box = { x, y: 0, width: w, height };
      x += w;
      return box;
    });
  }
  if (layout === 'main') {
    const main = Math.max(MIN_TILE.width, Math.round(width * 0.6));
    const boxes = [{ x: 0, y: 0, width: main, height }];
    let y = 0;
    for (const h of split(height, count - 1)) {
      boxes.push({ x: main, y, width: width - main, height: h });
      y += h;
    }
    return boxes;
  }
  const columns = gridColumns(count, width, height);
  const rows = Math.ceil(count / columns);
  const heights = split(height, rows);
  const boxes: Omit<Tile, 'pane'>[] = [];
  let y = 0;
  for (let row = 0; row < rows; row++) {
    // The last row may hold fewer tiles: they share its whole width.
    const inRow = Math.min(columns, count - row * columns);
    let x = 0;
    for (const w of split(width, inRow)) {
      boxes.push({ x, y, width: w, height: heights[row]! });
      x += w;
    }
    y += heights[row]!;
  }
  return boxes;
}

/** The wall's screenfuls of panes, and the one on screen now. */
export function wallPage(
  state: State,
  width: number,
  height: number,
): { panes: PaneRow[]; page: number; pages: number } {
  const all = wallPanes(state);
  const size = capacity(width, height);
  const pages = Math.max(1, Math.ceil(all.length / size));
  const page = Math.min(Math.max(0, state.wall.page), pages - 1);
  return { panes: all.slice(page * size, (page + 1) * size), page, pages };
}

/** The tiles on screen, in a body of this size. */
export function tiles(state: State, width: number, height: number): Tile[] {
  const { panes } = wallPage(state, width, height);
  if (state.wall.zoom) {
    const zoomed = panes.find((pane) => pane.pane === state.wall.focus) ?? panes[0];
    return zoomed ? [{ pane: zoomed, x: 0, y: 0, width, height }] : [];
  }
  return place(panes, width, height, state.wall.layout).map((box, index) => ({ pane: panes[index]!, ...box }));
}

/** The focused tile: the remembered one, or the first on screen. */
export function focusedTile(list: readonly Tile[], focus: string | undefined): Tile | undefined {
  return list.find((tile) => tile.pane.pane === focus) ?? list[0];
}

/** The nearest tile in a direction from the focused one, by their centres. */
export function neighbour(
  list: readonly Tile[],
  from: Tile,
  direction: 'left' | 'right' | 'up' | 'down',
): Tile | undefined {
  const centre = (tile: Tile) => ({ x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 });
  const here = centre(from);
  let best: { tile: Tile; distance: number } | undefined;
  for (const tile of list) {
    if (tile === from) continue;
    const there = centre(tile);
    const dx = there.x - here.x;
    const dy = there.y - here.y;
    const ahead = direction === 'left' ? dx < 0 : direction === 'right' ? dx > 0 : direction === 'up' ? dy < 0 : dy > 0;
    if (!ahead) continue;
    // Along the direction counts once, across it (a cell is twice as tall as wide) counts more.
    const along = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy) * 2;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) * 2 : Math.abs(dx);
    const distance = along + across * 2;
    if (!best || distance < best.distance) best = { tile, distance };
  }
  return best?.tile;
}
