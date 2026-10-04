import { existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { ask, askAll } from '../src/ask.js';
import { clearFlagCache } from '../src/flags.js';
import { FAKE, recording } from './helpers.js';

describe('ask()', () => {
  it('answers in a fresh folder that is removed afterwards, isolated from the user setup', async () => {
    clearFlagCache();
    const calls = recording();
    const answer = await ask('claude', 'What is 2+2?', {
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'ok', FAKE_RECORD: calls.path },
      system: 'Answer with a number.',
    });
    expect(answer).toMatchObject({ brain: 'claude', text: 'DONE', costUsd: 0.0123, costSource: 'cli' });
    const call = calls.read();
    expect(call.cwd).toMatch(/brainyard-ask-/);
    expect(existsSync(call.cwd)).toBe(false);
    const argv = call.argv;
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--safe-mode');
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('Answer with a number.');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });

  it('asks once more when the turn ends without text', async () => {
    const answer = await ask('antigravity', 'Say something', {
      command: FAKE.antigravity,
      env: { FAKE_SCENARIO: 'silent' },
    });
    expect(answer.text).toMatch(/^Reply 2:/);
  });

  it('throws a typed error on failure', async () => {
    await expect(ask('codex', 'x', { command: FAKE.codex, env: { FAKE_SCENARIO: 'fail' } })).rejects.toMatchObject({
      name: 'BrainyardError',
      kind: 'usage_limit',
      brain: 'codex',
    });
  });

  it('keeps a folder you gave it', async () => {
    const calls = recording();
    const dir = (await import('./helpers.js')).tempDir();
    await ask('codex', 'x', { command: FAKE.codex, cwd: dir, env: { FAKE_RECORD: calls.path } });
    expect(existsSync(dir)).toBe(true);
  });
});

describe('askAll()', () => {
  it('asks several CLIs in parallel and never throws', async () => {
    vi.stubEnv('BRAINYARD_CLAUDE_BIN', JSON.stringify(FAKE.claude));
    vi.stubEnv('BRAINYARD_CODEX_BIN', JSON.stringify(FAKE.codex));
    vi.stubEnv('BRAINYARD_AGY_BIN', 'no-such-binary-brainyard');
    const entries = await askAll('hello');
    expect(entries.map((entry) => entry.brain)).toEqual(['claude', 'codex', 'antigravity']);
    expect(entries[0]?.result?.text).toBe('DONE');
    expect(entries[1]?.result?.text).toBe('Answer to: hello');
    expect(entries[2]?.error?.kind).toBe('not_installed');
  });
});
