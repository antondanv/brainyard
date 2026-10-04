/** Subscription snapshots and usage of saved conversations; live checks are explicitly requested. */
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { obj, str } from './brains/adapter.js';
import { brainId } from './brains/info.js';
import { estimateCost } from './cost.js';
import { BrainyardError } from './errors.js';
import { withoutSessionVars } from './process.js';
import { startAnswer } from './run.js';
import {
  agyHome,
  claudeHome,
  claudeSessionFiles,
  codexHome,
  type Database,
  opencodeHome,
  openSqlite,
  pathVariants,
  rolloutFiles,
  type SessionInfo,
  sessions,
} from './sessions.js';
import type { BrainId, LimitWindow, ModelPrice, RunError, Usage } from './types.js';
import { BRAIN_IDS, emptyUsage } from './types.js';
import {
  addUsage,
  agyUsage,
  claudeUsage,
  codexUsage,
  difference,
  jsonRecords,
  opencodeUsage,
  type UsageSample,
} from './usage-readers.js';

export interface UsageOptions {
  /** Sessions of this folder. Defaults to process.cwd(). Limits apply to the whole account. */
  cwd?: string;
  /** Defaults to all supported stores, including OpenCode. */
  brains?: readonly (BrainId | string)[];
  /** Only this saved session in the selected folder. */
  sessionId?: string;
  /** Include headless runs. Defaults to false, as in sessions(). */
  headless?: boolean;
  /** Maximum sessions per CLI, newest first. Defaults to 200; 0 reads only limits. */
  limit?: number;
  homes?: Partial<Record<BrainId, string>>;
  /** Estimate dollars per model, using the same prices as run()/ask(). */
  prices?: Record<string, ModelPrice>;
  /** One minimal Claude call to read rate_limit_event. Defaults to false; can incur a charge. */
  live?: boolean;
  commands?: Partial<Record<BrainId, string | string[]>>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  /** OpenCode uses provider/model ids. Null means the store did not identify the model. */
  model: string | null;
  usage: Usage;
  costUsd: number | null;
  costSource: 'cli' | 'estimate' | null;
}

export interface SessionUsage extends SessionInfo {
  /** Null means there were no readable counters; zero counters are still known usage. */
  usage: Usage | null;
  /** Null if any usage could not be priced; a partial sum is not the session cost. */
  costUsd: number | null;
  costSource: 'cli' | 'estimate' | null;
  byModel: ModelUsage[];
  source: 'transcript' | 'rollout' | 'conversation_db' | 'opencode_db';
  unavailableReason: string | null;
}

export interface BrainUsage {
  brain: BrainId;
  /** Null means unavailable, not 0% used. */
  limits: LimitWindow[] | null;
  limitsSource: 'rollout' | 'live' | null;
  /** ISO snapshot observation time; Codex uses the persisted event timestamp. */
  limitsObservedAt: string | null;
  limitsUnavailable: 'not_requested' | 'missing' | 'unsupported' | 'failed' | null;
  detail?: string;
  /** A failed live check can still have delivered useful limit windows. */
  error?: RunError;
}

export interface UsageReport {
  brains: BrainUsage[];
  sessions: SessionUsage[];
  checkedAt: string;
}

