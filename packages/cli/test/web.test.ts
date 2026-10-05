import { createHash } from 'node:crypto';
import { type ClientRequest, request } from 'node:http';

import type { PaneScreen, PaneStart } from '@antondanv/brainyard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaneRow } from '../src/panes.js';
import type { Sources } from '../src/tui/app.js';
import { DEFAULT_SETTINGS } from '../src/tui/settings.js';
import { startWeb, type WebEvent, type WebScreen } from '../src/tui/web.js';
import { type Dashboard, serve } from '../src/ui/server.js';
import { HERE, LIMITS, LIVE, NOW, PANES, SESSIONS, STATUS, USAGE } from './tui-world.js';

const TOKEN = 'web-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

let server: Dashboard;
let web: WebScreen;
let quit: () => void;
let sent: { pane: string; data: string }[];
let resized: { pane: string; width: number; height: number }[];
let panes: PaneRow[];
let gone: Set<string>;

/** What the CLI in a pane shows: what was typed into it, after a line of its own; history above. */
function screenOf(pane: string, scroll = 0): PaneScreen | undefined {
  if (gone.has(pane)) return undefined;
  const typed = sent
    .filter((entry) => entry.pane === pane)
    .map((entry) => entry.data)
    .join('');
  const lines = scroll
    ? [`history of ${pane}, ${scroll} rows up`]
    : [`\u001b[32m${pane}\u001b[39m ready`, `> ${typed}`];
  return {
    lines,
    width: 80,
    height: 24,
    cursor: { x: 2 + typed.length, y: 1, visible: true },
    historySize: 40,
    scrollOffset: scroll,
    mouseTracking: false,
    mouseSgr: false,
    alternate: false,
  };
}

beforeEach(async () => {
  sent = [];
  resized = [];
  panes = [...PANES];
  gone = new Set();
  quit = vi.fn();
  const sources: Partial<Sources> = {
    status: async () => STATUS,
    limits: async () => LIMITS,
    panes: async () => ({ tmux: true, panes }),
    live: async () => LIVE,
    sessions: async () => SESSIONS,
    usage: async () => USAGE,
    startPane: async (options): Promise<PaneStart> => {
      const pane = `${options.brain}-00000001`;
      panes = [...panes, { pane, brain: options.brain, cwd: options.cwd, attached: false, width: 80, height: 24 }];
      return { pane, brain: options.brain, startedAt: new Date(NOW).toISOString(), warnings: [], display: '' };
    },
    closePane: async () => true,
    stopSession: async () => 'stopped',
    capture: async (pane, scroll) => screenOf(pane, scroll),
    resize: async (pane, width, height) => {
      resized.push({ pane, width, height });
      return true;
    },
    send: async (pane, data) => {
      sent.push({ pane, data });
    },
    saveSettings: () => undefined,
  };
  web = startWeb({
    cwd: HERE,
    width: 100,
    height: 30,
    sources,
    clock: () => NOW,
    settings: DEFAULT_SETTINGS,
    settingsFile: '~/.config/brainyard/app.json',
    every: { panes: 60_000, live: 60_000, sessions: 60_000, usage: 60_000, limits: 60_000, status: 60_000 },
    look: 20,
    onQuit: () => quit(),
  });
  server = await serve({ port: 0, token: TOKEN, app: web });
});

afterEach(async () => {
  web.stop();
  await server.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<Reply>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: { host: `127.0.0.1:${server.port}`, ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined)
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

const post = (path: string, body: unknown) => call(path, { headers: json, body });

/** The app's frames as a page gets them: the screen it would show, kept up to date row by row. */
function watch() {
  const events: WebEvent[] = [];
  let rows: string[] = [];
  let status = 0;
  let headers: Record<string, string | string[] | undefined> = {};
  let req: ClientRequest | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: '/api/app/frames',
        headers: { host: `127.0.0.1:${server.port}`, ...auth },
      },
      (res) => {
        status = res.statusCode ?? 0;
        headers = res.headers;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
            const data = /^data: (.*)$/m.exec(buffer.slice(0, at))?.[1];
            buffer = buffer.slice(at + 2);
            if (!data) continue;
            const event = JSON.parse(data) as WebEvent;
            events.push(event);
            if (event.kind === 'frame') {
              if (event.full) rows = [];
              rows.length = event.height;
              for (const [index, line] of Object.entries(event.rows)) rows[Number(index)] = line;
            }
          }
        });
        resolve();
      },
    );
    req.on('error', reject);
    req.end();
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: frames carry colours.
  const plain = () => rows.map((line) => (line ?? '').replace(/\u001b\[[0-9;:]*m/g, ''));
  return {
    opened,
    events,
    status: () => status,
    headers: () => headers,
    plain,
    async until(wanted: string | RegExp, ms = 3_000): Promise<string> {
      const end = Date.now() + ms;
      const ok = () => {
        const text = plain().join('\n');
        return typeof wanted === 'string' ? text.includes(wanted) : wanted.test(text);
      };
      while (!ok() && Date.now() < end) await new Promise((done) => setTimeout(done, 15));
      const text = plain().join('\n');
      expect(text).toMatch(wanted);
      return text;
    },
    close: () => req?.destroy(),
  };
}

