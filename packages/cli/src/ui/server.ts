/**
 * The local dashboard and its HTTP API.
 *
 * This server can start agents with full access to the machine, so it is
 * guarded like one:
 * - it listens on 127.0.0.1 unless told otherwise;
 * - every API call needs the token printed at start (a bearer header, never a
 *   URL: URLs end up in history and logs; the page gets it from the `#`
 *   fragment, which browsers do not send anywhere);
 * - the Host header must name this server, which defeats DNS rebinding;
 * - state-changing calls must be JSON from this origin, which a cross-site
 *   form or a simple request cannot produce.
 *
 * With an app (`brainyard web`) the page is the app's screen: its frames
 * come as server-sent events, keys, clicks and the size go back as JSON,
 * all under /api/app/ and the same guard.
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Access,
  type AgentEvent,
  type AgentRun,
  ask,
  type BrainId,
  BrainyardError,
  brainId,
  capturePane,
  clip,
  closePane,
  listPanes,
  liveSessions,
  type ModelPrice,
  models,
  type RunResult,
  resizePane,
  type StatusReport,
  sessions,
  start,
  startPane,
  status,
  stopSession,
  tidyPaths,
  type UsageOptions,
  usage,
} from '@antondanv/brainyard';

import { readPanes, typeInto } from '../panes.js';
import type { MouseAction } from '../tui/state.js';
import type { WebEvent, WebScreen } from '../tui/web.js';
import { VERSION } from '../version.js';
import { FAVICON, page } from './page.js';

export interface ServeOptions {
  /** 0 picks a free port. Defaults to 4747, or the next free one. */
  port?: number;
  host?: string;
  /** Defaults to a random one per start. */
  token?: string;
  /** The app to show at `/` instead of the dashboard: `brainyard web`. */
  app?: WebScreen;
  /** Where `GET /api/status` comes from instead of the CLIs: the demo's made-up machine. */
  status?: (live: boolean) => Promise<StatusReport>;
}

export interface Dashboard {
  /** The dashboard, with the token in the fragment. */
  url: string;
  /** Where the API answers: `http://127.0.0.1:4747`. */
  origin: string;
  port: number;
  host: string;
  token: string;
  /** Listening on a loopback address only. */
  local: boolean;
  close(): Promise<void>;
}

interface Tracked {
  id: string;
  brain: BrainId;
  prompt: string;
  cwd: string;
  startedAt: string;
  agent: AgentRun;
  result?: RunResult;
  /** The run was refused before it started. */
  refused?: ReturnType<typeof errorBody>;
}

