import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FAKE, tempDir } from '../../brainyard/test/helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function cli(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  const done = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    cwd: root,
    input: options.input ?? '',
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      BRAINYARD_CLAUDE_BIN: JSON.stringify(FAKE.claude),
      BRAINYARD_CODEX_BIN: JSON.stringify(FAKE.codex),
      BRAINYARD_AGY_BIN: JSON.stringify(FAKE.antigravity),
      ...options.env,
    },
    timeout: 30_000,
  });
  return { code: done.status, stdout: done.stdout, stderr: done.stderr };
}

describe('brainyard CLI', () => {
  it('prints the status table', () => {
    const { code, stdout } = cli(['status']);
    expect(code).toBe(0);
    expect(stdout).toContain('Claude Code');
    expect(stdout).toContain('3 of 3 ready');
  });

  it('prints status as JSON and exits 1 when a named brain is not ready', () => {
    const ok = cli(['status', '--json']);
    expect(JSON.parse(ok.stdout).ready).toEqual(['claude', 'codex', 'antigravity']);
    const missing = cli(['status', '--brain', 'codex'], { env: { BRAINYARD_CODEX_BIN: 'no-such-binary-brainyard' } });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain('not installed');
  });

  it('asks: the answer goes to stdout, the details to stderr', () => {
    const { code, stdout, stderr } = cli(['ask', 'codex', 'Explain', 'this']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('Answer to: Explain this');
    expect(stderr).toMatch(/\d\.\ds/);
  });

  it('takes a piped prompt and appends it to the one given', () => {
    const { stdout } = cli(['ask', 'codex', 'Review:'], { input: 'diff --git a b' });
    expect(stdout.trim()).toBe('Answer to: Review:\n\ndiff --git a b'.slice(0, 'Answer to: '.length + 60));
  });

  it('runs an agent with a feed on stderr and the answer on stdout', () => {
    const { code, stdout, stderr } = cli(['run', 'codex', '--cwd', tempDir(), 'fix', 'the', 'bug']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('Answer to: fix the bug');
    expect(stderr).toContain('ran: echo hi');
    expect(stderr).toContain('continue: brainyard run codex --resume codex-thread-1');
  });

  it('streams events as JSON lines', () => {
    const { stdout } = cli(['run', 'claude', '--json', '--cwd', tempDir(), 'x'], { env: { FAKE_SCENARIO: 'ok' } });
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines[0].kind).toBe('init');
    expect(lines.at(-1)).toMatchObject({ kind: 'result', result: { ok: true, text: 'DONE' } });
  });

  it('explains usage mistakes with exit code 2', () => {
    expect(cli(['nonsense']).code).toBe(2);
    expect(cli(['ask', 'gpt', 'hi']).stderr).toContain('unknown brain');
    expect(cli(['run', 'claude', '--access', 'everything', 'x']).code).toBe(2);
  });

  it('reports a missing CLI with the install command', () => {
    const { code, stderr } = cli(['ask', 'codex', 'hi'], { env: { BRAINYARD_CODEX_BIN: 'no-such-binary-brainyard' } });
    expect(code).toBe(1);
    expect(stderr).toContain('not_installed');
    expect(stderr).toContain('npm install -g @openai/codex');
  });

  it('lists models', () => {
    const catalogs = JSON.parse(cli(['models', 'codex', '--json']).stdout);
    expect(catalogs[0].models.map((m: { id: string }) => m.id)).toEqual(['gpt-test-mini', 'gpt-test-big']);
  });

  it('knows its version', () => {
    expect(cli(['--version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
