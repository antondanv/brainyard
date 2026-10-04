import { createHash } from 'node:crypto';
import { request } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE } from '../../brainyard/test/helpers.js';
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
    expect(run).toMatchObject({ brain: 'claude', state: 'running', steerable: true });
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
