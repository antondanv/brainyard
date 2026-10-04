/** Subscription metadata requests, separate from model inference. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { obj, str } from './brains/adapter.js';
import { BRAINS } from './brains/info.js';
import { parseJsonc } from './brains/opencode.js';
import { type Captured, capture, resolveCommand, withoutSessionVars } from './process.js';
import type { BrainId, ErrorKind, LimitWindow } from './types.js';
import type { BrainUsage, UsageOptions } from './usage.js';

const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** Claude Code's windows as its usage report names them; model-specific weekly ones form pools of their own. */
const CLAUDE_WINDOWS: Record<string, { minutes: number; group?: string }> = {
  five_hour: { minutes: 300 },
  seven_day: { minutes: 10_080 },
  seven_day_opus: { minutes: 10_080, group: 'Opus' },
  seven_day_sonnet: { minutes: 10_080, group: 'Sonnet' },
};

/**
 * The subscription windows Claude Code itself fetched last (what its /usage
 * shows), from the `cachedUsageUtilization` it keeps in its global file
 * (`~/.claude.json`, or `.claude.json` in `CLAUDE_CONFIG_DIR`). Free and
 * offline, and only as fresh as `limitsObservedAt`; a cache of another
 * account than the one signed in now is not used.
 */
export function claudeCachedLimits(path: string): BrainUsage {
  const data = obj(file(path));
  const cached = obj(data.cachedUsageUtilization);
  const account = str(obj(data.oauthAccount).accountUuid);
  const owner = str(cached.accountUuid);
  if (account && owner && account !== owner) {
    return missing('claude', 'missing', 'Claude Code cached its usage for another account than the one signed in.');
  }
  const utilization = obj(cached.utilization);
  const limits: LimitWindow[] = [];
  for (const [window, shape] of Object.entries(CLAUDE_WINDOWS)) {
    const entry = obj(utilization[window]);
    if (!nonnegative(entry.utilization)) continue;
    // Percent here; a live call reports a fraction.
    const limit: LimitWindow = { window, utilization: entry.utilization / 100, windowMinutes: shape.minutes };
    const resets = seconds(entry.resets_at);
    if (resets !== undefined) limit.resetsAt = resets;
    if (shape.group) limit.group = shape.group;
    limits.push(limit);
  }
  if (limits.length === 0) {
    return missing(
      'claude',
      'missing',
      'Claude Code has not shown its usage here yet: /usage in it does, or one tiny real call (live: true).',
    );
  }
  const fetched = cached.fetchedAtMs;
  return {
    brain: 'claude',
    limits,
    limitsSource: 'cache',
    limitsObservedAt: typeof fetched === 'number' && Number.isFinite(fetched) ? new Date(fetched).toISOString() : null,
    limitsUnavailable: null,
  };
}

