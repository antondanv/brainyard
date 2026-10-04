import type { BrainId, ErrorKind, RunError } from './types.js';

/**
 * Thrown when a run never started (bad options, CLI not installed) and by
 * `ask()` on any failure. Once a CLI has started, `run()` resolves instead and
 * describes the failure in `result.error`.
 */
export class BrainyardError extends Error {
  readonly kind: ErrorKind;
  readonly brain: BrainId | undefined;
  readonly retryable: boolean;
  readonly resetsAt: string | undefined;
  /** What to do about it, when there is something to do. */
  readonly fix: string | undefined;

  constructor(
    kind: ErrorKind,
    message: string,
    extra: { brain?: BrainId; retryable?: boolean; resetsAt?: string; fix?: string; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'BrainyardError';
    this.kind = kind;
    this.brain = extra.brain;
    this.retryable = extra.retryable ?? false;
    this.resetsAt = extra.resetsAt;
    this.fix = extra.fix;
  }

  static from(error: RunError, brain: BrainId): BrainyardError {
    const extra: { brain: BrainId; retryable: boolean; resetsAt?: string } = { brain, retryable: error.retryable };
    if (error.resetsAt !== undefined) extra.resetsAt = error.resetsAt;
    return new BrainyardError(error.kind, error.message, extra);
  }
}

type Marker = string | RegExp;

// A subscription window ran out. Not a transient error: waiting means hours,
// and a retry in a minute is just a second refusal. The CLI says when it
// resets, and that is worth keeping.
const USAGE_LIMIT: Marker[] = [
  'session limit',
  'usage limit',
  'weekly limit',
  'limit · resets',
  'limit reached',
  'hit your limit',
  'out of credits',
  'credit balance is too low',
];

// Signed out, or a bad key. Retrying changes nothing; logging in does.
const AUTH: Marker[] = [
  'not logged in',
  'please run /login',
  'run /login',
  'please log in',
  'login required',
  'invalid api key',
  'invalid x-api-key',
  'authentication_error',
  'authentication failed',
  'unauthorized',
  'unauthenticated',
  'oauth token has expired',
  'token expired',
];

// The provider asked to slow down: wait tens of seconds, then retry.
const THROTTLING: Marker[] = [
  /\b429\b/,
  'rate limit',
  'rate_limit',
  'too many requests',
  'quota exceeded',
  'overloaded',
  /\b529\b/,
  'resource_exhausted',
  'service unavailable',
  'temporarily unavailable',
];

// The connection dropped: nothing to wait for, just ask again.
const NETWORK: Marker[] = [
  /\b50[234]\b/,
  'connection reset',
  'connection refused',
  'econnreset',
  'econnrefused',
  'etimedout',
  'broken pipe',
  'socket hang up',
  'socket is closed',
  'network error',
  'stream disconnected',
  'timed out',
  'unable to connect',
  'cannot connect',
];

const RESETS = [/resets?\s+(?:at\s+)?/i, /try again (?:at|in|after)\s+/i, /available again (?:at|in)\s+/i];

/** When a limit resets, if the text says so ("6:50pm (Europe/Moscow)", "5:00 PM"). */
export function findReset(text: string): string | undefined {
  for (const pattern of RESETS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const rest = text.slice(match.index + match[0].length);
    const value = (rest.split(/\n|·|;|\.\s/)[0] ?? '').replace(/[.\s]+$/, '').trim();
    if (/\d/.test(value)) return value.slice(0, 80);
  }
  return undefined;
}

/**
 * A failed run → a kind you can act on. Agentic CLIs do not hand out HTTP
 * statuses; they hand out the text of the last error, so this reads text.
 * Crude on purpose: "wait and retry" beats "call a human" for a 429.
 */
export function classifyFailure(text: string): Omit<RunError, 'message'> {
  const low = text.toLowerCase();
  const has = (markers: readonly Marker[]) =>
    markers.some((marker) => (typeof marker === 'string' ? low.includes(marker) : marker.test(low)));

  if (has(USAGE_LIMIT)) {
    const resetsAt = findReset(text);
    return resetsAt === undefined
      ? { kind: 'usage_limit', retryable: false }
      : { kind: 'usage_limit', retryable: false, resetsAt };
  }
  if (has(AUTH)) return { kind: 'not_logged_in', retryable: false };
  if (has(THROTTLING)) return { kind: 'rate_limited', retryable: true };
  if (has(NETWORK)) return { kind: 'network', retryable: true };
  return { kind: 'failed', retryable: false };
}
