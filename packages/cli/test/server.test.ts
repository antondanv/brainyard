import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { panesAvailable } from '@antondanv/brainyard';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeMessage, claudeStore } from '../../brainyard/test/fixtures/usage-store.js';
import { FAKE, recording, tempDir } from '../../brainyard/test/helpers.js';
import { type Dashboard, serve } from '../src/ui/server.js';

const TOKEN = 'test-token-123';
let server: Dashboard;

beforeEach(async () => {
  vi.stubEnv('BRAINYARD_CLAUDE_BIN', JSON.stringify(FAKE.claude));
  vi.stubEnv('BRAINYARD_CODEX_BIN', JSON.stringify(FAKE.codex));
  vi.stubEnv('BRAINYARD_AGY_BIN', JSON.stringify(FAKE.antigravity));
  vi.stubEnv('BRAINYARD_OPENCODE_BIN', JSON.stringify(FAKE.opencode));
  server = await serve({ port: 0, token: TOKEN });
});

afterEach(async () => {
  await server.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<Reply>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method: options.method ?? 'GET',
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
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

describe('dashboard server', () => {
  it('prints a URL that carries the token in the fragment, not the query', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/#token=${TOKEN}`);
    expect(server.local).toBe(true);
  });

  it('serves the page with a policy that lets only its own script run', async () => {
    const page = await call('/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Brainyard</title>');
    const policy = String(page.headers['content-security-policy']);
    expect(policy).toContain("default-src 'none'");
    const script = /<script>([\s\S]*?)<\/script>/.exec(page.body)?.[1] ?? '';
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(policy).toContain(`script-src 'sha256-${hash}'`);
    expect(policy).not.toContain("script-src 'unsafe-inline'");
  });

  it('answers bad input with 400, not 500', async () => {
    const broken = await call('/api/ask', { method: 'POST', headers: json, body: '{not json' });
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body).error.message).toMatch(/not valid JSON/);
    expect((await call('/api/models/gpt-cli', { headers: auth })).status).toBe(400);
  });

  it('refuses the API without the token', async () => {
    expect((await call('/api/status')).status).toBe(401);
    expect((await call('/api/status', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const reply = await call('/api/status', { headers: { ...auth, host: 'evil.example' } });
    expect(reply.status).toBe(421);
  });

  it('refuses cross-origin and non-JSON writes', async () => {
    const cross = await call('/api/runs', {
      method: 'POST',
      headers: { ...json, origin: 'http://evil.example' },
      body: '{}',
    });
    expect(cross.status).toBe(403);
    const form = await call('/api/runs', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'brain=claude',
    });
    expect(form.status).toBe(415);
  });

  it('reports status with models and tidy paths', async () => {
    const reply = await call('/api/status', { headers: auth });
    expect(reply.status).toBe(200);
    const report = JSON.parse(reply.body);
    expect(report.brains.map((b: { id: string }) => b.id)).toEqual(['claude', 'codex', 'antigravity', 'opencode']);
    expect(report.brains[1].models.models.length).toBeGreaterThan(0);
  });

  it('answers a one-shot question', async () => {
    vi.stubEnv('FAKE_SCENARIO', 'ok');
    const reply = await call('/api/ask', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ brain: 'codex', prompt: 'hi' }),
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).text).toBe('Answer to: hi');
  });

  it('runs an agent and streams its events, then the result', async () => {
    vi.stubEnv('FAKE_SCENARIO', 'ok');
    const created = await call('/api/runs', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ brain: 'claude', prompt: 'make a file' }),
    });
    expect(created.status).toBe(201);
    const run = JSON.parse(created.body);
    expect(run).toMatchObject({ brain: 'claude', steerable: true });
    // A fast fake can finish within the moment the server waits for a refusal.
    expect(['running', 'done']).toContain(run.state);
    expect(run.cwd).toMatch(/brainyard-playground-/);

    const stream = await call(`/api/runs/${run.id}/events`, { headers: auth });
    expect(stream.headers['content-type']).toContain('text/event-stream');
    const frames = stream.body
      .split('\n\n')
      .filter((frame) => frame.startsWith('event: '))
      .map((frame) => {
        const [head, data] = frame.split('\n');
        return { name: head?.slice(7), data: JSON.parse(data?.slice(6) ?? 'null') };
      });
    expect(frames[0]).toMatchObject({ name: 'agent', data: { kind: 'init' } });
    expect(frames.at(-1)).toMatchObject({ name: 'result', data: { ok: true, text: 'DONE' } });
    expect(frames.at(-1)?.data.events).toBeUndefined();

    const listed = JSON.parse((await call('/api/runs', { headers: auth })).body);
    expect(listed[0]).toMatchObject({ id: run.id, state: 'done', sessionId: 'claude-session-1' });
  });

  it('refuses a bad run right away instead of opening a dead stream', async () => {
    const reply = await call('/api/runs', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ brain: 'claude', prompt: '' }),
    });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).error.kind).toBe('invalid_option');
  });

  it('stops a run', async () => {
    vi.stubEnv('FAKE_SCENARIO', 'hang');
    const run = JSON.parse(
      (
        await call('/api/runs', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ brain: 'claude', prompt: 'x' }),
        })
      ).body,
    );
    const stopped = await call(`/api/runs/${run.id}/stop`, { method: 'POST', headers: json, body: '{}' });
    expect(stopped.status).toBe(200);
    const stream = await call(`/api/runs/${run.id}/events`, { headers: auth });
    expect(stream.body).toContain('"stopped":true');
  });
});

