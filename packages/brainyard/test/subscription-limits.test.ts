import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type UsageOptions, usage } from '../src/index.js';
import { agyGeneration, agyStore, opencodeMessage, opencodeStore } from './fixtures/usage-store.js';
import { FAKE, recording, tempDir } from './helpers.js';

const goReport = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-quota.json', import.meta.url), 'utf8'));
const agyReport = (buckets: unknown[]) =>
  JSON.stringify({
    status: 'SUCCESS',
    num_turns: 0,
    command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets }] } },
  });

afterEach(() => vi.unstubAllGlobals());

function agyOptions(): UsageOptions {
  return { cwd: realpathSync(tempDir()), brains: ['agy'], homes: { antigravity: tempDir() }, commands: FAKE, limit: 0 };
}

function goOptions(): UsageOptions {
  return { cwd: realpathSync(tempDir()), brains: ['opencode'], homes: { opencode: tempDir() }, limit: 0 };
}

function mockGo(body: unknown = goReport, status = 200) {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', request);
  return request;
}

describe('Antigravity subscription quotas', () => {
  it('reads grouped weekly and five-hour windows with a metadata command, without a model turn', async () => {
    const options = agyOptions();
    const record = recording();
    const report = await usage({
      ...options,
      env: { FAKE_RECORD: record.path, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent' },
    });
    const brain = report.brains[0]!;
    expect(brain).toMatchObject({ brain: 'antigravity', limitsSource: 'cli', limitsUnavailable: null });
    expect(brain.limits).toHaveLength(4);
    expect(brain.limits?.[0]).toMatchObject({
      limitId: 'gemini-weekly',
      group: 'Gemini Models',
      label: 'Weekly Limit Remaining',
      window: 'weekly',
      windowMinutes: 10080,
      resetsAt: 1791478759,
    });
    expect(brain.limits?.[0]?.utilization).toBeCloseTo(1 - 0.9924077391624451);
    expect(brain.limits?.[1]).toMatchObject({ utilization: 0, windowMinutes: 300 });
    expect(brain.limits?.[2]?.group).toBe('Claude and GPT models');
    expect(Number.isFinite(Date.parse(brain.limitsObservedAt!))).toBe(true);
    const call = record.read();
    expect(call.argv).toEqual(['-p', '/usage', '--output-format', 'json']);
    expect(call.stdin).toEqual([]);
    expect(call.cwd).not.toBe(options.cwd);
    expect(existsSync(call.cwd)).toBe(false);
    expect(call.env.CLAUDE_CODE_SESSION_ID).toBeNull();
  });

  it('keeps exhausted weekly-only buckets, skips disabled or unknown fractions and accepts field aliases', async () => {
    const report = await usage({
      ...agyOptions(),
      env: {
        FAKE_QUOTA_REPORT: agyReport([
          {
            bucketId: 'weekly',
            displayName: 'Weekly remaining',
            window: 'weekly',
            remainingFraction: 0,
            resetTime: '2026-10-11T00:00:00Z',
          },
          { id: 'unknown', window: '5h' },
          { id: 'disabled', remaining_fraction: 1, disabled: true },
          { id: 'negative', remaining_fraction: -0.1 },
          { id: 'too-large', remaining_fraction: 2 },
        ]),
      },
    });
    expect(report.brains[0]?.limits).toEqual([
      {
        window: 'weekly',
        utilization: 1,
        limitId: 'weekly',
        group: 'Gemini Models',
        label: 'Weekly remaining',
        windowMinutes: 10080,
        resetsAt: 1791676800,
      },
    ]);
  });

  it('returns a reason when no quota is measured instead of inventing unused allowances', async () => {
    const report = await usage({
      ...agyOptions(),
      env: { FAKE_QUOTA_REPORT: agyReport([{ id: 'unknown', window: 'weekly' }]) },
    });
    expect(report.brains[0]).toMatchObject({ limits: null, limitsUnavailable: 'missing' });
  });

  it.each(['1.1.10', '0.99.99', 'unknown'])('never sends /usage as a model prompt to version %s', async (version) => {
    const record = recording();
    const report = await usage({ ...agyOptions(), env: { FAKE_RECORD: record.path, FAKE_AGY_VERSION: version } });
    expect(report.brains[0]).toMatchObject({ limits: null, limitsUnavailable: 'unsupported' });
    expect(record.read().argv).toEqual(['--version']);
    expect(existsSync(record.read().cwd)).toBe(false);
  });

  it.each([
    'not JSON',
    '{"status":"ERROR","command":{"name":"usage"}}',
    '{"status":"SUCCESS","command":{"name":"other"}}',
  ])('rejects an unsuccessful or malformed quota report', async (body) => {
    const report = await usage({ ...agyOptions(), env: { FAKE_QUOTA_REPORT: body } });
    expect(report.brains[0]).toMatchObject({ limits: null, limitsUnavailable: 'failed', error: { kind: 'failed' } });
  });

  it('keeps saved tokens when the quota command cannot sign in', async () => {
    const options = agyOptions();
    agyStore(options.homes!.antigravity!, options.cwd!, 'saved', [agyGeneration('model')]);
    const report = await usage({ ...options, limit: 1, env: { FAKE_SCENARIO: 'quota-auth' } });
    expect(report.brains[0]).toMatchObject({ limits: null, error: { kind: 'not_logged_in' } });
    expect(report.sessions[0]?.usage?.inputTokens).toBe(60);
  });

  it('bounds a stalled quota command and removes its private directory', async () => {
    const record = recording();
    const report = await usage({
      ...agyOptions(),
      timeoutMs: 200,
      env: { FAKE_RECORD: record.path, FAKE_SCENARIO: 'quota-delay' },
    });
    expect(report.brains[0]?.error?.kind).toBe('timeout');
    expect(existsSync(record.read().cwd)).toBe(false);
  });

  it('honors cancellation during a CLI quota check', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      const report = await usage({ ...agyOptions(), signal: controller.signal, env: { FAKE_SCENARIO: 'quota-delay' } });
      expect(report.brains[0]?.error?.kind).toBe('stopped');
    } finally {
      clearTimeout(timer);
    }
  });

  it('does not spawn a CLI after cancellation or when the executable is absent', async () => {
    const record = recording();
    const report = await usage({ ...agyOptions(), signal: AbortSignal.abort(), env: { FAKE_RECORD: record.path } });
    expect(report.brains[0]?.error?.kind).toBe('stopped');
    expect(existsSync(record.path)).toBe(false);
    const missing = await usage({ ...agyOptions(), commands: { antigravity: '/nonexistent/brainyard-agy' } });
    expect(missing.brains[0]?.error?.kind).toBe('not_installed');
  });
});

