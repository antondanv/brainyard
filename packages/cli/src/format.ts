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

const short = (value: number) => (value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value)));

/** Token counts: `950`, `1.2k`, `34k`, `8.1M`. */
export function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${short(count / 1000)}k`;
  if (count < 1_000_000_000) return `${short(count / 1_000_000)}M`;
  return `${short(count / 1_000_000_000)}B`;
}

/** Dollars: cents for sums, four places below a cent. */
export function money(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Time until a moment, coarse: `35m`, `2h 10m`, `4d 3h`; a moment past is `now`. */
export function until(ms: number, now = Date.now()): string {
  const minutes = Math.round((ms - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** A limit window by its length where the CLI says it (`5h`, `weekly`), else by its own name. */
export function windowName(limit: { window: string; windowMinutes?: number }): string {
  const minutes = limit.windowMinutes;
  if (minutes === 10_080) return 'weekly';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return limit.window.replaceAll('_', '-');
}