export async function agyLimits(env: NodeJS.ProcessEnv, options: UsageOptions): Promise<BrainUsage> {
  const brain = 'antigravity';
  if (options.signal?.aborted) return failed(brain, 'stopped', 'Antigravity quota check was cancelled.');
  const info = BRAINS.antigravity;
  const command = resolveCommand(options.commands?.antigravity, info.binary, info.envVar, env);
  if (!command) return failed(brain, 'not_installed', 'Antigravity CLI is not installed.');
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'brainyard-quota-'));
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    const settings = {
      cwd: dir,
      env: withoutSessionVars({ ...env, AGY_CLI_DISABLE_AUTO_UPDATE: '1' }),
      signal: options.signal,
    };
    const version = await capture(command, ['--version'], {
      ...settings,
      timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())),
    });
    const problem = cliFailure(version);
    if (problem) return failed(brain, problem, 'Could not check the Antigravity CLI version.');
    const parts = version.stdout
      .match(/\b(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number);
    // Older print mode can treat /usage as a model prompt. Never send it without proof of support.
    if (!parts || !(parts[0]! > 1 || (parts[0] === 1 && (parts[1]! > 1 || (parts[1] === 1 && parts[2]! >= 11)))))
      return missing(brain, 'unsupported', 'Structured /usage reports require Antigravity CLI 1.1.11 or later.');
    const result = await capture(command, ['-p', '/usage', '--output-format', 'json'], {
      ...settings,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    const failure = cliFailure(result);
    if (failure)
      return failed(
        brain,
        failure,
        failure === 'not_logged_in'
          ? 'Sign into Antigravity in a terminal to read subscription quotas.'
          : 'Antigravity could not read its quota report; check agy -p /usage --output-format json.',
      );
    const report = obj(parse(result.stdout));
    const commandReport = obj(report.command);
    if (report.status !== 'SUCCESS' || commandReport.name !== 'usage')
      return failed(brain, 'failed', 'Antigravity did not return a successful usage command report.');
    const limits = agyWindows(obj(commandReport.data));
    return limits.length
      ? known(brain, limits, 'cli')
      : missing(brain, 'missing', 'The Antigravity usage report contains no readable, enabled quota fractions.');
  } catch {
    return failed(brain, options.signal?.aborted ? 'stopped' : 'failed', 'Antigravity quota check failed.');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function cliFailure(result: Captured): ErrorKind | undefined {
  if (result.cancelled) return 'stopped';
  if (result.timedOut) return 'timeout';
  if (result.error) return 'not_installed';
  if (result.code === 0) return undefined;
  if (
    /not signed in|not logged in|sign(?:ed)? out|select login method|keyring auth/i.test(result.stdout + result.stderr)
  )
    return 'not_logged_in';
  return 'failed';
}

function agyWindows(data: Record<string, unknown>): LimitWindow[] {
  const limits = new Map<string, LimitWindow>();
  const groups = Array.isArray(data.groups) ? data.groups : [];
  for (const entry of groups) {
    const group = obj(entry);
    const name = str(group.name) || str(group.display_name) || str(group.displayName);
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const entry of buckets) {
      const bucket = obj(entry);
      const fraction = bucket.remaining_fraction ?? bucket.remainingFraction;
      if (bucket.disabled === true || !nonnegative(fraction) || fraction > 1) continue;
      const id = str(bucket.id) || str(bucket.bucket_id) || str(bucket.bucketId);
      if (!id) continue;
      const label = str(bucket.name) || str(bucket.display_name) || str(bucket.displayName);
      const window = str(bucket.window) || id;
      const value: LimitWindow = { window, utilization: 1 - fraction, limitId: id };
      if (name) value.group = name;
      if (label) value.label = label;
      const reset = seconds(bucket.reset_time ?? bucket.resetTime);
      if (reset !== undefined) value.resetsAt = reset;
      const normalized = window.trim().toLowerCase();
      if (['5h', 'session', '5-hour', 'five-hour'].includes(normalized)) value.windowMinutes = 300;
      else if (normalized === 'weekly') value.windowMinutes = 10080;
      limits.set(`${name}\0${id}`, value);
    }
  }
  return [...limits.values()];
}

export async function opencodeLimits(home: string, env: NodeJS.ProcessEnv, options: UsageOptions): Promise<BrainUsage> {
  const brain = 'opencode';
  if (options.signal?.aborted) return failed(brain, 'stopped', 'OpenCode Go quota check was cancelled.');
  const key = goKey(home, env, options.cwd);
  if (!key)
    return missing(
      brain,
      'missing',
      'Connect OpenCode Go in OpenCode or provide OPENCODE_API_KEY to read subscription usage.',
    );
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const response = await fetch(GO_USAGE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403)
        return missing(brain, 'missing', 'This OpenCode key has no OpenCode Go subscription.');
      const kind = response.status === 401 ? 'not_logged_in' : response.status === 429 ? 'rate_limited' : 'network';
      return failed(brain, kind, `OpenCode Go quota API returned HTTP ${response.status}.`);
    }
    const data = obj(obj(await response.json()).usage);
    const limits: LimitWindow[] = [];
    for (const window of ['rolling', 'weekly', 'monthly']) {
      const raw = obj(data[window]);
      if (!nonnegative(raw.percent)) continue;
      const value: LimitWindow = { window, utilization: raw.percent / 100, limitId: 'opencode-go' };
      const reset = seconds(raw.resetsAt);
      if (reset !== undefined) value.resetsAt = reset;
      limits.push(value);
    }
    return limits.length
      ? known(brain, limits, 'api')
      : missing(brain, 'missing', 'OpenCode Go returned no readable subscription windows.');
  } catch (error) {
    const kind = options.signal?.aborted
      ? 'stopped'
      : timeout.aborted
        ? 'timeout'
        : error instanceof SyntaxError
          ? 'failed'
          : 'network';
    return failed(brain, kind, 'Could not read OpenCode Go subscription usage.');
  }
}

function goKey(home: string, env: NodeJS.ProcessEnv, cwd?: string): string | undefined {
  const direct = env.OPENCODE_GO_API_KEY?.trim() || env.OPENCODE_API_KEY?.trim();
  if (direct) return direct;
  const auth = obj(parse(env.OPENCODE_AUTH_CONTENT ?? '') ?? file(join(home, 'auth.json')));
  let key: string | undefined;
  for (const id of ['opencode-go', 'opencode']) {
    const entry = obj(auth[id]);
    if (entry.type === 'api' && str(entry.key).trim()) {
      key = str(entry.key).trim();
      break;
    }
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => join(configHome, 'opencode', name));
  if (env.OPENCODE_CONFIG?.trim()) files.push(env.OPENCODE_CONFIG.trim());
  if (cwd) files.push(join(cwd, 'opencode.json'), join(cwd, 'opencode.jsonc'));
  const configs = [...files.map(file), parse(env.OPENCODE_CONFIG_CONTENT ?? '')];
  for (const config of configs) {
    const providers = obj(obj(config).provider);
    const configured =
      str(obj(obj(providers['opencode-go']).options).apiKey) || str(obj(obj(providers.opencode).options).apiKey);
    const variable = configured.match(/^\{env:([^}]+)\}$/)?.[1];
    const value = variable ? env[variable]?.trim() : configured.trim();
    if (value && !value.includes('{file:')) key = value;
  }
  return key;
}

function parse(value: string): unknown {
  try {
    return parseJsonc(value);
  } catch {
    return undefined;
  }
}

function file(path: string): unknown {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function known(brain: BrainId, limits: LimitWindow[], source: BrainUsage['limitsSource']): BrainUsage {
  return { brain, limits, limitsSource: source, limitsObservedAt: new Date().toISOString(), limitsUnavailable: null };
}

function missing(brain: BrainId, reason: BrainUsage['limitsUnavailable'], detail: string): BrainUsage {
  return { brain, limits: null, limitsSource: null, limitsObservedAt: null, limitsUnavailable: reason, detail };
}

function failed(brain: BrainId, kind: ErrorKind, detail: string): BrainUsage {
  return {
    ...missing(brain, 'failed', detail),
    error: { kind, message: detail, retryable: ['network', 'timeout', 'rate_limited'].includes(kind) },
  };
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function seconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}