const MOUSE: readonly MouseAction[] = ['click', 'double', 'wheel-up', 'wheel-down'];
const MAX_RUNS = 50;
const MAX_BODY = 1_000_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function serve(options: ServeOptions = {}): Promise<Dashboard> {
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? randomBytes(18).toString('base64url');
  const runs = new Map<string, Tracked>();
  let port = options.port ?? 4747;

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) res.end();
      else if (error instanceof BrainyardError) sendError(res, error);
      else send(res, 500, { error: { kind: 'failed', message: (error as Error).message } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!hostAllowed(req.headers.host, port, host)) {
      send(res, 421, { error: { kind: 'invalid_option', message: 'unexpected Host header' } });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // With the app, the dashboard and its playground are a page further: one server, one token.
    const dashboard = options.app
      ? url.pathname === '/dashboard'
      : url.pathname === '/' || url.pathname === '/index.html';
    const app = options.app !== undefined && (url.pathname === '/' || url.pathname === '/index.html');
    if (req.method === 'GET' && (app || dashboard)) {
      const { html, scriptHash } = page(VERSION, app ? 'app' : 'dashboard');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // Only the page's own script runs: anything injected would not match the hash.
        'Content-Security-Policy': `default-src 'none'; script-src '${scriptHash}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      res.end(FAVICON);
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      send(res, 404, { error: { kind: 'invalid_option', message: 'not found' } });
      return;
    }
    if (!authorised(req.headers.authorization, token)) {
      send(res, 401, { error: { kind: 'invalid_option', message: 'missing or wrong token' } });
      return;
    }
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin, port, host)) {
        send(res, 403, { error: { kind: 'invalid_option', message: 'cross-origin request refused' } });
        return;
      }
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        send(res, 415, { error: { kind: 'invalid_option', message: 'send JSON' } });
        return;
      }
    }
    await api(req, res, url);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const method = req.method ?? 'GET';

    if (method === 'GET' && parts[0] === 'status' && parts.length === 1) {
      const live = url.searchParams.get('live') === '1';
      const report = await (options.status ? options.status(live) : status({ live, models: true }));
      // `~/.local/bin/claude` reads better and screenshots better than a full home path.
      for (const brain of report.brains) if (brain.path) brain.path = tidyPaths(brain.path);
      send(res, 200, report);
      return;
    }
    if (method === 'GET' && parts[0] === 'models' && parts.length === 2) {
      const brain = brainId(parts[1] ?? '');
      send(res, 200, await models(brain, { refresh: url.searchParams.get('refresh') === '1' }));
      return;
    }
    if (method === 'POST' && parts[0] === 'ask' && parts.length === 1) {
      const body = await readJson(req);
      try {
        const answer = await ask(String(body.brain ?? ''), String(body.prompt ?? ''), {
          ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
          ...(typeof body.effort === 'string' && body.effort ? { effort: body.effort } : {}),
          ...(typeof body.system === 'string' && body.system ? { system: body.system } : {}),
          ...(body.web === true ? { web: true } : {}),
        });
        send(res, 200, answer);
      } catch (error) {
        sendError(res, error);
      }
      return;
    }
    if (parts[0] === 'runs') {
      await runsApi(req, res, method, parts.slice(1));
      return;
    }
    if (parts[0] === 'sessions') {
      await sessionsApi(req, res, method, parts.slice(1), url.searchParams);
      return;
    }
    if (method === 'POST' && parts[0] === 'usage' && parts.length === 1) {
      send(res, 200, await usage(usageOptions(await readJson(req))));
      return;
    }
    if (parts[0] === 'panes') {
      await panesApi(req, res, method, parts.slice(1), url.searchParams);
      return;
    }
    if (parts[0] === 'app' && options.app) {
      await appApi(req, res, method, parts.slice(1), options.app);
      return;
    }
    send(res, 404, { error: { kind: 'invalid_option', message: 'no such endpoint' } });
  }

  async function appApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    rest: string[],
    app: WebScreen,
  ): Promise<void> {
    if (method === 'GET' && rest.length === 1 && rest[0] === 'frames') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const write = (text: string) => {
        if (!res.writableEnded && !res.destroyed) res.write(text);
      };
      const unwatch = app.watch((event: WebEvent) => write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`));
      const keepAlive = setInterval(() => write(': keep-alive\n\n'), 15_000);
      req.on('close', () => {
        unwatch();
        clearInterval(keepAlive);
      });
      return;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = await readJson(req);
      switch (rest[0]) {
        case 'input': {
          if (typeof body.data !== 'string' || !body.data) {
            throw new BrainyardError('invalid_option', 'nothing to type: give data, the bytes a terminal would send');
          }
          if (body.paste === true) app.paste(body.data);
          else app.input(body.data);
          send(res, 200, { ok: true });
          return;
        }
        case 'mouse': {
          const action = MOUSE.find((name) => name === body.action);
          if (!action) throw new BrainyardError('invalid_option', `action is one of ${MOUSE.join(', ')}`);
          const x = count(body.x, 'x', 0);
          const y = count(body.y, 'y', 0);
          if (x === undefined || y === undefined) throw new BrainyardError('invalid_option', 'mouse wants x and y');
          app.mouse(action, x, y);
          send(res, 200, { ok: true });
          return;
        }
        case 'resize': {
          const width = count(body.width, 'width');
          const height = count(body.height, 'height');
          if (!width || !height) throw new BrainyardError('invalid_option', 'resize wants width and height');
          app.resize(width, height);
          send(res, 200, { ok: true });
          return;
        }
      }
    }
    send(res, 404, { error: { kind: 'invalid_option', message: 'no such endpoint' } });
  }

  async function sessionsApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    rest: string[],
    query: URLSearchParams,
  ): Promise<void> {
    const cwd = query.get('cwd') || undefined;
    const brains = query.getAll('brain').map((name) => brainId(name));
    if (method === 'GET' && rest.length === 0) {
      const limit = count(query.get('limit'), 'limit');
      const list = await sessions({
        ...(cwd ? { cwd } : {}),
        ...(brains.length > 0 ? { brains } : {}),
        headless: query.get('headless') === '1',
        ...(limit ? { limit } : {}),
      });
      send(res, 200, list);
      return;
    }
    if (method === 'GET' && rest.length === 1 && rest[0] === 'live') {
      const list = await liveSessions({
        ...(cwd ? { cwd } : {}),
        ...(brains.length > 0 ? { brains } : {}),
        all: query.get('all') === '1',
        // Codex shows some approval dialogs only on screen: look at Brainyard's panes too.
        panes: {},
      });
      send(res, 200, list);
      return;
    }
    if (method === 'POST' && rest.length === 2 && rest[1] === 'stop') {
      const sessionId = rest[0] ?? '';
      if (!/^[\w-]+$/.test(sessionId)) throw new BrainyardError('invalid_option', 'not a session id');
      const body = await readJson(req);
      let folder = text(body.cwd);
      if (!folder) {
        // The caller named the session: it is stopped in the folder it belongs to.
        folder = (await liveSessions({ brains: ['claude'] })).find((session) => session.id === sessionId)?.cwd;
        if (!folder) {
          send(res, 200, { result: 'not-running' });
          return;
        }
      }
      const result = await stopSession({ brain: text(body.brain) ?? 'claude', sessionId, cwd: folder });
      send(res, 200, { result });
      return;
    }
    send(res, 404, { error: { kind: 'invalid_option', message: 'no such endpoint' } });
  }

  async function panesApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    rest: string[],
    query: URLSearchParams,
  ): Promise<void> {
    if (rest.length === 0 && method === 'GET') {
      send(res, 200, await readPanes());
      return;
    }
    if (rest.length === 0 && method === 'POST') {
      const body = await readJson(req);
      const cwd = text(body.cwd);
      if (!cwd) throw new BrainyardError('invalid_option', 'cwd is required: the folder the CLI works in');
      const width = count(body.width, 'width');
      const height = count(body.height, 'height');
      const worktree = body.worktree === true ? true : text(body.worktree);
      const started = await startPane({
        brain: brainId(String(body.brain ?? '')),
        cwd,
        ...strings(body, ['prompt', 'resume', 'name', 'label', 'system', 'model', 'effort']),
        ...(text(body.mode) ? { permissionMode: text(body.mode) } : {}),
        ...(worktree ? { worktree } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
      send(res, 201, started);
      return;
    }
    // Exact names only: tmux would take a prefix and act on another pane.
    const pane = rest[0] ?? '';
    if (!/^[\w.-]+$/.test(pane)) throw new BrainyardError('invalid_option', 'not a pane name');
    const gone = () => send(res, 404, { error: { kind: 'invalid_option', message: `no such pane: ${pane}` } });
    if (rest.length === 2 && rest[1] === 'screen' && method === 'GET') {
      const scroll = count(query.get('scroll'), 'scroll', 0);
      const screen = await capturePane(pane, scroll ? { scroll } : {});
      if (screen) send(res, 200, screen);
      else gone();
      return;
    }
    if (rest.length === 2 && method === 'POST' && ['send', 'resize', 'close'].includes(rest[1] ?? '')) {
      const body = await readJson(req);
      if (!(await listPanes()).some((info) => info.pane === pane)) {
        gone();
        return;
      }
      if (rest[1] === 'send') {
        const data = typeof body.data === 'string' ? body.data : '';
        if (!data && body.enter !== true)
          throw new BrainyardError('invalid_option', 'nothing to send: give data, enter or both');
        await typeInto(pane, data, { enter: body.enter === true });
        send(res, 200, { sent: true });
      } else if (rest[1] === 'resize') {
        const width = count(body.width, 'width');
        const height = count(body.height, 'height');
        if (!width || !height) throw new BrainyardError('invalid_option', 'resize wants width and height');
        send(res, 200, { resized: await resizePane(pane, width, height) });
      } else if (await closePane(pane)) send(res, 200, { closed: true });
      else gone();
      return;
    }
    send(res, 404, { error: { kind: 'invalid_option', message: 'no such endpoint' } });
  }

  async function runsApi(req: IncomingMessage, res: ServerResponse, method: string, rest: string[]): Promise<void> {
    if (rest.length === 0 && method === 'GET') {
      send(res, 200, [...runs.values()].reverse().map(describe));
      return;
    }
    if (rest.length === 0 && method === 'POST') {
      const body = await readJson(req);
      let tracked: Tracked;
      try {
        const brain = brainId(String(body.brain ?? ''));
        // The playground works in a fresh folder unless you name one; it is
        // kept afterwards so you can look at what the agent made.
        const cwd =
          typeof body.cwd === 'string' && body.cwd.trim()
            ? body.cwd.trim()
            : mkdtempSync(join(tmpdir(), 'brainyard-playground-'));
        const access = typeof body.access === 'string' ? (body.access as Access) : 'workspace';
        const agent = start({
          brain,
          prompt: String(body.prompt ?? ''),
          cwd,
          access,
          ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
          ...(typeof body.effort === 'string' && body.effort ? { effort: body.effort } : {}),
          ...(typeof body.resume === 'string' && body.resume ? { resume: body.resume } : {}),
          ...(typeof body.web === 'boolean' ? { web: body.web } : {}),
        });
        const id = randomBytes(6).toString('hex');
        tracked = { id, brain, prompt: String(body.prompt ?? ''), cwd, startedAt: new Date().toISOString(), agent };
      } catch (error) {
        sendError(res, error);
        return;
      }
      runs.set(tracked.id, tracked);
      tracked.agent.result.then(
        (result) => {
          tracked.result = result;
        },
        (error: unknown) => {
          tracked.refused = errorBody(error);
        },
      );
      trim(runs);
      // Validation happens asynchronously; report a refusal right away rather than as a dead stream.
      const refusal = await Promise.race([
        tracked.agent.result.then(
          () => undefined,
          (error: unknown) => error,
        ),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
      ]);
      if (refusal) {
        runs.delete(tracked.id);
        sendError(res, refusal);
        return;
      }
      send(res, 201, describe(tracked));
      return;
    }
    const tracked = runs.get(rest[0] ?? '');
    if (!tracked) {
      send(res, 404, { error: { kind: 'invalid_option', message: 'no such run' } });
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      send(res, 200, { ...describe(tracked), result: tracked.result ? withoutEvents(tracked.result) : null });
      return;
    }
    if (rest[1] === 'events' && method === 'GET') {
      await stream(req, res, tracked);
      return;
    }
    if (rest[1] === 'hint' && method === 'POST') {
      const body = await readJson(req);
      send(res, 200, { delivered: tracked.agent.hint(String(body.text ?? '')) });
      return;
    }
    if (rest[1] === 'stop' && method === 'POST') {
      await readJson(req);
      tracked.agent.stop('stopped from the dashboard');
      send(res, 200, { stopping: true });
      return;
    }
    send(res, 404, { error: { kind: 'invalid_option', message: 'no such endpoint' } });
  }

  async function stream(req: IncomingMessage, res: ServerResponse, tracked: Tracked): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let open = true;
    req.on('close', () => {
      open = false;
    });
    const write = (event: string, data: unknown) => {
      if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const keepAlive = setInterval(() => {
      if (open) res.write(': keep-alive\n\n');
    }, 15_000);
    try {
      for await (const event of tracked.agent as AsyncIterable<AgentEvent>) {
        if (!open) break;
        write('agent', event);
      }
      const result = await tracked.agent.result;
      write('result', withoutEvents(result));
    } catch (error) {
      write('failure', errorBody(error));
    } finally {
      clearInterval(keepAlive);
      if (open) res.end();
    }
  }

  const listen = (at: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : at);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(at, host);
    });

  // The default port may be taken by a previous dashboard; try the next few.
  for (let attempt = 0; ; attempt++) {
    try {
      port = await listen(port);
      break;
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!busy || options.port !== undefined || attempt >= 10) throw error;
      port += 1;
    }
  }

  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const origin = `http://${shownHost}:${port}`;
  return {
    url: `${origin}/#token=${token}`,
    origin,
    port,
    host,
    token,
    local: LOOPBACK.has(host),
    close: () =>
      new Promise<void>((resolve) => {
        for (const tracked of runs.values()) if (!tracked.result) tracked.agent.stop('dashboard closed');
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function trim(runs: Map<string, Tracked>): void {
  if (runs.size <= MAX_RUNS) return;
  for (const [id, tracked] of runs) {
    if (runs.size <= MAX_RUNS) break;
    if (tracked.result) runs.delete(id);
  }
}

function describe(tracked: Tracked) {
  return {
    id: tracked.id,
    brain: tracked.brain,
    prompt: clip(tracked.prompt, 160),
    cwd: tracked.cwd,
    startedAt: tracked.startedAt,
    steerable: tracked.agent.steerable,
    sessionId: tracked.result?.sessionId ?? tracked.agent.sessionId ?? null,
    state: tracked.refused
      ? 'failed'
      : tracked.result
        ? tracked.result.ok
          ? 'done'
          : tracked.result.stopped
            ? 'stopped'
            : 'failed'
        : 'running',
  };
}

function withoutEvents(result: RunResult): Omit<RunResult, 'events'> {
  const { events: _events, ...rest } = result;
  return rest;
}

/** A non-empty string from a request, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** The non-empty strings among these fields of a request body. */
function strings<K extends string>(body: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = text(body[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A whole number from a query or a body; absent is undefined. */
function count(value: unknown, name: string, min = 1): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new BrainyardError('invalid_option', `${name} wants a whole number, not ${JSON.stringify(value)}`);
  }
  return number;
}

function usageOptions(body: Record<string, unknown>): UsageOptions {
  if (body.brains !== undefined && !Array.isArray(body.brains)) {
    throw new BrainyardError('invalid_option', 'brains wants a list of brain names');
  }
  const brains = Array.isArray(body.brains) ? body.brains.map((name) => brainId(String(name))) : undefined;
  const limit = count(body.limit, 'limit', 0);
  const timeoutMs = count(body.timeoutMs, 'timeoutMs');
  const prices = body.prices;
  if (prices !== undefined) {
    const valid =
      prices !== null &&
      typeof prices === 'object' &&
      !Array.isArray(prices) &&
      Object.values(prices).every((price) => {
        const { input, output } = (price ?? {}) as Record<string, unknown>;
        return typeof input === 'number' && typeof output === 'number';
      });
    if (!valid) throw new BrainyardError('invalid_option', 'prices wants {"model": {"input": 3, "output": 15}}');
  }
  return {
    ...strings(body, ['cwd', 'sessionId']),
    ...(brains ? { brains } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(body.headless === true ? { headless: true } : {}),
    ...(body.offline === true ? { offline: true } : {}),
    ...(body.live === true ? { live: true } : {}),
    ...(prices ? { prices: prices as Record<string, ModelPrice> } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function hostAllowed(header: string | undefined, port: number, host: string): boolean {
  if (!header) return false;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!LOOPBACK.has(host) && host !== '0.0.0.0' && host !== '::') {
    allowed.add(`${host.includes(':') ? `[${host}]` : host}:${port}`);
  }
  // Bound to every interface: the operator chose to be reachable by any name.
  if (host === '0.0.0.0' || host === '::') return true;
  return allowed.has(header.toLowerCase());
}

function originAllowed(origin: string, port: number, host: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && hostAllowed(parsed.host, port, host);
  } catch {
    return false;
  }
}

function authorised(header: string | undefined, token: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BrainyardError('invalid_option', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BrainyardError('invalid_option', 'the request body is not valid JSON');
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function errorBody(error: unknown) {
  if (error instanceof BrainyardError) {
    return {
      error: {
        kind: error.kind,
        message: error.message,
        ...(error.fix ? { fix: error.fix } : {}),
        ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}),
      },
    };
  }
  return { error: { kind: 'failed', message: (error as Error)?.message ?? String(error) } };
}

function sendError(res: ServerResponse, error: unknown): void {
  const body = errorBody(error);
  const code = body.error.kind === 'invalid_option' ? 400 : body.error.kind === 'not_installed' ? 424 : 502;
  send(res, code, body);
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Opens the default browser; silently does nothing where there is none. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // No browser: the URL is printed anyway.
  }
}