describe('brainyard web: the server', () => {
  it('serves the app at / with a policy that lets only its own script run', async () => {
    const page = await call('/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Brainyard</title>');
    expect(page.body).toContain('/api/app/frames');
    const policy = String(page.headers['content-security-policy']);
    const script = /<script>([\s\S]*?)<\/script>/.exec(page.body)?.[1] ?? '';
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(policy).toContain(`script-src 'sha256-${hash}'`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
  });

  it('guards the app as the API: the token, the Host, the origin, JSON', async () => {
    expect((await call('/api/app/frames')).status).toBe(401);
    expect((await call('/api/app/frames', { headers: { ...auth, authorization: 'Bearer nope' } })).status).toBe(401);
    // DNS rebinding: a page of another name that resolves here.
    expect((await call('/api/app/frames', { headers: { ...auth, host: `evil.example:${server.port}` } })).status).toBe(
      421,
    );
    const keys = { data: 'q' };
    expect((await call('/api/app/input', { headers: auth, body: keys })).status).toBe(415);
    expect(
      (await call('/api/app/input', { headers: { ...json, origin: 'http://evil.example' }, body: keys })).status,
    ).toBe(403);
    expect((await call('/api/app/input', { headers: { 'content-type': 'application/json' }, body: keys })).status).toBe(
      401,
    );
    expect(quit).not.toHaveBeenCalled();
    // The page's own origin is welcome.
    expect(
      (
        await call('/api/app/input', {
          headers: { ...json, origin: `http://127.0.0.1:${server.port}` },
          body: { data: '2' },
        })
      ).status,
    ).toBe(200);
  });

  it('keeps the whole API beside the app', async () => {
    const status = await call('/api/sessions/live?cwd=/nowhere', { headers: auth });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toBeInstanceOf(Array);
    expect((await call('/api/runs', { headers: auth })).status).toBe(200);
    expect((await call('/api/nothing', { headers: auth })).status).toBe(404);
  });

  it('refuses what is not a key, a click or a size', async () => {
    expect((await post('/api/app/input', { data: '' })).status).toBe(400);
    expect((await post('/api/app/input', { data: 42 })).status).toBe(400);
    expect((await post('/api/app/mouse', { action: 'drag', x: 1, y: 1 })).status).toBe(400);
    expect((await post('/api/app/mouse', { action: 'click', x: -1, y: 1 })).status).toBe(400);
    expect((await post('/api/app/mouse', { action: 'click' })).status).toBe(400);
    expect((await post('/api/app/resize', { width: 0, height: 10 })).status).toBe(400);
    expect((await post('/api/app/resize', { width: 'wide', height: 10 })).status).toBe(400);
    expect((await post('/api/app/scroll', {})).status).toBe(404);
  });

  it('a server without the app has no /api/app', async () => {
    const plain = await serve({ port: 0, token: TOKEN });
    try {
      const reply = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: plain.port,
            path: '/api/app/frames',
            headers: { host: `127.0.0.1:${plain.port}`, ...auth },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(reply).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe('brainyard web: the screen', () => {
  it('sends the frames the terminal shows, by server-sent events, then only the rows that changed', async () => {
    const page = watch();
    await page.opened;
    expect(page.status()).toBe(200);
    expect(String(page.headers()['content-type'])).toContain('text/event-stream');
    const text = await page.until('auth refactor');
    expect(text).toContain('Brainyard 0.');
    expect(text).toContain('[1 Overview]');
    expect(page.plain()).toHaveLength(30);
    expect(page.plain().every((line) => [...line].length <= 100)).toBe(true);
    // Colours come as they are, for the page to paint.
    const frame = page.events.find((event) => event.kind === 'frame' && Object.keys(event.rows).length > 0);
    expect(JSON.stringify(frame)).toContain('\\u001b[');
    const before = page.events.length;
    expect((await post('/api/app/input', { data: '4' })).status).toBe(200);
    await page.until('[4 Usage]');
    const changed = page.events.slice(before).filter((event) => event.kind === 'frame');
    expect(changed.every((event) => event.kind === 'frame' && !event.full)).toBe(true);
    expect(changed.some((event) => event.kind === 'frame' && Object.keys(event.rows).length < 30)).toBe(true);
    page.close();
  });

  it('gives a page that comes later the whole screen at once', async () => {
    const first = watch();
    await first.opened;
    await first.until('auth refactor');
    const second = watch();
    await second.opened;
    expect(second.events[0]).toMatchObject({ kind: 'frame', full: true, height: 30 });
    expect(second.plain().join('\n')).toContain('auth refactor');
    first.close();
    second.close();
  });

  it('takes the page size: the frame is drawn anew to it', async () => {
    const page = watch();
    await page.opened;
    await page.until('auth refactor');
    expect((await post('/api/app/resize', { width: 72, height: 20 })).status).toBe(200);
    const end = Date.now() + 3_000;
    while (page.plain().length !== 20 && Date.now() < end) await new Promise((done) => setTimeout(done, 15));
    expect(page.plain()).toHaveLength(20);
    const last = page.events.at(-1);
    expect(last).toMatchObject({ kind: 'frame', width: 72, height: 20 });
    page.close();
  });

  it('clicks by cell: a tab opens, a double click on a pane goes in', async () => {
    const page = watch();
    await page.opened;
    const text = await page.until('auth refactor');
    const header = text.split('\n')[0]!;
    expect((await post('/api/app/mouse', { action: 'click', x: header.indexOf('Wall'), y: 0 })).status).toBe(200);
    await page.until('[2 Wall]');
    expect((await post('/api/app/input', { data: '1' })).status).toBe(200);
    const overview = (await page.until('[1 Overview]')).split('\n');
    const row = overview.findIndex((line) => line.includes('auth refactor'));
    await post('/api/app/mouse', { action: 'double', x: 10, y: row });
    await page.until('Ctrl+Q — back to Brainyard');
    expect(web.pane()).toBe('claude-1a2b3c4d');
    page.close();
  });

  it('shows a pane full screen with typing into its CLI, the way back on Ctrl+Q', async () => {
    const page = watch();
    await page.opened;
    await page.until('auth refactor');
    // The first pane is selected: Enter goes in.
    await post('/api/app/input', { data: '\r' });
    const screen = await page.until('claude-1a2b3c4d ready');
    expect(screen).toContain('◂ Brainyard');
    expect(screen).toContain('Ctrl+Q — back to Brainyard');
    // The pane takes the page, but for the bar below it.
    expect(resized).toContainEqual({ pane: 'claude-1a2b3c4d', width: 100, height: 29 });
    // Every key goes to the CLI: Ctrl+C and Esc too.
    await post('/api/app/input', { data: 'hi' });
    await post('/api/app/input', { data: '\u0003\u001b' });
    await page.until('> hi');
    expect(sent.map((entry) => entry.data).join('')).toBe('hi\u0003\u001b');
    expect(sent.every((entry) => entry.pane === 'claude-1a2b3c4d')).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    // A paste arrives as one paste.
    await post('/api/app/input', { data: 'one\ntwo', paste: true });
    await web.idle();
    expect(sent.at(-1)?.data).toBe('\u001b[200~one\rtwo\u001b[201~');
    // The wheel goes back through what the CLI printed before.
    await post('/api/app/mouse', { action: 'wheel-up', x: 5, y: 5 });
    await page.until('history of claude-1a2b3c4d, 3 rows up');
    await page.until('↑ 3 rows back');
    await post('/api/app/mouse', { action: 'wheel-down', x: 5, y: 5 });
    await page.until('claude-1a2b3c4d ready');
    // What comes before Ctrl+Q still reaches the CLI; then the app is back.
    await post('/api/app/input', { data: 'ok\u0011' });
    await page.until('[1 Overview]');
    expect(web.pane()).toBeUndefined();
    expect(sent.at(-1)?.data).toBe('ok');
    page.close();
  });

  it('leaves the pane when its CLI ends, or by a click on the bar', async () => {
    const page = watch();
    await page.opened;
    await page.until('auth refactor');
    await post('/api/app/input', { data: '\r' });
    await page.until('claude-1a2b3c4d ready');
    await post('/api/app/mouse', { action: 'click', x: 3, y: 29 });
    await page.until('[1 Overview]');
    await post('/api/app/input', { data: '\r' });
    await page.until('claude-1a2b3c4d ready');
    gone.add('claude-1a2b3c4d');
    await page.until('[1 Overview]');
    expect(web.pane()).toBeUndefined();
    page.close();
  });

  it('q quits: the page is told, and the server that shows the app goes too', async () => {
    const page = watch();
    await page.opened;
    await page.until('auth refactor');
    await post('/api/app/input', { data: 'q' });
    const end = Date.now() + 3_000;
    while (!page.events.some((event) => event.kind === 'quit') && Date.now() < end) {
      await new Promise((done) => setTimeout(done, 15));
    }
    expect(page.events.some((event) => event.kind === 'quit')).toBe(true);
    expect(quit).toHaveBeenCalledTimes(1);
    page.close();
  });
});
