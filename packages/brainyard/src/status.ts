/**
 * Is each CLI installed, signed in and ready — checked without spending a
 * cent where the CLI allows it, and with one tiny real call when you ask.
 *
 * What is free differs per CLI:
 * - Claude Code has `claude auth status` (JSON).
 * - Codex has `codex login status`.
 * - Antigravity has neither; `agy models` fetches the model list with your
 *   account, so a list coming back is the sign-in check.
 * - OpenCode has no account of its own: it runs the providers you connected,
 *   and `opencode models` lists only theirs — an empty list means none is.
 * Only a real call proves the whole path (network, account, model, limits):
 * that is `live: true`, the cheapest model and a one-word answer.
 */
import { ask } from './ask.js';
import { codexDefaultModel } from './brains/codex.js';
import { BRAINS, type Capabilities } from './brains/info.js';
import { opencodeDefaultModel } from './brains/opencode.js';
import { type Catalog, models, rememberAgyModels, rememberOpencodeModels } from './catalog.js';
import { BrainyardError, classifyFailure } from './errors.js';
import { oneLine } from './humanize.js';
import { type Command, capture, resolveCommand } from './process.js';
import { maskEmail } from './redact.js';
import type { BrainId, ErrorKind, LimitWindow } from './types.js';
import { BRAIN_IDS } from './types.js';
import { VERSION } from './version.js';

export type Availability = 'ready' | 'needs_login' | 'limited' | 'not_installed' | 'error' | 'unknown';

export interface AuthInfo {
  state: 'logged_in' | 'logged_out' | 'unknown';
  /** `claude.ai`, `ChatGPT`, `API key`… */
  method?: string;
  /** Subscription, when the CLI says (`pro`, `max`). */
  plan?: string;
  /** Masked unless `revealAccount` is set. */
  account?: string;
  detail?: string;
}

export interface PingResult {
  ok: boolean;
  ms: number;
  text?: string;
  model?: string;
  costUsd: number | null;
  limits: LimitWindow[];
  error?: { kind: ErrorKind; message: string; resetsAt?: string };
}

export interface BrainStatus {
  id: BrainId;
  label: string;
  vendor: string;
  binary: string;
  homepage: string;
  availability: Availability;
  /** One line for humans. */
  summary: string;
  installed: boolean;
  path?: string;
  version?: string;
  auth: AuthInfo;
  defaultModel?: string;
  capabilities: Capabilities;
  models?: Catalog;
  ping?: PingResult;
  /** What to do when it is not ready. */
  fix?: string;
  checkedAt: string;
}

export interface StatusReport {
  brains: BrainStatus[];
  /** Ids of the CLIs that are ready. */
  ready: BrainId[];
  checkedAt: string;
  brainyard: string;
  node: string;
  platform: string;
}

export interface StatusOptions {
  /** Defaults to every CLI Brainyard knows. */
  brains?: BrainId[];
  /** One real, minimal call per installed CLI to prove it works (costs a fraction of a cent). */
  live?: boolean;
  /** Include each CLI's model catalog. */
  models?: boolean;
  /** Override executables, as in `RunOptions.command`. */
  commands?: Partial<Record<BrainId, string | string[]>>;
  /** Show the account email unmasked. */
  revealAccount?: boolean;
}

const VERSION_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 20_000;

