import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  capturePane,
  closePane,
  findPaneSession,
  listPanes,
  paneMemory,
  panesAvailable,
  resizePane,
  sendToPane,
  setPaneSession,
  startPane,
} from '../src/panes.js';
import { which } from '../src/process.js';
import { FAKE, tempDir } from './helpers.js';

// A real tmux on a server of its own; skipped where tmux is missing.
const socket = `brainyard-test-${process.pid}`;
const settings = { socket };
const hasTmux = process.platform !== 'win32' && which('tmux') !== undefined;

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < end) {
    await new Promise((done) => setTimeout(done, 50));
    value = await read();
  }
  return value;
}

const text = (lines: string[]) => lines.join('\n');

describe.skipIf(!hasTmux)('panes (real tmux)', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.BRAINYARD_TMUX_SOCKET;
    process.env.BRAINYARD_TMUX_SOCKET = socket;
  });
  afterAll(async () => {
    for (const pane of await listPanes(settings)) await closePane(pane.pane, settings);
    if (saved === undefined) delete process.env.BRAINYARD_TMUX_SOCKET;
    else process.env.BRAINYARD_TMUX_SOCKET = saved;
  });

  it('knows tmux is there', () => {
    expect(panesAvailable(settings)).toBe(true);
  });

  it('starts a CLI in a pane, shows its screen with colours, takes keys and closes', async () => {
    const cwd = tempDir();
    const started = await startPane(
      {
        brain: 'claude',
        cwd,
        command: FAKE.claude,
        prompt: 'first message;',
        name: 'Узел; с точкой с запятой;',
        env: { FAKE_PANE: '1' },
        width: 70,
        height: 12,
      },
      settings,
    );
    expect(started.pane).toMatch(/^claude-[0-9a-f]{8}$/);
    expect(started.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const screen = await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('fake-claude ready')),
    );
    expect(screen).toBeDefined();
    expect(screen!.width).toBe(70);
    expect(screen!.lines).toHaveLength(12);
    // The prompt reached the CLI whole, trailing semicolon included.
    expect(text(screen!.lines)).toContain('first message;');
    // Colours come through as SGR, and every row resets its own.
    const red = screen!.lines.find((line) => line.includes('red'))!;
    expect(red).toContain('\u001b[31mred');

    const [info] = (await listPanes(settings)).filter((p) => p.pane === started.pane);
    expect(info).toMatchObject({
      brain: 'claude',
      sessionId: started.sessionId,
      label: 'Узел; с точкой с запятой;',
      cwd: expect.stringContaining('brainyard-test-'),
      attached: false,
      width: 70,
      height: 12,
    });
    expect(info!.pid).toBeGreaterThan(0);
    expect(Date.parse(info!.activityAt!)).toBeGreaterThan(0);

    // Typed text in any language, Enter and arrows arrive as typed.
    await sendToPane(started.pane, 'привет\r\u001b[A', settings);
    const typed = await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('got:')),
    );
    expect(text(typed!.lines)).toMatch(/got:.*привет/);

    expect(await resizePane(started.pane, 50, 8, settings)).toBe(true);
    const smaller = await capturePane(started.pane, settings);
    expect(smaller).toMatchObject({ width: 50, height: 8 });

    const memory = await paneMemory([info!]);
    expect(memory.get(started.pane)).toBeGreaterThan(1_000_000);

    expect(await closePane(started.pane, settings)).toBe(true);
    expect((await listPanes(settings)).some((p) => p.pane === started.pane)).toBe(false);
    expect(await capturePane(started.pane, settings)).toBeUndefined();
  });

  it('a CLI that fails at once keeps its screen until Enter', async () => {
    const started = await startPane(
      { brain: 'claude', cwd: tempDir(), command: FAKE.claude, env: { FAKE_PANE: '1', FAKE_EXIT: '3' } },
      settings,
    );
    await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('fake-claude ready')),
    );
    await sendToPane(started.pane, 'q', settings);
    const failed = await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('exited with code 3')),
    );
    expect(text(failed!.lines)).toContain('Enter closes');
    await sendToPane(started.pane, '\r', settings);
    const gone = await until(
      () => listPanes(settings),
      (list) => !list.some((p) => p.pane === started.pane),
    );
    expect(gone.some((p) => p.pane === started.pane)).toBe(false);
  });

  it('Codex names its session only after it starts: the pane finds it in the store', async () => {
    const home = tempDir('brainyard-codex-home-');
    const cwd = tempDir();
    const started = await startPane(
      {
        brain: 'codex',
        cwd,
        command: FAKE.codex,
        prompt: 'hello',
        env: { FAKE_PANE: '1', FAKE_CODEX_HOME: home, FAKE_SESSION_ID: '019f0000-0000-7000-8000-00000000abcd' },
      },
      settings,
    );
    expect(started.sessionId).toBeUndefined();
    expect(started.pane).toMatch(/^codex-/);
    await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('fake-codex ready')),
    );
    const info = (await listPanes(settings)).find((p) => p.pane === started.pane)!;
    const found = await findPaneSession(info, { homes: { codex: home } });
    expect(found?.id).toBe('019f0000-0000-7000-8000-00000000abcd');
    expect(await setPaneSession(started.pane, found!.id, settings)).toBe(true);
    const again = (await listPanes(settings)).find((p) => p.pane === started.pane);
    expect(again).toMatchObject({ brain: 'codex', sessionId: found!.id });
    await closePane(started.pane, settings);
  });

  it('OpenCode names its session only after it starts: the pane finds it in its database', async () => {
    const home = tempDir('brainyard-opencode-home-');
    const cwd = tempDir();
    const started = await startPane(
      {
        brain: 'opencode',
        cwd,
        command: FAKE.opencode,
        prompt: 'hello',
        env: { FAKE_PANE: '1', FAKE_OPENCODE_HOME: home, FAKE_SESSION_ID: 'ses_inPane' },
      },
      settings,
    );
    expect(started.sessionId).toBeUndefined();
    expect(started.pane).toMatch(/^opencode-/);
    await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('fake-opencode ready')),
    );
    const info = (await listPanes(settings)).find((p) => p.pane === started.pane)!;
    expect(info.brain).toBe('opencode');
    const found = await findPaneSession(info, { homes: { opencode: home } });
    expect(found).toMatchObject({ id: 'ses_inPane', title: 'hello' });
    await closePane(started.pane, settings);
  });

  it('a server started from inside Claude Code does not pass that session on to panes', () => {
    // An old server remembers the environment of whoever started it.
    const dirty = `${socket}-dirty`;
    const env = {
      ...process.env,
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
      CLAUDE_EFFORT: 'xhigh',
      CLAUDE_PID: '42',
      CLAUDE_CODE_USE_BEDROCK: '1',
    };
    delete (env as NodeJS.ProcessEnv).TMUX;
    spawnSync('tmux', ['-L', dirty, '-f', '/dev/null', 'new-session', '-d', '-s', 'keep', 'sleep 30'], { env });
    return (async () => {
      const started = await startPane(
        { brain: 'claude', cwd: tempDir(), command: FAKE.claude, env: { FAKE_PANE: '1' } },
        { socket: dirty },
      );
      const screen = await until(
        () => capturePane(started.pane, { socket: dirty }),
        (s) => Boolean(s && text(s.lines).includes('inherited:')),
      );
      expect(text(screen!.lines)).toContain('inherited:none keep:1');
      spawnSync('tmux', ['-L', dirty, 'kill-server']);
    })();
  });

  it('a pane is never named by prefix: closing one leaves the others', async () => {
    expect(await closePane('claude', settings)).toBe(false);
    expect(await capturePane('claude', settings)).toBeUndefined();
  });
});

describe('panes without tmux', () => {
  it('say so instead of failing', async () => {
    const none = { command: '/nonexistent/tmux' };
    expect(panesAvailable(none)).toBe(false);
    expect(await listPanes(none)).toEqual([]);
    expect(await capturePane('x', none)).toBeUndefined();
    await expect(startPane({ brain: 'claude', cwd: tempDir() }, none)).rejects.toThrow(/tmux/);
  });
});
