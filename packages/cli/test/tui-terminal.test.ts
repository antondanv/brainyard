import { execFile, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { listPanes, panesAvailable } from '@antondanv/brainyard';
import { afterAll, describe, expect, it } from 'vitest';

import { FAKE } from '../../brainyard/test/helpers.js';
import { cli, machine, root, TEST_SOCKET } from './run-cli.js';

// Real tmux, on servers of the test's own: the panes the app starts, and the terminal the app runs in.
const run = promisify(execFile);
const PANES = `${TEST_SOCKET}-app`;
const TERM = `${TEST_SOCKET}-app-term`;
const settings = { socket: PANES };
const term = async (...args: string[]) => (await run('tmux', ['-L', TERM, '-f', '/dev/null', ...args])).stdout;
const screen = () => term('capture-pane', '-p', '-t', '=app:');
const press = (...keys: string[]) => term('send-keys', '-t', '=app:', ...keys);

async function until(wanted: string | RegExp, ms = 10_000): Promise<string> {
  const end = Date.now() + ms;
  const ok = (text: string) => (typeof wanted === 'string' ? text.includes(wanted) : wanted.test(text));
  let text = await screen();
  while (!ok(text) && Date.now() < end) {
    await sleep(50);
    text = await screen();
  }
  expect(text).toMatch(wanted);
  return text;
}

describe.skipIf(!panesAvailable())('brainyard, the app (real tmux)', () => {
  afterAll(() => {
    spawnSync('tmux', ['-L', PANES, 'kill-server']);
    spawnSync('tmux', ['-L', TERM, 'kill-server']);
  });

  it('opens full screen; n starts a pane and goes in; Ctrl+Q comes back; x closes it; q quits', async () => {
    const vars = {
      ...machine(),
      BRAINYARD_TMUX_SOCKET: PANES,
      FAKE_PANE: '1',
      BRAINYARD_CLAUDE_BIN: JSON.stringify(FAKE.claude),
      BRAINYARD_CODEX_BIN: JSON.stringify(FAKE.codex),
      BRAINYARD_AGY_BIN: JSON.stringify(FAKE.antigravity),
      BRAINYARD_OPENCODE_BIN: JSON.stringify(FAKE.opencode),
    };
    const assignments = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
    const main = `"${process.execPath}" --import tsx src/main.ts`;
    await term(
      'new-session',
      '-d',
      '-s',
      'app',
      '-x',
      '110',
      '-y',
      '34',
      '-c',
      root,
      '--',
      'env',
      ...assignments,
      'sh',
      '-c',
      `${main}; echo "exited $?"; sleep 30`,
    );
    try {
      await until('Panes · 0');
      await until(/Claude Code\s+2\.1\.999\s+ready/);
      expect(await term('display-message', '-p', '-t', '=app:', '#{alternate_on}')).toBe('1\n');

      await press('n');
      await until('New pane in');
      await press('Enter');
      const inside = await until('fake-claude ready');
      expect(inside).toContain('Ctrl+Q — back to Brainyard');
      const [pane] = await listPanes(settings);
      expect(pane?.pane).toMatch(/^claude-[0-9a-f]{8}$/);
      expect(pane?.cwd).toBe(root.replace(/\/$/, ''));
      await press('hi');
      await until('got:hi');

      await press('C-q');
      const back = await until(`› ${pane!.pane}`);
      expect(back).toContain('Panes · 1');
      expect(back).toContain('Enter go in (Ctrl+Q back) · x close');
      expect((await listPanes(settings)).map((info) => info.pane)).toEqual([pane!.pane]);

      await press('x');
      await until(`Close ${pane!.pane}?`);
      await press('y');
      await until('Panes · 0');
      expect(await listPanes(settings)).toEqual([]);

      await press('q');
      await until('exited 0');
      // The terminal is given back as it was.
      expect(await term('display-message', '-p', '-t', '=app:', '#{alternate_on} #{cursor_flag}')).toBe('0 1\n');
    } finally {
      await term('kill-session', '-t', '=app').catch(() => undefined);
    }
  });
});

describe('brainyard without a terminal', () => {
  it('prints the status table, as before the app', () => {
    const { code, stdout } = cli([]);
    expect(code).toBe(0);
    expect(stdout).toContain('Claude Code');
    expect(stdout).toContain('4 of 4 ready');
  });
});