/** Saved session tokens and account limit snapshots. Makes no inference call unless live is true. */
export async function usage(options: UsageOptions = {}): Promise<UsageReport> {
  const brains = [...new Set((options.brains ?? BRAIN_IDS).map(brainId))];
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 0)
    throw new BrainyardError('invalid_option', 'usage limit must be a nonnegative integer');
  const cwd = resolve(options.cwd ?? process.cwd());
  const places = pathVariants(cwd);
  const env = { ...process.env, ...options.env };
  const report: UsageReport = { brains: [], sessions: [], checkedAt: new Date().toISOString() };
  for (const brain of brains) {
    const home = options.homes?.[brain] ?? storeHome(brain, env);
    const list = await sessions({
      cwd,
      brains: [brain],
      homes: { [brain]: home },
      live: false,
      headless: options.headless,
      limit: options.sessionId && limit > 0 ? Number.MAX_SAFE_INTEGER : limit,
      env,
    });
    const selected = list.filter((session) => !options.sessionId || session.id === options.sessionId);
    if (brain === 'opencode') {
      report.brains.push(
        unavailable(
          brain,
          'unsupported',
          'OpenCode does not persist subscription windows; limits depend on the provider.',
        ),
      );
      report.sessions.push(...(await opencodeSessions(home, selected, options.prices)));
    } else if (brain === 'claude') {
      const files = new Map(claudeSessionFiles(home, places).map((path) => [basename(path, '.jsonl'), path]));
      for (const session of selected) {
        const samples = await claudeSamples(files.get(session.id));
        report.sessions.push(summarize(session, samples, 'transcript', options.prices));
      }
      report.brains.push(
        options.live
          ? await claudeLimits(home, env, options)
          : unavailable(brain, 'not_requested', 'Claude subscription windows require live: true.'),
      );
    } else if (brain === 'codex') {
      const snapshots = new Map<string, LimitSnapshot>();
      const files = rolloutFiles(join(home, 'sessions'));
      const wanted = new Map(selected.map((session) => [session.id, session]));
      for (const path of files) {
        const saved = await codexSamples(path);
        for (const [id, snapshot] of saved.snapshots) {
          if (!snapshots.has(id) || snapshots.get(id)!.at <= snapshot.at) snapshots.set(id, snapshot);
        }
        const session = wanted.get(saved.id);
        if (session) {
          wanted.delete(saved.id);
          report.sessions.push(summarize(session, saved.samples, 'rollout', options.prices));
        }
      }
      for (const session of wanted.values()) report.sessions.push(summarize(session, [], 'rollout', options.prices));
      const latest = [...snapshots.values()].sort((a, b) => b.at.localeCompare(a.at));
      report.brains.push(
        latest.length
          ? {
              brain,
              limits: latest.flatMap((snapshot) => snapshot.windows.map((window) => ({ ...window }))),
              limitsSource: 'rollout',
              limitsObservedAt: latest[0]!.at,
              limitsUnavailable: null,
            }
          : unavailable(brain, 'missing', 'No readable rate_limits snapshot in the Codex rollouts.'),
      );
    } else {
      report.brains.push(
        unavailable(
          brain,
          'unsupported',
          'Antigravity exposes model quotas through the /usage TUI; no machine-readable quota snapshot was found in its stores.',
        ),
      );
      for (const session of selected) {
        const safe = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session.id);
        const samples = safe
          ? ((await readDatabase(join(home, 'conversations', `${session.id}.db`), (db) =>
              db
                .prepare('SELECT data FROM gen_metadata ORDER BY idx')
                .all()
                .flatMap((row) => {
                  const sample = agyUsage(obj(row).data);
                  return sample ? [sample] : [];
                }),
            )) ?? [])
          : [];
        report.sessions.push(
          summarize(
            session,
            samples,
            'conversation_db',
            options.prices,
            'No readable generator metadata for this Antigravity conversation.',
          ),
        );
      }
    }
  }
  report.sessions.sort(
    (a, b) => (Date.parse(b.updatedAt ?? b.startedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? a.startedAt ?? '') || 0),
  );
  return report;
}

function storeHome(brain: BrainId, env: NodeJS.ProcessEnv): string {
  if (brain === 'claude') return claudeHome(env);
  if (brain === 'codex') return codexHome(env);
  if (brain === 'opencode') return opencodeHome(env);
  return agyHome();
}

function unavailable(brain: BrainId, reason: BrainUsage['limitsUnavailable'], detail: string): BrainUsage {
  return { brain, limits: null, limitsSource: null, limitsObservedAt: null, limitsUnavailable: reason, detail };
}

async function claudeSamples(path: string | undefined): Promise<UsageSample[]> {
  if (!path) return [];
  const byId = new Map<string, UsageSample>();
  for await (const entry of jsonRecords(path)) {
    if (entry.type !== 'assistant') continue;
    const message = obj(entry.message);
    const id = str(message.id);
    const tokens = claudeUsage(obj(message.usage));
    if (id && tokens) byId.set(id, { usage: tokens, ...(str(message.model) ? { model: str(message.model) } : {}) });
  }
  return [...byId.values()];
}

