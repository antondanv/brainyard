import { execFile, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { capturePane, listPanes, panesAvailable } from '@antondanv/brainyard';
import { afterAll, describe, expect, it } from 'vitest';

import { claudeMessage, claudeStore } from '../../brainyard/test/fixtures/usage-store.js';
import { FAKE, tempDir } from '../../brainyard/test/helpers.js';
import { cli, root, TEST_SOCKET } from './run-cli.js';

// Real tmux, on servers of the tests' own: the panes, and a terminal to attach from.
const run = promisify(execFile);
const settings = { socket: TEST_SOCKET };
const TERM_SOCKET = `${TEST_SOCKET}-term`;
const term = async (...args: string[]) => (await run('tmux', ['-L', TERM_SOCKET, '-f', '/dev/null', ...args])).stdout;
/** The fake CLIs act as terminal programs in a pane. */
const env = { FAKE_PANE: '1' };

const screenOf = async (pane: string) => (await capturePane(pane, settings))?.lines.join('\n') ?? '';

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

function start(...args: string[]): string {
  const started = cli(['pane', 'start', 'claude', '--cwd', tempDir(), ...args], { env });
  expect(started.code, started.stderr).toBe(0);
  return started.stdout.trim();
}

/** Runs `brainyard …` in a terminal of the test tmux server, where attaching works. */
async function inTerminal(session: string, command: string, vars: Record<string, string> = {}): Promise<void> {
  const assignments = Object.entries({ BRAINYARD_TMUX_SOCKET: TEST_SOCKET, ...vars }).map(([k, v]) => `${k}=${v}`);
  const main = `"${process.execPath}" --import tsx src/main.ts`;
  await term(
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '100',
    '-y',
    '30',
    '-c',
    root,
    '--',
    'env',
    ...assignments,
    'sh',
    '-c',
    `${main} ${command}; echo "exited $?"; sleep 30`,
  );
}

describe.skipIf(!panesAvailable())('brainyard panes and pane … (real tmux)', () => {
  afterAll(() => {
    spawnSync('tmux', ['-L', TEST_SOCKET, 'kill-server']);
    spawnSync('tmux', ['-L', TERM_SOCKET, 'kill-server']);
  });

  it('starts a pane, lists it, shows its screen and closes it with the way back', async () => {
    const cwd = tempDir();
    const started = cli(
      [
        'pane',
        'start',
        'claude',
        '--cwd',
        cwd,
        '--name',
        'Узел; тест',
        '--width',
        '70',
        '--height',
        '12',
        'first',
        'message',
      ],
      { env },
    );
    expect(started.code, started.stderr).toBe(0);
    const pane = started.stdout.trim();
    expect(pane).toMatch(/^claude-[0-9a-f]{8}$/);
    expect(started.stderr).toContain(`attach: brainyard pane attach ${pane}`);

    await until(() => screenOf(pane), 'fake-claude ready');
    const shown = cli(['pane', 'show', pane], { env });
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('first message');
    // No terminal, no colours: the screen comes as plain text, without its empty rows below.
    expect(shown.stdout).toContain('red and plain');
    expect(shown.stdout).not.toContain('\u001b[');
    expect(shown.stdout.endsWith('red and plain\n')).toBe(true);
    const screen = JSON.parse(cli(['pane', 'show', pane, '--json'], { env }).stdout);
    expect(screen).toMatchObject({ width: 70, height: 12 });
    expect(screen.lines.join('\n')).toContain('\u001b[31mred');

    const [row] = JSON.parse(cli(['panes', '--json'], { env }).stdout).filter((p: { pane: string }) => p.pane === pane);
    expect(row).toMatchObject({ pane, brain: 'claude', label: 'Узел; тест', cwd, attached: false, width: 70 });
    expect(row.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.memory).toBeGreaterThan(1_000_000);
    const listed = cli(['panes'], { env }).stdout;
    expect(listed).toMatch(new RegExp(`${pane}\\s+Claude Code\\s+${row.sessionId.slice(0, 8)}\\s+\\d+(\\.\\d)? MB`));
    expect(listed).toContain('Узел; тест');

    // Something was said in it: Claude Code keeps the conversation, and the pane comes back with it.
    const claude = tempDir('brainyard-claude-home-');
    claudeStore(claude, cwd, row.sessionId, [claudeMessage('msg_1', 'claude-test')]);
    const closed = cli(['pane', 'close', pane], { env: { ...env, CLAUDE_CONFIG_DIR: claude } });
    expect(closed.code, closed.stderr).toBe(0);
    expect(closed.stderr).toContain(
      `closed ${pane} · resume: brainyard pane start claude --cwd ${cwd} --resume ${row.sessionId}`,
    );
    expect((await listPanes(settings)).some((p) => p.pane === pane)).toBe(false);
    const again = cli(['pane', 'close', pane], { env });
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`no such pane: ${pane}`);
  });

  it('a pane nobody spoke in closes with nothing to resume', async () => {
    const pane = start();
    await until(() => screenOf(pane), 'fake-claude ready');
    const closed = cli(['pane', 'close', pane], { env: { ...env, CLAUDE_CONFIG_DIR: tempDir() } });
    expect(closed.code).toBe(0);
    expect(closed.stderr).toContain(`closed ${pane} · nothing was said in it, so there is nothing to resume`);
  });

  it('types the text and then Enter as a key of its own; named keys go first', async () => {
    const pane = start('--height', '24');
    await until(() => screenOf(pane), 'fake-claude ready');

    expect(cli(['pane', 'send', pane, 'привет'], { env }).code).toBe(0);
    // A CLI that reads a burst as a paste keeps an Enter inside it: here it arrives on its own.
    await until(() => screenOf(pane), /got:привет\ngot:\^M/);

    expect(cli(['pane', 'send', pane, '--key', 'up', '--key', 'ctrl-c', 'да'], { env }).code).toBe(0);
    await until(() => screenOf(pane), /got:\^\[\[A\ngot:\^C\ngot:да\ngot:\^M/);

    expect(cli(['pane', 'send', pane, '-'], { env, input: 'из stdin\n' }).code).toBe(0);
    await until(() => screenOf(pane), /got:из stdin\ngot:\^M/);

    expect(cli(['pane', 'send', pane, '--no-enter', 'only'], { env }).code).toBe(0);
    await until(() => screenOf(pane), 'got:only');
    await sleep(300);
    expect((await screenOf(pane)).trimEnd().endsWith('got:only')).toBe(true);

    expect(cli(['pane', 'send', pane, '--key', 'hyper'], { env }).code).toBe(2);
    expect(cli(['pane', 'send', pane], { env }).code).toBe(2);
    expect(cli(['pane', 'close', pane], { env }).code).toBe(0);
  });

  it('finds a pane by the start of its session id and refuses a name that fits two', async () => {
    const first = JSON.parse(cli(['pane', 'start', 'claude', '--cwd', tempDir(), '--json'], { env }).stdout);
    expect(first).toMatchObject({ brain: 'claude', pane: expect.stringMatching(/^claude-/) });
    const second = start();
    await until(() => screenOf(first.pane), 'fake-claude ready');

    const shown = cli(['pane', 'show', first.sessionId.slice(0, 8)], { env });
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(first.sessionId);
    const both = cli(['pane', 'show', 'claude-'], { env });
    expect(both.code).toBe(2);
    expect(both.stderr).toMatch(/fits \d+ panes/);
    expect(cli(['pane', 'show', 'nosuch'], { env }).code).toBe(1);

    for (const pane of [first.pane, second]) expect(cli(['pane', 'close', pane], { env }).code).toBe(0);
  });

  it('attach: the pane takes the terminal until Ctrl+Q, then the command returns', async () => {
    const pane = start();
    await until(() => screenOf(pane), 'fake-claude ready');
    const outer = () => term('capture-pane', '-p', '-t', '=attach:');
    await inTerminal('attach', `pane attach ${pane}`);
    try {
      await until(outer, 'fake-claude ready');
      expect(await outer()).toContain('Ctrl+Q — back');
      await term('send-keys', '-t', '=attach:', 'C-q');
      const after = await until(outer, 'exited');
      expect(after).toContain(`${pane} keeps running`);
      expect(after).toContain('exited 0');
      expect((await listPanes(settings)).some((p) => p.pane === pane)).toBe(true);
    } finally {
      await term('kill-session', '-t', '=attach').catch(() => undefined);
      cli(['pane', 'close', pane], { env });
    }
  });

  it('sessions marks a session that runs in a pane, and stop points to pane close for it', () => {
    const cwd = realpathSync(tempDir());
    const started = JSON.parse(cli(['pane', 'start', 'claude', '--cwd', cwd, '--json'], { env }).stdout);
    const agents = [
      { id: started.sessionId.slice(0, 8), sessionId: started.sessionId, kind: 'interactive', status: 'idle', cwd },
    ];
    const machine = { ...env, HOME: tempDir(), CODEX_HOME: tempDir(), FAKE_AGENTS: JSON.stringify(agents) };
    const listed = cli(['sessions', '--live', '--cwd', cwd], { env: machine });
    expect(listed.stdout).toContain(`● open ▣ ${started.pane}`);
    const stop = cli(['stop', started.sessionId], { env: machine });
    expect(stop.code).toBe(1);
    expect(stop.stderr).toContain(`it runs in a pane: brainyard pane close ${started.pane}`);
    expect(cli(['pane', 'close', started.pane], { env }).code).toBe(0);
  });

  it('pane start --attach opens the new pane full screen at once', async () => {
    const cwd = tempDir();
    const outer = () => term('capture-pane', '-p', '-t', '=start:');
    await inTerminal('start', `pane start claude --cwd ${cwd} --attach hello`, {
      ...env,
      BRAINYARD_CLAUDE_BIN: JSON.stringify(FAKE.claude),
    });
    try {
      await until(outer, 'fake-claude ready');
      const pane = (await listPanes(settings)).find((p) => p.cwd === cwd)?.pane;
      expect(pane).toMatch(/^claude-/);
      await term('send-keys', '-t', '=start:', 'C-q');
      const after = await until(outer, 'exited');
      expect(after).toContain(`${pane} keeps running`);
      expect(after).toContain('exited 0');
      cli(['pane', 'close', pane!], { env });
    } finally {
      await term('kill-session', '-t', '=start').catch(() => undefined);
    }
  });
});

describe('panes without tmux or a terminal', () => {
  it('say what they need', () => {
    const none = cli(['panes'], { env: { BRAINYARD_TMUX_BIN: '/nonexistent/tmux' } });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('panes need tmux');
    // spawnSync gives no terminal to attach to.
    expect(cli(['pane', 'attach', 'claude-00000000']).stderr).toContain('attaching takes a terminal');
    expect(cli(['pane', 'start', 'claude', '--attach']).code).toBe(2);
  });

  it('explain a missing or unknown pane command', () => {
    expect(cli(['pane']).code).toBe(2);
    expect(cli(['pane', 'list']).stderr).toContain('unknown pane command "list"');
  });
});
