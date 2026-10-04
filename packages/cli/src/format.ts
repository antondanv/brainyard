/** Numbers, times and paths as the command prints them: short, rounded, no colour. */
import { resolve } from 'node:path';

/** How long ago, in the largest whole unit: `now`, `5m`, `3h`, `2d`. */
export function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 90) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** `412 MB`, `1.3 GB`: one decimal below ten. */
export function bytes(count: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A long path keeps its end, where the folder's own name is: `…/code/app`. */
export function shortPath(path: string, max: number): string {
  return path.length <= max ? path : `…${path.slice(path.length - max + 1)}`;
}

/** ` --cwd <folder>` for a hint to copy, when the folder is not this one: a session resumes in its own. */
export function cwdFlag(cwd: string | undefined): string {
  if (!cwd || resolve(cwd) === process.cwd()) return '';
  return ` --cwd ${/^[\w@%+=:,./~-]+$/.test(cwd) ? cwd : `'${cwd.replaceAll("'", `'\\''`)}'`}`;
}