export async function status(options: StatusOptions = {}): Promise<StatusReport> {
  const ids = options.brains ?? [...BRAIN_IDS];
  const brains = await Promise.all(ids.map((id) => checkBrain(id, options)));
  return {
    brains,
    ready: brains.filter((brain) => brain.availability === 'ready').map((brain) => brain.id),
    checkedAt: new Date().toISOString(),
    brainyard: VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

export async function checkBrain(id: BrainId, options: StatusOptions = {}): Promise<BrainStatus> {
  const info = BRAINS[id];
  const override = options.commands?.[id];
  const command = resolveCommand(override, info.binary, info.envVar);
  const base = {
    id,
    label: info.label,
    vendor: info.vendor,
    binary: info.binary,
    homepage: info.homepage,
    capabilities: info.capabilities,
    checkedAt: new Date().toISOString(),
  };
  if (!command) {
    return {
      ...base,
      availability: 'not_installed',
      summary: `${info.label} is not installed`,
      installed: false,
      auth: { state: 'unknown' },
      fix: `${info.install}, then ${info.login}`,
    };
  }

  const [version, auth, catalog] = await Promise.all([
    readVersion(command),
    readAuth(id, command, options.revealAccount === true),
    // Antigravity and OpenCode list their models as the sign-in check: one call gives both.
    options.models && id !== 'antigravity' && id !== 'opencode'
      ? models(id, override === undefined ? {} : { command: override })
      : undefined,
  ]);
  const out: BrainStatus = {
    ...base,
    availability: 'unknown',
    summary: '',
    installed: true,
    path: command.file,
    auth: auth.auth,
  };
  if (version.version) out.version = version.version;
  const theCatalog = catalog ?? auth.catalog;
  if (options.models && theCatalog) out.models = theCatalog;
  const fallback = id === 'codex' ? codexDefaultModel() : id === 'opencode' ? opencodeDefaultModel() : undefined;
  if (fallback) out.defaultModel = fallback;

  if (!version.version) {
    out.availability = 'error';
    out.summary = `${info.label} was found but does not answer \`--version\`: ${version.problem}`;
    out.fix = `reinstall: ${info.install}`;
    return out;
  }

  if (options.live) {
    const pinged = await ping(id, override === undefined ? {} : { command: override });
    out.ping = pinged;
    if (pinged.ok) {
      out.availability = 'ready';
      // A real answer is better evidence of a sign-in than any status command.
      if (out.auth.state !== 'logged_in') out.auth = { ...out.auth, state: 'logged_in' };
    } else {
      const kind = pinged.error?.kind;
      out.availability =
        kind === 'not_logged_in'
          ? 'needs_login'
          : kind === 'usage_limit' || kind === 'rate_limited'
            ? 'limited'
            : 'error';
    }
  } else {
    out.availability =
      out.auth.state === 'logged_in' ? 'ready' : out.auth.state === 'logged_out' ? 'needs_login' : 'unknown';
  }

  out.summary = describe(out);
  const fix = fixFor(out);
  if (fix) out.fix = fix;
  return out;
}

function describe(brain: BrainStatus): string {
  const head = `${brain.label} ${brain.version ?? ''}`.trim();
  const how = [brain.auth.method, brain.auth.plan].filter(Boolean).join(', ');
  const who = brain.auth.account ? ` as ${brain.auth.account}` : '';
  switch (brain.availability) {
    case 'ready':
      return brain.ping?.ok
        ? `${head} · answered in ${(brain.ping.ms / 1000).toFixed(1)}s${how ? ` · ${how}` : ''}`
        : `${head} · signed in${how ? ` with ${how}` : ''}${who}`;
    case 'needs_login':
      return `${head} · not signed in`;
    case 'limited':
      return `${head} · limit reached${brain.ping?.error?.resetsAt ? `, resets ${brain.ping.error.resetsAt}` : ''}`;
    case 'error':
      return `${head} · ${brain.ping?.error?.message ?? 'not working'}`;
    default:
      return `${head} · sign-in unknown${brain.auth.detail ? ` (${brain.auth.detail})` : ''}`;
  }
}

function fixFor(brain: BrainStatus): string | undefined {
  const info = BRAINS[brain.id];
  switch (brain.availability) {
    case 'needs_login':
      return info.login;
    case 'limited':
      return 'wait for the limit to reset, or use another brain';
    case 'error':
      return brain.ping?.error ? `try the CLI directly: \`${info.binary}\`` : `reinstall: ${info.install}`;
    case 'unknown':
      return 'confirm with a real call: brainyard status --live (costs a fraction of a cent)';
    default:
      return undefined;
  }
}

async function readVersion(command: Command): Promise<{ version?: string; problem: string }> {
  const got = await capture(command, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
  if (got.error) return { problem: got.error.message };
  if (got.timedOut) return { problem: `no answer in ${VERSION_TIMEOUT_MS / 1000}s` };
  const text = `${got.stdout}\n${got.stderr}`;
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(text);
  if (got.code !== 0 || !match) return { problem: oneLine(text).slice(0, 160) || `exit code ${got.code}` };
  return { version: match[0], problem: '' };
}

interface AuthRead {
  auth: AuthInfo;
  catalog?: Catalog;
}

async function readAuth(id: BrainId, command: Command, reveal: boolean): Promise<AuthRead> {
  try {
    if (id === 'claude') return { auth: await claudeAuth(command, reveal) };
    if (id === 'codex') return { auth: await codexAuth(command) };
    if (id === 'opencode') return await opencodeAuth(command);
    return await antigravityAuth(command);
  } catch (error) {
    return { auth: { state: 'unknown', detail: (error as Error).message } };
  }
}

async function claudeAuth(command: Command, reveal: boolean): Promise<AuthInfo> {
  const got = await capture(command, ['auth', 'status'], { timeoutMs: AUTH_TIMEOUT_MS });
  const text = got.stdout.trim();
  let data: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = undefined;
  }
  if (!data) {
    const words = `${text}\n${got.stderr}`;
    if (/not (logged|signed) in|log ?in required/i.test(words)) return { state: 'logged_out' };
    return { state: 'unknown', detail: '`claude auth status` gave no answer this version understands' };
  }
  if (data.loggedIn !== true) {
    // An API key in the environment works without a login the CLI would report.
    return process.env.ANTHROPIC_API_KEY
      ? { state: 'unknown', detail: 'ANTHROPIC_API_KEY is set; confirm with a live check' }
      : { state: 'logged_out' };
  }
  const auth: AuthInfo = { state: 'logged_in' };
  if (typeof data.authMethod === 'string') auth.method = data.authMethod;
  if (typeof data.subscriptionType === 'string' && data.subscriptionType) auth.plan = data.subscriptionType;
  if (typeof data.email === 'string' && data.email) auth.account = reveal ? data.email : maskEmail(data.email);
  return auth;
}

async function codexAuth(command: Command): Promise<AuthInfo> {
  const got = await capture(command, ['login', 'status'], { timeoutMs: AUTH_TIMEOUT_MS });
  const text = `${got.stdout}\n${got.stderr}`;
  if (/not logged in/i.test(text)) {
    return process.env.OPENAI_API_KEY
      ? { state: 'unknown', detail: 'OPENAI_API_KEY is set; confirm with a live check' }
      : { state: 'logged_out' };
  }
  const match = /logged in using (?:an? )?([^\n-]+?)(?:\s+-|\n|$)/i.exec(text);
  if (got.code === 0 && match) {
    const method = match[1]?.trim();
    return method ? { state: 'logged_in', method } : { state: 'logged_in' };
  }
  if (got.code !== 0 && got.code !== null) return { state: 'logged_out', detail: oneLine(text).slice(0, 160) };
  return { state: 'unknown', detail: '`codex login status` gave no answer this version understands' };
}

async function antigravityAuth(command: Command): Promise<AuthRead> {
  const got = await capture(command, ['models'], { timeoutMs: AUTH_TIMEOUT_MS });
  const text = `${got.stdout}\n${got.stderr}`;
  const catalog = got.code === 0 ? rememberAgyModels(command, got.stdout) : undefined;
  if (catalog) {
    // The list comes from the service, with your account: that is the sign-in check.
    return { auth: { state: 'logged_in', detail: 'model list fetched with your account' }, catalog };
  }
  if (classifyFailure(text).kind === 'not_logged_in' || /sign ?in|log ?in/i.test(text)) {
    return { auth: { state: 'logged_out', detail: oneLine(text).slice(0, 160) } };
  }
  return {
    auth: { state: 'unknown', detail: got.timedOut ? '`agy models` did not answer' : oneLine(text).slice(0, 160) },
  };
}

async function opencodeAuth(command: Command): Promise<AuthRead> {
  const got = await capture(command, ['models', '--verbose'], { timeoutMs: AUTH_TIMEOUT_MS });
  const catalog = got.code === 0 ? rememberOpencodeModels(command, got.stdout) : undefined;
  if (catalog) {
    const providers = [...new Set(catalog.models.map((model) => model.id.split('/')[0]))];
    return { auth: { state: 'logged_in', method: providers.join(', ') }, catalog };
  }
  if (got.code === 0) {
    return { auth: { state: 'logged_out', detail: 'no provider is connected: `opencode models` lists nothing' } };
  }
  const text = `${got.stdout}\n${got.stderr}`;
  return {
    auth: { state: 'unknown', detail: got.timedOut ? '`opencode models` did not answer' : oneLine(text).slice(0, 160) },
  };
}

const PING_PROMPT = 'Reply with exactly one word: pong';

/** The cheapest real call each CLI allows: proves network, account, model and limits. */
export async function ping(
  brain: BrainId,
  options: { command?: string | string[]; timeoutMs?: number } = {},
): Promise<PingResult> {
  const started = Date.now();
  const cheapest: Record<BrainId, { model?: string; effort?: string }> = {
    claude: { model: 'haiku' },
    codex: { effort: 'low' },
    antigravity: { effort: 'low' },
    // Its models are whatever providers you connected: the one you chose as default.
    opencode: {},
  };
  try {
    const answer = await ask(brain, PING_PROMPT, {
      ...cheapest[brain],
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.command === undefined ? {} : { command: options.command }),
    });
    const out: PingResult = {
      ok: true,
      ms: answer.durationMs,
      text: answer.text,
      costUsd: answer.costUsd,
      limits: answer.limits,
    };
    if (answer.model) out.model = answer.model;
    return out;
  } catch (error) {
    const failure =
      error instanceof BrainyardError
        ? error
        : new BrainyardError('failed', (error as Error)?.message ?? String(error));
    const out: PingResult = {
      ok: false,
      ms: Date.now() - started,
      costUsd: null,
      limits: [],
      error: { kind: failure.kind, message: failure.message },
    };
    if (failure.resetsAt && out.error) out.error.resetsAt = failure.resetsAt;
    return out;
  }
}
