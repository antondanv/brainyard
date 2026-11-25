/**
 * Giving each Antigravity CLI launch its own log file so concurrent launches
 * never overwrite the same `cli-<YYYYMMDD_HHMMSS>.log`.
 *
 * Newer `agy` builds accept `--log-file <path>`, which isolates every launch
 * without waiting. Older builds without `--log-file` fall back to spacing
 * launches across distinct wall-clock seconds using a cross-process lockfile.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Minimum spacing between Antigravity launches when `--log-file` is unavailable. */
export const AGY_LAUNCH_GAP_MS = 1_200;

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 15;

const inProcessQueues = new Map<string, Promise<void>>();

/** Local timestamp matching `agy`'s own `cli-YYYYMMDD_HHMMSS.log` naming. */
export function agyLogStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** Unique log path inside Antigravity's log folder, matching `cli-*.log`. */
export function agyLogFilePath(home: string, tag = randomBytes(4).toString('hex'), now = new Date()): string {
  return join(home, 'log', `cli-${agyLogStamp(now)}-${tag}.log`);
}

/** Extracts the `--log-file` value from CLI arguments, if present. */
export function logFileArg(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--log-file') return args[i + 1];
    if (arg.startsWith('--log-file=')) return arg.slice('--log-file='.length);
  }
  return undefined;
}

/**
 * Reserves a distinct launch second for `home` across callers in this process
 * and across other processes on the same machine, then waits until that slot.
 */
export async function paceAgyLaunch(home: string, gapMs = AGY_LAUNCH_GAP_MS): Promise<void> {
  const key = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 16);
  const target = await runInQueue(key, () => reserveSlot(key, gapMs));
  const wait = target - Date.now();
  if (wait > 0) await sleep(wait);
}

function runInQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inProcessQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const done = next.then(
    () => undefined,
    () => undefined,
  );
  inProcessQueues.set(key, done);
  done.finally(() => {
    if (inProcessQueues.get(key) === done) inProcessQueues.delete(key);
  });
  return next;
}

async function reserveSlot(key: string, gapMs: number): Promise<number> {
  const dir = join(tmpdir(), `brainyard-agy-${process.getuid?.() ?? 'user'}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockFile = join(dir, `${key}.lock`);
  const slotFile = join(dir, `${key}.slot`);

  const locked = await acquireLock(lockFile);
  try {
    let lastMs = 0;
    try {
      const parsed = Number(readFileSync(slotFile, 'utf8').trim());
      if (Number.isFinite(parsed) && parsed > 0) lastMs = parsed;
    } catch {
      // First launch for this home.
    }
    const now = Date.now();
    let target = lastMs > 0 ? Math.max(now, lastMs + gapMs) : now;
    if (lastMs > 0 && Math.floor(target / 1000) <= Math.floor(lastMs / 1000)) {
      target = (Math.floor(lastMs / 1000) + 1) * 1000 + 50;
    }
    try {
      writeFileSync(slotFile, `${target}\n`, { mode: 0o600 });
    } catch {
      // Best-effort persistence: still respect the computed target.
    }
    return target;
  } finally {
    if (locked) {
      try {
        unlinkSync(lockFile);
      } catch {
        // Already gone.
      }
    }
  }
}

async function acquireLock(lockFile: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockFile);
          continue;
        }
      } catch {
        // Owner released the lock between EEXIST and statSync.
        continue;
      }
      if (Date.now() >= deadline) return false;
      await sleep(LOCK_POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