interface LimitSnapshot {
  at: string;
  windows: LimitWindow[];
}

interface CodexSaved {
  id: string;
  samples: UsageSample[];
  snapshots: Map<string, LimitSnapshot>;
}

// Account limits require all rollouts; dashboards should not reread an unchanged archive.
const codexCache = new Map<string, { stamp: string; saved: Promise<CodexSaved> }>();
const CODEX_CACHE_SIZE = 512;
const CODEX_RECORDS = /"type"\s*:\s*"(?:session_meta|turn_context|token_count)"/;

function codexSamples(path: string): Promise<CodexSaved> {
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    codexCache.delete(path);
    return Promise.resolve({ id: '', samples: [], snapshots: new Map() });
  }
  const cached = codexCache.get(path);
  if (cached?.stamp === stamp) {
    codexCache.delete(path);
    codexCache.set(path, cached);
    return cached.saved;
  }
  const saved = readCodexSamples(path);
  codexCache.delete(path);
  codexCache.set(path, { stamp, saved });
  if (codexCache.size > CODEX_CACHE_SIZE) codexCache.delete(codexCache.keys().next().value!);
  return saved;
}

async function readCodexSamples(path: string): Promise<CodexSaved> {
  const snapshots = new Map<string, LimitSnapshot>();
  let id = '',
    model: string | undefined,
    previous = emptyUsage();
  let samples: UsageSample[] = [];
  for await (const entry of jsonRecords(path, CODEX_RECORDS)) {
    const payload = obj(entry.payload);
    if (entry.type === 'session_meta') id = str(payload.id) || str(payload.session_id);
    else if (entry.type === 'turn_context') model = str(payload.model) || undefined;
    else if (entry.type === 'event_msg' && payload.type === 'token_count') {
      const total = codexUsage(obj(obj(payload.info).total_token_usage));
      if (total) {
        const delta = difference(total, previous);
        if (!delta) {
          // A reset/correction keeps the latest total, but its historical models are unknown.
          samples = [{ usage: total }];
        } else if (!samples.length || Object.values(delta).some((value) => value > 0)) {
          samples.push({ usage: delta, ...(model ? { model } : {}) });
        }
        previous = total;
      }
      const limits = obj(payload.rate_limits);
      const at = iso(entry.timestamp);
      if (!at) continue;
      const limitId = str(limits.limit_id);
      const windows: LimitWindow[] = [];
      for (const window of ['primary', 'secondary']) {
        const raw = obj(limits[window]);
        if (!validNumber(raw.used_percent)) continue;
        const value: LimitWindow = { window, utilization: raw.used_percent / 100 };
        if (validNumber(raw.resets_at)) value.resetsAt = raw.resets_at;
        if (validNumber(raw.window_minutes)) value.windowMinutes = raw.window_minutes;
        if (limitId) value.limitId = limitId;
        windows.push(value);
      }
      if (windows.length && (!snapshots.has(limitId) || snapshots.get(limitId)!.at <= at))
        snapshots.set(limitId, { at, windows });
    }
  }
  return { id, samples, snapshots };
}

function summarize(
  session: SessionInfo,
  samples: UsageSample[],
  source: SessionUsage['source'],
  prices: UsageOptions['prices'],
  missing = 'No readable token counters for this session.',
): SessionUsage {
  const byModel = new Map<string | null, UsageSample[]>();
  for (const sample of samples) {
    const model = sample.model || null;
    const group = byModel.get(model) ?? [];
    group.push(sample);
    byModel.set(model, group);
  }
  const rows: ModelUsage[] = [...byModel].map(([model, values]) => ({ model, ...totals(values, prices) }));
  const sum = totals(samples, prices);
  return {
    ...session,
    usage: samples.length ? sum.usage : null,
    costUsd: samples.length ? sum.costUsd : null,
    costSource: samples.length ? sum.costSource : null,
    byModel: rows,
    source,
    unavailableReason: samples.length ? null : missing,
  };
}

