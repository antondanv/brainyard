import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { usage } from '../src/index.js';
import {
  agyGeneration,
  agyStore,
  claudeMessage,
  claudeStore,
  codexLimits,
  codexStore,
  codexTokens,
  opencodeMessage,
  opencodeStore,
} from './fixtures/usage-store.js';
import { FAKE, recording, tempDir } from './helpers.js';

const prices = { a: { input: 2, output: 10 }, b: { input: 4, output: 20 } };
const folder = () => realpathSync(tempDir());

describe('saved usage', () => {
  it('exports usage and distinguishes unavailable data for every CLI', async () => {
    const home = tempDir();
    const report = await usage({
      cwd: folder(),
      homes: { claude: home, codex: home, antigravity: home, opencode: home },
    });
    expect(report.brains.map((brain) => brain.brain)).toEqual(['claude', 'codex', 'antigravity', 'opencode']);
    expect(report.brains.every((brain) => brain.limits === null)).toBe(true);
    expect(report.sessions).toEqual([]);
    expect(report.brains[0]?.limitsUnavailable).toBe('not_requested');
    expect(report.brains[1]?.limitsUnavailable).toBe('missing');
    expect(report.brains[2]?.detail).toContain('/usage');
  });

  it('counts Claude messages by id, keeping the latest counters and prices each model', async () => {
    const cwd = folder(),
      home = tempDir();
    claudeStore(home, cwd, 'claude-1', [
      claudeMessage('m1', 'a', 1, 1),
      claudeMessage('m2', 'b'),
      claudeMessage('m1', 'a'),
    ]);
    const report = await usage({ cwd, brains: ['claude'], homes: { claude: home }, prices });
    const session = report.sessions[0]!;
    expect(session.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 40,
      reasoningTokens: 4,
    });
    expect(session.byModel.map((row) => row.model).sort()).toEqual(['a', 'b']);
    expect(session.costSource).toBe('estimate');
    expect(session.costUsd).toBeCloseTo(
      (10 * 2 + 5 * 10 + 100 * 0.2 + 20 * 2.5 + 10 * 4 + 5 * 20 + 100 * 0.4 + 20 * 5) / 1e6,
      8,
    );
  });

  it('reads counters in the middle of long transcripts and skips broken or unfinished records', async () => {
    const cwd = folder(),
      home = tempDir();
    const path = claudeStore(home, cwd, 'long', [
      { type: 'noise', text: 'x'.repeat(300_000) },
      claudeMessage('m', 'a'),
      { type: 'noise', text: 'x'.repeat(300_000) },
    ]);
    appendFileSync(path, `not JSON\n${JSON.stringify(claudeMessage('bad', 'a')).slice(0, -3)}`);
    const options = { cwd, brains: ['claude'], homes: { claude: home }, prices };
    expect((await usage(options)).sessions[0]?.usage?.inputTokens).toBe(10);
    appendFileSync(path, `${JSON.stringify(claudeMessage('bad', 'a')).slice(-3)}\n`);
    expect((await usage(options)).sessions[0]?.usage?.inputTokens).toBe(20);
  });

  it('leaves unknown prices and absent counters unknown, even when some models are priced', async () => {
    const cwd = folder(),
      home = tempDir();
    claudeStore(home, cwd, 'unknown-model', [claudeMessage('a', 'a'), claudeMessage('u', 'unknown')]);
    claudeStore(home, cwd, 'empty', []);
    const report = await usage({ cwd, brains: ['claude'], homes: { claude: home }, prices });
    expect(report.sessions.find((s) => s.id === 'unknown-model')).toMatchObject({ costUsd: null, costSource: null });
    expect(report.sessions.find((s) => s.id === 'empty')).toMatchObject({ usage: null, costUsd: null });
  });

  it('uses the final Codex total and assigns increments to their turn models', async () => {
    const cwd = folder(),
      home = tempDir();
    codexStore(home, cwd, 'codex-1', [
      { type: 'turn_context', payload: { model: 'a' } },
      codexTokens(),
      codexTokens(),
      { type: 'turn_context', payload: { model: 'b' } },
      codexTokens(200, 40, 80),
      codexLimits('2026-10-04T11:00:00Z', 12),
    ]);
    const report = await usage({ cwd, brains: ['codex'], homes: { codex: home }, prices });
    const session = report.sessions[0]!;
    expect(session.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
    });
    expect(session.byModel).toHaveLength(2);
    expect(session.byModel.find((row) => row.model === 'b')?.usage).toMatchObject({
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 20,
      reasoningTokens: 0,
    });
    expect(session.costUsd).toBeCloseTo(
      (60 * 2 + 20 * 10 + 40 * 0.2 + 10 * 2.5 + 60 * 4 + 20 * 20 + 40 * 0.4) / 1e6,
      8,
    );
  });

  it('reads the freshest Codex subscription snapshot outside the requested folder and session limit', async () => {
    const cwd = folder(),
      home = tempDir();
    codexStore(home, cwd, 'older', [codexLimits('2026-10-04T10:00:00Z', 10)]);
    codexStore(home, folder(), 'elsewhere', [
      codexLimits('2026-10-04T12:00:00Z', 95),
      { type: 'response_item', payload: { text: 'x'.repeat(400_000) } },
    ]);
    const report = await usage({ cwd, brains: ['codex'], homes: { codex: home }, limit: 1 });
    expect(report.sessions.map((s) => s.id)).toEqual(['older']);
    expect(report.brains[0]).toMatchObject({ limitsSource: 'rollout', limitsObservedAt: '2026-10-04T12:00:00.000Z' });
    expect(report.brains[0]?.limits).toEqual([
      { window: 'primary', utilization: 0.95, windowMinutes: 300, resetsAt: 1791115200, limitId: 'codex' },
      { window: 'secondary', utilization: 0.25, windowMinutes: 10080, resetsAt: 1791720000, limitId: 'codex' },
    ]);
  });

  it('keeps distinct Codex limit buckets and ignores invalid counters and a partial final event', async () => {
    const cwd = folder(),
      home = tempDir();
    const path = codexStore(home, cwd, 'buckets', [
      { type: 'turn_context', payload: { model: 'a' } },
      codexTokens(),
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: -1 } } } },
      codexLimits('2026-10-04T10:00:00Z', 12),
      codexLimits('2026-10-04T12:00:00Z', 45, 'model-specific'),
    ]);
    appendFileSync(path, JSON.stringify(codexLimits('2026-10-04T13:00:00Z', 90)));
    const report = await usage({ cwd, brains: ['codex'], homes: { codex: home } });
    expect(report.sessions[0]?.usage?.inputTokens).toBe(60);
    expect(report.brains[0]?.limits).toHaveLength(4);
    expect(report.brains[0]?.limits?.find((w) => w.limitId === 'codex')?.utilization).toBe(0.12);
  });

  it('reads Antigravity generation metadata, including model changes, cache and reasoning', async () => {
    const cwd = folder(),
      home = tempDir();
    agyStore(home, cwd, 'agy-1', [agyGeneration('a'), Buffer.from([10, 100, 1]), agyGeneration('b')]);
    const report = await usage({ cwd, brains: ['agy'], homes: { antigravity: home }, prices });
    expect(report.sessions[0]).toMatchObject({
      id: 'agy-1',
      source: 'conversation_db',
      costSource: 'estimate',
      usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 80, cacheWriteTokens: 20, reasoningTokens: 10 },
    });
    expect(report.sessions[0]?.byModel).toHaveLength(2);
    expect(report.brains[0]?.limits).toBeNull();
  });

  it('explains why an old Antigravity session has no persisted counters', async () => {
    const cwd = folder(),
      home = tempDir();
    agyStore(home, cwd, 'old', []);
    const report = await usage({ cwd, brains: ['antigravity'], homes: { antigravity: home } });
    expect(report.sessions[0]).toMatchObject({ usage: null, costUsd: null });
    expect(report.sessions[0]?.unavailableReason).toContain('generator metadata');
  });

  it('sums OpenCode assistant messages once, using reported costs and separate reasoning', async () => {
    const cwd = folder(),
      home = tempDir();
    opencodeStore(home, cwd, [
      opencodeMessage('a', 0.01),
      { role: 'user', tokens: { input: 99999 } },
      opencodeMessage('b', 0.02),
    ]);
    const report = await usage({ cwd, brains: ['opencode'], homes: { opencode: home } });
    expect(report.sessions[0]).toMatchObject({
      id: 'ses_test',
      costUsd: 0.03,
      costSource: 'cli',
      source: 'opencode_db',
      usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 80, cacheWriteTokens: 20, reasoningTokens: 10 },
    });
    expect(report.sessions[0]?.byModel.map((row) => row.model)).toEqual(['provider/a', 'provider/b']);
  });

  it('estimates OpenCode providers with missing prices and never treats their reported zero as a free call', async () => {
    const cwd = folder(),
      home = tempDir();
    opencodeStore(home, cwd, [opencodeMessage()]);
    const options = { cwd, brains: ['opencode'], homes: { opencode: home } };
    expect((await usage(options)).sessions[0]?.costUsd).toBeNull();
    expect((await usage({ ...options, prices: { 'provider/model-a': prices.a } })).sessions[0]).toMatchObject({
      costSource: 'estimate',
    });
  });

  it('filters headless sessions, subagents, session ids and archived OpenCode sessions', async () => {
    const cwd = folder(),
      home = tempDir();
    const path = opencodeStore(home, cwd, [opencodeMessage()]);
    const db = new DatabaseSync(path);
    db.exec(
      `INSERT INTO session SELECT 'child', directory, 'ses_test', NULL, 'child', time_created, time_updated, NULL, 0 FROM session WHERE id='ses_test'`,
    );
    db.prepare('UPDATE session SET permission=? WHERE id=?').run(
      JSON.stringify([{ permission: 'plan_exit', action: 'deny' }]),
      'ses_test',
    );
    db.close();
    const options = { cwd, brains: ['opencode'], homes: { opencode: home } };
    expect((await usage(options)).sessions).toEqual([]);
    expect((await usage({ ...options, headless: true, sessionId: 'ses_test' })).sessions).toHaveLength(1);
    expect((await usage({ ...options, headless: true, sessionId: 'other' })).sessions).toEqual([]);
  });

  it('reports missing or incompatible SQLite stores without creating them', async () => {
    const cwd = folder(),
      home = tempDir();
    mkdirSync(join(home, 'conversations'));
    writeFileSync(join(home, 'opencode.db'), 'not a database');
    expect((await usage({ cwd, brains: ['opencode'], homes: { opencode: home } })).sessions).toEqual([]);
  });
});

