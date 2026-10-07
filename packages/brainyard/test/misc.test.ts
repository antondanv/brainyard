import { describe, expect, it } from 'vitest';

import { estimateCost } from '../src/cost.js';
import { resolveLaunch } from '../src/options.js';
import { applyEnv, removals, withoutSessionVars } from '../src/process.js';
import { EventStream } from '../src/stream.js';
import { FAKE, tempDir } from './helpers.js';

describe('EventStream', () => {
  it('replays everything to late and repeated subscribers', async () => {
    const stream = new EventStream<number>();
    stream.push(1);
    stream.push(2);
    const early: number[] = [];
    const reading = (async () => {
      for await (const value of stream) early.push(value);
    })();
    stream.push(3);
    stream.end();
    await reading;
    const late: number[] = [];
    for await (const value of stream) late.push(value);
    expect(early).toEqual([1, 2, 3]);
    expect(late).toEqual([1, 2, 3]);
  });

  it('throws after draining when it failed', async () => {
    const stream = new EventStream<number>();
    stream.push(1);
    stream.fail(new Error('refused'));
    const seen: number[] = [];
    await expect(async () => {
      for await (const value of stream) seen.push(value);
    }).rejects.toThrow('refused');
    expect(seen).toEqual([1]);
  });

  it('lets a consumer leave early without hanging', async () => {
    const stream = new EventStream<number>();
    stream.push(1);
    for await (const _value of stream) break;
    stream.end();
    expect(stream.items).toEqual([1]);
  });
});

describe('estimateCost', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };

  it('prices tokens per million, cached input at a tenth by default', () => {
    expect(estimateCost('m', usage, { m: { input: 2, output: 10 } })).toBeCloseTo(2 + 1 + 0.2, 8);
  });

  it('matches a dated model id to its undated price', () => {
    expect(
      estimateCost('claude-haiku-4-5-20251001', usage, { 'claude-haiku-4-5': { input: 1, output: 5 } }),
    ).toBeCloseTo(1 + 0.5 + 0.1, 8);
  });

  it('is undefined, not zero, for an unknown price', () => {
    expect(estimateCost('mystery', usage, { other: { input: 1, output: 1 } })).toBeUndefined();
    expect(estimateCost(undefined, usage, {})).toBeUndefined();
  });
});

describe('resolveLaunch', () => {
  const base = { brain: 'claude', prompt: 'x', command: FAKE.claude };

  it('checks MCP server names and shapes before anything starts', async () => {
    const cwd = tempDir();
    await expect(
      resolveLaunch({ ...base, cwd, mcpServers: { 'bad name': { command: 'x' } } }, { kind: 'run' }),
    ).rejects.toThrow(/must match/);
    await expect(resolveLaunch({ ...base, cwd, mcpServers: { ok: { command: '' } } }, { kind: 'run' })).rejects.toThrow(
      /needs a command/,
    );
  });

  it('applies different defaults to runs and one-shot answers', async () => {
    const cwd = tempDir();
    const forRun = await resolveLaunch({ ...base, cwd }, { kind: 'run' });
    expect(forRun.launch).toMatchObject({ access: 'full', web: true, isolated: false, steerable: true });
    const forAsk = await resolveLaunch({ ...base, cwd }, { kind: 'ask' });
    expect(forAsk.launch).toMatchObject({ access: 'readonly', web: false, isolated: true });
  });

  it('warns when hints are asked of a CLI that cannot take them', async () => {
    const resolved = await resolveLaunch(
      { brain: 'codex', prompt: 'x', command: FAKE.codex, cwd: tempDir(), steerable: true },
      { kind: 'run' },
    );
    expect(resolved.launch.steerable).toBe(false);
    expect(resolved.warnings[0]).toMatch(/takes no messages/);
  });
});

describe('quoting for cmd.exe', () => {
  it('quotes and caret-escapes arguments the way cross-spawn does', async () => {
    const { quoteForCmd } = await import('../src/process.js');
    expect(quoteForCmd('plain')).toBe('^"plain^"');
    expect(quoteForCmd('a b&c')).toBe('^"a^ b^&c^"');
    expect(quoteForCmd('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(quoteForCmd('x', true)).toBe('^^^"x^^^"');
  });
});

describe('withoutSessionVars', () => {
  it('drops what a Claude Code session leaves for its children, and nothing a person set', () => {
    const inside = withoutSessionVars({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_PID: '42',
      CLAUDE_EFFORT: 'xhigh',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(inside).toEqual({ PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k' });
  });

  it('keeps an effort a person set in a plain shell', () => {
    expect(withoutSessionVars({ CLAUDE_EFFORT: 'high' })).toEqual({ CLAUDE_EFFORT: 'high' });
  });
});

describe('applyEnv', () => {
  it('sets a string and removes what the caller sets to undefined or null', () => {
    const base = { PATH: '/bin', NODE_ENV: 'production', KEEP: '1', GONE: 'x' };
    const out = applyEnv(base, { NODE_ENV: undefined, GONE: null, NEW: 'y', KEEP: '2' });
    expect(out).toEqual({ PATH: '/bin', KEEP: '2', NEW: 'y' });
    expect('NODE_ENV' in out).toBe(false);
    expect(base.NODE_ENV).toBe('production');
    expect(applyEnv(base, undefined)).toEqual(base);
  });

  it('knows which variables a caller asks to remove', () => {
    expect(removals({ A: 'a', B: undefined, C: null })).toEqual({ B: undefined, C: undefined });
    expect(Object.keys(removals({ A: 'a', B: undefined, C: null }))).toEqual(['B', 'C']);
    expect(removals(undefined)).toEqual({});
  });
});