function totals(samples: UsageSample[], prices: UsageOptions['prices']): Omit<ModelUsage, 'model'> {
  const usage = emptyUsage();
  let cost = 0,
    unknown = false,
    estimated = false;
  for (const sample of samples) {
    addUsage(usage, sample.usage);
    const dollars = sample.costUsd ?? estimateCost(sample.model, sample.usage, prices);
    if (dollars === undefined) unknown = true;
    else cost += dollars;
    if (sample.costUsd === undefined) estimated = true;
  }
  return {
    usage,
    costUsd: unknown ? null : Math.round(cost * 1e8) / 1e8,
    costSource: unknown ? null : estimated ? 'estimate' : 'cli',
  };
}

async function readDatabase<T>(path: string, read: (db: Database) => T): Promise<T | undefined> {
  const open = await openSqlite();
  if (!open) return undefined;
  let db: Database | undefined;
  try {
    db = open(path);
    return read(db);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

async function opencodeSessions(
  home: string,
  selected: SessionInfo[],
  prices: UsageOptions['prices'],
): Promise<SessionUsage[]> {
  if (!selected.length) return [];
  return (
    (await readDatabase(join(home, 'opencode.db'), (db) => {
      return selected.map((session) => {
        const samples: UsageSample[] = [];
        for (const message of db
          .prepare('SELECT data FROM message WHERE session_id = ? ORDER BY time_created, id')
          .all(session.id)) {
          const m = obj(parseJson(obj(message).data));
          if (m.role !== 'assistant') continue;
          const tokens = opencodeUsage(obj(m.tokens));
          if (!tokens) continue;
          const model = str(m.modelID);
          const provider = str(m.providerID);
          samples.push({
            usage: tokens,
            ...(model ? { model: provider ? `${provider}/${model}` : model } : {}),
            ...(validNumber(m.cost) && (m.cost > 0 || Object.values(tokens).every((value) => value === 0))
              ? { costUsd: m.cost }
              : {}),
          });
        }
        if (!samples.length) {
          // Some stores retain session totals after the individual messages are gone.
          const row = obj(db.prepare('SELECT * FROM session WHERE id = ?').all(session.id)[0]);
          const tokens = opencodeUsage({
            input: row.tokens_input,
            output: row.tokens_output,
            reasoning: row.tokens_reasoning,
            cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
          });
          if (tokens)
            samples.push({
              usage: tokens,
              ...(validNumber(row.cost) && (row.cost > 0 || Object.values(tokens).every((value) => value === 0))
                ? { costUsd: row.cost }
                : {}),
            });
        }
        return summarize(session, samples, 'opencode_db', prices);
      });
    })) ?? selected.map((session) => summarize(session, [], 'opencode_db', prices))
  );
}

async function claudeLimits(home: string, env: NodeJS.ProcessEnv, options: UsageOptions): Promise<BrainUsage> {
  const brain: BrainUsage = unavailable('claude', 'missing', 'The live Claude call did not emit subscription windows.');
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'brainyard-usage-'));
    const command = options.commands?.claude ?? env.BRAINYARD_CLAUDE_BIN;
    const result = await startAnswer(
      {
        brain: 'claude',
        prompt: 'Reply with exactly one word: pong',
        cwd: dir,
        model: 'haiku',
        validate: false,
        access: 'readonly',
        web: false,
        shell: false,
        nudge: false,
        timeoutMs: options.timeoutMs ?? 30_000,
        signal: options.signal,
        env: Object.fromEntries(
          Object.entries(withoutSessionVars({ ...env, CLAUDE_CONFIG_DIR: home })).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...(command ? { command } : {}),
      },
      undefined,
    ).result;
    if (result.limits.length) {
      brain.limits = result.limits;
      brain.limitsSource = 'live';
      brain.limitsObservedAt = new Date().toISOString();
      brain.limitsUnavailable = null;
      delete brain.detail;
    }
    if (result.error) {
      brain.error = result.error;
      if (!brain.limits) brain.limitsUnavailable = 'failed';
    }
  } catch (error) {
    brain.limitsUnavailable = 'failed';
    const failure =
      error instanceof BrainyardError
        ? error
        : new BrainyardError('failed', error instanceof Error ? error.message : String(error));
    brain.error = { kind: failure.kind, message: failure.message, retryable: failure.retryable };
    if (failure.resetsAt) brain.error.resetsAt = failure.resetsAt;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  return brain;
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function iso(value: unknown): string | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
