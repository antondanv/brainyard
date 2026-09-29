import { describe, expect, it, vi } from 'vitest';

import { clearCatalogCache } from '../src/catalog.js';
import { checkBrain, status } from '../src/status.js';
import { FAKE } from './helpers.js';

describe('status()', () => {
  it('reads version and sign-in of each CLI for free', async () => {
    clearCatalogCache();
    const report = await status({ commands: FAKE, models: true });
    const [claude, codex, agy] = report.brains;
    expect(report.ready).toEqual(['claude', 'codex', 'antigravity']);
    expect(claude).toMatchObject({
      availability: 'ready',
      version: '2.1.999',
      auth: { state: 'logged_in', method: 'claude.ai', plan: 'max', account: 'j******e@example.com' },
    });
    expect(codex).toMatchObject({
      availability: 'ready',
      version: '0.999.0',
      auth: { state: 'logged_in', method: 'ChatGPT' },
    });
    expect(codex?.models?.models.map((m) => m.id)).toEqual(['gpt-test-mini', 'gpt-test-big']);
    expect(agy).toMatchObject({ availability: 'ready', version: '1.2.999', auth: { state: 'logged_in' } });
    expect(agy?.models?.models.map((m) => m.id)).toEqual(['gemini-9-flash', 'claude-x']);
    expect(report.brainyard).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('shows the account only when asked', async () => {
    const shown = await checkBrain('claude', { commands: FAKE, revealAccount: true });
    expect(shown.auth.account).toBe('jane.doe@example.com');
  });

  it('knows a signed-out CLI and says what to do', async () => {
    vi.stubEnv('FAKE_AUTH', 'out');
    const [claude, codex, agy] = (await status({ commands: FAKE })).brains;
    expect(claude?.availability).toBe('needs_login');
    expect(claude?.fix).toMatch(/sign in/);
    expect(codex?.availability).toBe('needs_login');
    expect(agy?.availability).toBe('needs_login');
  });

  it('knows a missing CLI and how to install it', async () => {
    const codex = await checkBrain('codex', { commands: { codex: 'no-such-binary-brainyard' } });
    expect(codex).toMatchObject({ availability: 'not_installed', installed: false });
    expect(codex.fix).toContain('npm install -g @openai/codex');
  });

  it('proves readiness with a live call', async () => {
    const claude = await checkBrain('claude', { commands: FAKE, live: true });
    expect(claude.availability).toBe('ready');
    expect(claude.ping).toMatchObject({ ok: true, text: 'DONE', costUsd: 0.0123 });
  });
});