describe('OpenCode Go subscription quotas', () => {
  it('uses the Go key in auth.json and preserves all three windows, including zero and exhausted usage', async () => {
    const options = goOptions();
    writeFileSync(
      join(options.homes!.opencode!, 'auth.json'),
      JSON.stringify({
        'opencode-go': { type: 'api', key: 'go-test-key' },
        opencode: { type: 'api', key: 'zen-test-key' },
      }),
    );
    const request = mockGo();
    const report = await usage(options);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/usage',
      expect.objectContaining({
        headers: { authorization: 'Bearer go-test-key', accept: 'application/json' },
        redirect: 'error',
      }),
    );
    expect(report.brains[0]).toMatchObject({ limitsSource: 'api', limitsUnavailable: null });
    expect(report.brains[0]?.limits).toEqual([
      { window: 'rolling', utilization: 0, limitId: 'opencode-go', resetsAt: 1791144000 },
      { window: 'weekly', utilization: 0.35, limitId: 'opencode-go', resetsAt: 1791712800 },
      { window: 'monthly', utilization: 1, limitId: 'opencode-go', resetsAt: 1793491200 },
    ]);
    expect(JSON.stringify(report)).not.toContain('go-test-key');
  });

  it('accepts the OpenCode Zen key and falls back to its store when inline auth is malformed', async () => {
    const options = goOptions();
    writeFileSync(
      join(options.homes!.opencode!, 'auth.json'),
      JSON.stringify({ opencode: { type: 'api', key: 'zen-go-key' } }),
    );
    const request = mockGo();
    await usage({ ...options, env: { OPENCODE_AUTH_CONTENT: 'broken JSON' } });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer zen-go-key' });
  });

  it('uses environment credentials ahead of stored keys', async () => {
    const request = mockGo();
    await usage({
      ...goOptions(),
      env: {
        OPENCODE_API_KEY: 'env-test-key',
        OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"inline-test-key"}}',
      },
    });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer env-test-key' });
  });

  it('reads a configured Go key through an environment reference in JSONC', async () => {
    const request = mockGo();
    const options = goOptions();
    writeFileSync(
      join(options.cwd!, 'opencode.jsonc'),
      '{/* quota key */ "provider":{"opencode-go":{"options":{"apiKey":"{env:TEST_GO_KEY}"}}}}',
    );
    await usage({ ...options, env: { TEST_GO_KEY: 'configured-test-key' } });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer configured-test-key' });
  });

  it('does not send OAuth tokens or third-party provider keys to OpenCode', async () => {
    const request = mockGo();
    const report = await usage({
      ...goOptions(),
      env: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          anthropic: { type: 'api', key: 'third-party-key' },
          'opencode-go': { type: 'oauth', access: 'oauth-token' },
        }),
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(report.brains[0]).toMatchObject({ limits: null, limitsUnavailable: 'missing' });
    expect(report.brains[0]?.detail).toContain('OpenCode Go');
  });

  it.each([
    [401, 'not_logged_in', 'failed'],
    [403, undefined, 'missing'],
    [429, 'rate_limited', 'failed'],
    [500, 'network', 'failed'],
  ] as const)('distinguishes HTTP %s without including server diagnostics or the key', async (status, kind, reason) => {
    mockGo({ error: { message: 'secret-test-key' } }, status);
    const report = await usage({ ...goOptions(), env: { OPENCODE_API_KEY: 'secret-test-key' } });
    expect(report.brains[0]).toMatchObject({ limits: null, limitsUnavailable: reason });
    expect(report.brains[0]?.error?.kind).toBe(kind);
    expect(JSON.stringify(report)).not.toContain('secret-test-key');
  });

  it('retains saved session counters on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network failed with secret-test-key')));
    const options = goOptions();
    opencodeStore(options.homes!.opencode!, options.cwd!, [opencodeMessage('a', 0.01)]);
    const report = await usage({ ...options, limit: 1, env: { OPENCODE_API_KEY: 'secret-test-key' } });
    expect(report.brains[0]?.error?.kind).toBe('network');
    expect(report.sessions[0]).toMatchObject({ costUsd: 0.01, usage: { inputTokens: 100 } });
    expect(JSON.stringify(report)).not.toContain('secret-test-key');
  });

  it('rejects a non-JSON response and leaves unmeasured windows unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')));
    const options = { ...goOptions(), env: { OPENCODE_API_KEY: 'test-key' } };
    expect((await usage(options)).brains[0]?.error?.kind).toBe('failed');
    mockGo({ usage: { rolling: { percent: -1 }, weekly: {}, monthly: { percent: 105 } } });
    expect((await usage(options)).brains[0]?.limits).toEqual([
      { window: 'monthly', utilization: 1.05, limitId: 'opencode-go' },
    ]);
    mockGo({ usage: {} });
    expect((await usage(options)).brains[0]).toMatchObject({ limits: null, limitsUnavailable: 'missing' });
  });

  it('honors request timeout and cancellation', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', request);
    const options = { ...goOptions(), env: { OPENCODE_API_KEY: 'test-key' } };
    expect((await usage({ ...options, timeoutMs: 20 })).brains[0]?.error?.kind).toBe('timeout');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      expect((await usage({ ...options, signal: controller.signal })).brains[0]?.error?.kind).toBe('stopped');
      request.mockClear();
      expect((await usage({ ...options, signal: AbortSignal.abort() })).brains[0]?.error?.kind).toBe('stopped');
      expect(request).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
    }
  });
});

describe('quota request controls', () => {
  it('skips AGY and Go requests in offline mode even when credentials and commands are available', async () => {
    const record = recording();
    const request = mockGo();
    const report = await usage({
      brains: ['agy', 'opencode'],
      homes: { antigravity: tempDir(), opencode: tempDir() },
      commands: FAKE,
      limit: 0,
      offline: true,
      env: { FAKE_RECORD: record.path, OPENCODE_API_KEY: 'test-key' },
    });
    expect(report.brains.every((brain) => brain.limitsUnavailable === 'not_requested')).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(existsSync(record.path)).toBe(false);
  });

  it('rejects incompatible modes and invalid timeouts before any quota call', async () => {
    await expect(usage({ offline: true, live: true })).rejects.toMatchObject({ kind: 'invalid_option' });
    for (const timeoutMs of [0, -1, 0.5, Number.NaN, 2_147_483_648])
      await expect(usage({ timeoutMs })).rejects.toMatchObject({ kind: 'invalid_option' });
  });
});