describe('live Claude subscription limits', () => {
  it('makes no call unless requested', async () => {
    const rec = recording();
    await usage({
      cwd: folder(),
      brains: ['claude'],
      homes: { claude: tempDir() },
      commands: { claude: '/missing/claude' },
      env: { FAKE_RECORD: rec.path },
    });
    expect(() => rec.read()).toThrow('did not record');
  });

  it('uses an isolated minimal call and does not resume or alter a stored session', async () => {
    const cwd = folder(),
      home = tempDir(),
      rec = recording();
    claudeStore(home, cwd, 'saved', [claudeMessage('m', 'a')]);
    const report = await usage({
      cwd,
      brains: ['claude'],
      homes: { claude: home },
      live: true,
      commands: { claude: FAKE.claude },
      env: { FAKE_SCENARIO: 'limits-warning', FAKE_RECORD: rec.path },
    });
    expect(report.brains[0]?.limitsSource).toBe('live');
    expect(report.brains[0]?.limits?.map((w) => w.window)).toEqual(['five_hour', 'seven_day']);
    expect(rec.read().argv).toEqual(
      expect.arrayContaining(['--model', 'haiku', '--no-session-persistence', '--strict-mcp-config', '--tools']),
    );
    expect(rec.read().argv).not.toContain('--resume');
    expect(rec.read().cwd).not.toBe(cwd);
    expect(report.sessions.map((s) => s.id)).toEqual(['saved']);
  });

  it('preserves a rejected rate-limit event together with the failure', async () => {
    const report = await usage({
      cwd: folder(),
      brains: ['claude'],
      homes: { claude: tempDir() },
      live: true,
      commands: { claude: FAKE.claude },
      env: { FAKE_SCENARIO: 'limits-rejected' },
    });
    expect(report.brains[0]?.limits?.[0]?.utilization).toBe(1);
    expect(report.brains[0]?.error?.kind).toBe('usage_limit');
  });

  it('returns a missing-CLI failure with the stored usage still available', async () => {
    const cwd = folder(),
      home = tempDir();
    claudeStore(home, cwd, 'saved', [claudeMessage('m', 'a')]);
    const report = await usage({
      cwd,
      brains: ['claude'],
      homes: { claude: home },
      live: true,
      commands: { claude: '/missing/claude' },
    });
    expect(report.brains[0]?.limitsUnavailable).toBe('failed');
    expect(report.brains[0]?.error?.kind).toBe('not_installed');
    expect(report.sessions[0]?.usage?.inputTokens).toBe(10);
  });
});
