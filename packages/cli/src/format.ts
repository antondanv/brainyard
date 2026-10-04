/** Numbers and times as the command prints them: short, rounded, no colour. */

/** How long ago, in the largest whole unit: `now`, `5m`, `3h`, `2d`. */
export function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 90) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