const get = (path: string) => call(path, { headers: auth });
const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: json, body: JSON.stringify(body) });
const project = () => realpathSync(tempDir('brainyard-project-'));

/** A machine of the test's own: CLI stores in empty folders, and `claude agents` reporting `agents`. */
function machine(agents: unknown[] = []): string {
  const home = tempDir('brainyard-home-');
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, '.claude'));
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
  vi.stubEnv('FAKE_AGENTS', JSON.stringify(agents));
  return join(home, '.claude');
}

async function until(read: () => Promise<string>, wanted: string | RegExp, ms = 8_000): Promise<string> {
  const end = Date.now() + ms;
  const ok = (text: string) => (typeof wanted === 'string' ? text.includes(wanted) : wanted.test(text));
  let text = await read();
  while (!ok(text) && Date.now() < end) {
    await sleep(50);
    text = await read();
  }
  expect(text).toMatch(wanted);
  return text;
}

describe('sessions and usage over HTTP', () => {
  it('lists the saved sessions of a folder and what runs now', async () => {
    const cwd = project();
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    const claude = machine([{ id: 'aaaaaaaa', sessionId: id, kind: 'interactive', status: 'busy', cwd }]);
    claudeStore(claude, cwd, id, [claudeMessage('msg_1', 'claude-test')]);

    const saved = await get(`/api/sessions?cwd=${encodeURIComponent(cwd)}&brain=claude`);
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toEqual([
      expect.objectContaining({ id, title: 'Count this session', live: expect.objectContaining({ status: 'busy' }) }),
    ]);
    const live = JSON.parse((await get('/api/sessions/live?brain=claude')).body);
    expect(live.map((session: { id: string }) => session.id)).toEqual([id]);
    const elsewhere = await get(`/api/sessions/live?brain=claude&cwd=${encodeURIComponent(project())}`);
    expect(JSON.parse(elsewhere.body)).toEqual([]);
    expect((await get('/api/sessions?brain=gpt')).status).toBe(400);
    expect((await get('/api/sessions?limit=0')).status).toBe(400);
  });

  it('stops a background session in its own folder', async () => {
    const cwd = project();
    const id = '5e6f7a8b-0000-4000-8000-000000000001';
    machine([{ id: '5e6f7a8b', sessionId: id, kind: 'background', status: 'busy', state: 'working', cwd }]);
    const calls = recording();
    vi.stubEnv('FAKE_RECORD', calls.path);

    const stopped = await post(`/api/sessions/${id}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(JSON.parse(stopped.body)).toEqual({ result: 'stopped' });
    expect(calls.read()).toMatchObject({ argv: ['stop', '5e6f7a8b'], cwd });
    expect(JSON.parse((await post('/api/sessions/ffffffff-0000/stop', {})).body)).toEqual({ result: 'not-running' });
    expect((await post(`/api/sessions/${id}/stop`, { brain: 'codex', cwd })).status).toBe(400);
    expect((await post('/api/sessions/bad%20id/stop', {})).status).toBe(400);
  });

  it('reports the usage of saved sessions, priced when asked', async () => {
    const cwd = project();
    const claude = machine();
    claudeStore(claude, cwd, 'aaaaaaaa-0000-4000-8000-000000000001', [claudeMessage('msg_1', 'claude-test', 10, 5)]);
    const prices = { 'claude-test': { input: 3, output: 15 } };

    const reply = await post('/api/usage', { cwd, brains: ['claude'], offline: true, prices });
    expect(reply.status).toBe(200);
    const report = JSON.parse(reply.body);
    expect(report.sessions).toEqual([
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
        costSource: 'estimate',
      }),
    ]);
    expect(report.brains).toEqual([expect.objectContaining({ brain: 'claude', limitsUnavailable: 'missing' })]);
    expect((await post('/api/usage', { offline: true, live: true })).status).toBe(400);
    expect((await post('/api/usage', { prices: { x: { input: 'free' } } })).status).toBe(400);
    expect((await post('/api/usage', { brains: 'claude' })).status).toBe(400);
  });
});

describe.skipIf(!panesAvailable())('panes over HTTP (real tmux)', () => {
  const socket = `brainyard-test-${process.pid}-server`;
  beforeEach(() => {
    vi.stubEnv('BRAINYARD_TMUX_SOCKET', socket);
    vi.stubEnv('FAKE_PANE', '1');
  });
  afterAll(() => {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  });

  it('starts a pane, lists it, shows its screen, types into it, resizes and closes it', async () => {
    const cwd = tempDir();
    const created = await post('/api/panes', { brain: 'claude', cwd, prompt: 'hello', width: 70, height: 12 });
    expect(created.status).toBe(201);
    const { pane, sessionId } = JSON.parse(created.body);
    expect(pane).toMatch(/^claude-[0-9a-f]{8}$/);

    const listed = JSON.parse((await get('/api/panes')).body).filter((info: { pane: string }) => info.pane === pane);
    expect(listed).toEqual([expect.objectContaining({ pane, sessionId, cwd, brain: 'claude', width: 70 })]);
    const screen = async () => (JSON.parse((await get(`/api/panes/${pane}/screen`)).body).lines ?? []).join('\n');
    await until(screen, 'fake-claude ready');

    expect((await post(`/api/panes/${pane}/send`, { data: 'привет', enter: true })).status).toBe(200);
    await until(screen, /got:привет\ngot:\^M/);
    expect(JSON.parse((await post(`/api/panes/${pane}/resize`, { width: 50, height: 8 })).body)).toEqual({
      resized: true,
    });
    expect(JSON.parse((await get(`/api/panes/${pane}/screen`)).body)).toMatchObject({ width: 50, height: 8 });

    expect(JSON.parse((await post(`/api/panes/${pane}/close`, {})).body)).toEqual({ closed: true });
    expect((await get(`/api/panes/${pane}/screen`)).status).toBe(404);
    expect((await post(`/api/panes/${pane}/close`, {})).status).toBe(404);
    expect((await post(`/api/panes/${pane}/send`, { data: 'x' })).status).toBe(404);
  });

  it('refuses a pane without a folder, a pane by a bad name and a send of nothing', async () => {
    expect((await post('/api/panes', { brain: 'claude' })).status).toBe(400);
    expect((await post('/api/panes', { brain: 'gpt', cwd: tempDir() })).status).toBe(400);
    expect((await get('/api/panes/claude%3Bx/screen')).status).toBe(400);
    const { pane } = JSON.parse((await post('/api/panes', { brain: 'claude', cwd: tempDir() })).body);
    expect((await post(`/api/panes/${pane}/send`, {})).status).toBe(400);
    expect((await post(`/api/panes/${pane}/close`, {})).status).toBe(200);
  });
});
