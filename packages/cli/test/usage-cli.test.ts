import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  claudeMessage,
  claudeStore,
  codexLimits,
  codexStore,
  codexTokens,
} from '../../brainyard/test/fixtures/usage-store.js';
import { tempDir } from '../../brainyard/test/helpers.js';
import { cli, machine } from './run-cli.js';

const project = () => realpathSync(tempDir('brainyard-project-'));
const CLAUDE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CODEX_ID = '019f0000-0000-7000-8000-000000000002';

/** A folder with one saved Claude Code session and one Codex session that saw its limits. */
function saved(): { cwd: string; env: Record<string, string> } {
  const cwd = project();
  const env = machine();
  claudeStore(env.CLAUDE_CONFIG_DIR!, cwd, CLAUDE_ID, [
    claudeMessage('msg_1', 'claude-test', 10, 5),
    claudeMessage('msg_2', 'claude-test', 20, 5),
  ]);
  // Windows that reset in the future: a past reset shows as such, not as a share.
  const soon = Math.floor(Date.now() / 1000);
  codexStore(env.CODEX_HOME!, cwd, CODEX_ID, [
    codexTokens(100, 20, 40),
    codexLimits(new Date().toISOString(), 23, 'codex', [soon + 7200, soon + 5 * 86_400]),
  ]);
  return { cwd, env };
}

describe('brainyard usage', () => {
  it('counts the saved sessions of a folder and shows the limits their logs saw', () => {
    const { cwd, env } = saved();
    const report = JSON.parse(cli(['usage', '--offline', '--cwd', cwd, '--json'], { env }).stdout);
    const byId = new Map(report.sessions.map((session: { id: string }) => [session.id, session]));
    expect(byId.get(CLAUDE_ID)).toMatchObject({ brain: 'claude', usage: { inputTokens: 30, outputTokens: 10 } });
    expect(byId.get(CODEX_ID)).toMatchObject({ brain: 'codex', usage: { outputTokens: 20 } });
    const limits = Object.fromEntries(report.brains.map((brain: { brain: string }) => [brain.brain, brain]));
    expect(limits.codex).toMatchObject({
      limitsSource: 'rollout',
      limits: [{ utilization: 0.23, windowMinutes: 300 }, {}],
    });
    expect(limits.claude.limitsUnavailable).toBe('missing');
    expect(limits.antigravity.limitsUnavailable).toBe('not_requested');

    const text = cli(['usage', '--offline', '--cwd', cwd], { env }).stdout;
    expect(text).toMatch(/Codex\s+5h 23%.*weekly 25%/);
    expect(text).toContain(
      'Claude Code  not seen yet: /usage in Claude Code shows them, or --live (one tiny real call)',
    );
    expect(text).toContain('Antigravity  not checked: --offline');
    expect(text).toMatch(/Claude Code\s+aaaaaaaa\s+\S+\s+Count this session\s+30\s+10\s+.*no price/);
    expect(text).toMatch(/total\s+2 sessions/);
    expect(text).toContain('--prices <file.json>');
  });

  it('estimates dollars from --prices', () => {
    const { cwd, env } = saved();
    const prices = join(tempDir(), 'prices.json');
    writeFileSync(prices, JSON.stringify({ 'claude-test': { input: 3, output: 15 } }));
    const report = JSON.parse(
      cli(['usage', 'claude', '--offline', '--cwd', cwd, '--prices', prices, '--json'], { env }).stdout,
    );
    expect(report.sessions).toEqual([expect.objectContaining({ id: CLAUDE_ID, costSource: 'estimate' })]);
    expect(report.sessions[0].costUsd).toBeGreaterThan(0);
    const text = cli(['usage', 'claude', '--offline', '--cwd', cwd, '--prices', prices], { env }).stdout;
    expect(text).toMatch(/\$0\.\d{4} est\./);
    expect(text).not.toContain('without a price');
  });

  it('takes one session by the start of its id', () => {
    const { cwd, env } = saved();
    const report = JSON.parse(cli(['usage', '--offline', '--cwd', cwd, '--session', 'aaaa', '--json'], { env }).stdout);
    expect(report.sessions.map((session: { id: string }) => session.id)).toEqual([CLAUDE_ID]);
    expect(report.brains.map((brain: { brain: string }) => brain.brain)).toEqual(['claude']);
    const missing = cli(['usage', '--offline', '--cwd', cwd, '--session', 'ffff'], { env });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no saved session ffff');
  });

  it('--limits asks the CLIs for their quotas without a model call, and shows only them', () => {
    // The fake agy's report, its reset times moved into the future.
    const quota = readFileSync(new URL('../../brainyard/test/fixtures/agy-quota.json', import.meta.url), 'utf8');
    const later = new Date(Date.now() + 3 * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const env = {
      ...machine(),
      FAKE_QUOTA_REPORT: quota.replace(/"reset_time": "[^"]+"/g, `"reset_time": "${later}"`),
    };
    const report = JSON.parse(cli(['usage', '--limits', '--json'], { env }).stdout);
    expect(report.sessions).toEqual([]);
    const limits = Object.fromEntries(report.brains.map((brain: { brain: string }) => [brain.brain, brain]));
    // The fake agy answers /usage with its quota report; OpenCode Go has no key here, so no request goes out.
    expect(limits.antigravity).toMatchObject({ limitsSource: 'cli' });
    expect(limits.antigravity.limits.length).toBeGreaterThan(1);
    expect(limits.opencode.limitsUnavailable).toBe('missing');
    expect(limits.claude.limitsUnavailable).toBe('missing');

    const text = cli(['usage', 'antigravity', '--limits'], { env }).stdout;
    expect(text).toMatch(/Antigravity\s+Gemini Models: weekly 1%.* 5h 0%/);
    expect(text).toMatch(/\n\s+Claude and GPT models: /);
    expect(text).not.toContain('Sessions of');
  });

  it('explains flags that do not go together', () => {
    expect(cli(['usage', '--offline', '--live']).code).toBe(2);
    expect(cli(['usage', '--limits', '--session', 'x']).code).toBe(2);
    expect(cli(['usage', '--prices', '/nonexistent/prices.json']).code).toBe(2);
    const bad = join(tempDir(), 'prices.json');
    writeFileSync(bad, JSON.stringify({ 'claude-test': { input: 'three' } }));
    expect(cli(['usage', '--prices', bad]).stderr).toContain('claude-test is not');
    expect(cli(['usage', 'gpt']).code).toBe(2);
  });
});
