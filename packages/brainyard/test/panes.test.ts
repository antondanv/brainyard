import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearFlagCache } from '../src/flags.js';
import {
  capturePane,
  clipboardCommand,
  closePane,
  findPaneSession,
  formatFields,
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

  it('Antigravity panes started simultaneously keep separate logs and resolve their own sessions', async () => {
    const home = tempDir('brainyard-agy-home-');
    const dirA = realpathSync(tempDir('brainyard-agy-a-'));
    const dirB = realpathSync(tempDir('brainyard-agy-b-'));
    const dirC = realpathSync(tempDir('brainyard-agy-c-'));
    // Four panes at once: two in separate folders and two sharing the same folder.
    const specs = [
      { cwd: dirA, id: '1111aaaa-0000-4000-8000-000000000001' },
      { cwd: dirB, id: '2222bbbb-0000-4000-8000-000000000002' },
      { cwd: dirC, id: '3333cccc-0000-4000-8000-000000000003' },
      { cwd: dirC, id: '4444dddd-0000-4000-8000-000000000004' },
    ];
    const started = await Promise.all(
      specs.map((spec) =>
        startPane(
          {
            brain: 'antigravity',
            cwd: spec.cwd,
            command: FAKE.antigravity,
            prompt: `task ${spec.id.slice(0, 4)}`,
            homes: { antigravity: home },
            env: { FAKE_PANE: '1', FAKE_AGY_HOME: home, FAKE_AGY_DB: '1', FAKE_SESSION_ID: spec.id },
          },
          settings,
        ),
      ),
    );
    // A fifth pane in dirC that has not created its conversation yet must not steal a sibling's session.
    const pending = await startPane(
      {
        brain: 'antigravity',
        cwd: dirC,
        command: FAKE.antigravity,
        homes: { antigravity: home },
        env: { FAKE_PANE: '1', FAKE_AGY_HOME: home, FAKE_AGY_DB: '1', FAKE_AGY_SKIP_LOG_CONV: '1' },
      },
      settings,
    );
    try {
      for (const pane of [...started, pending]) {
        await until(
          () => capturePane(pane.pane, settings),
          (s) => Boolean(s && text(s.lines).includes('fake-agy ready')),
        );
      }
      const panes = await listPanes(settings);
      for (let i = 0; i < specs.length; i++) {
        const info = panes.find((p) => p.pane === started[i]!.pane)!;
        const found = await findPaneSession(info, { homes: { antigravity: home } });
        expect(found?.id).toBe(specs[i]!.id);
      }
      const pendingInfo = panes.find((p) => p.pane === pending.pane)!;
      expect(await findPaneSession(pendingInfo, { homes: { antigravity: home } })).toBeUndefined();
      const logs = readdirSync(join(home, 'log')).filter((name) => /^cli-.*\.log$/.test(name));
      expect(logs).toHaveLength(5);
    } finally {
      for (const pane of [...started, pending]) await closePane(pane.pane, settings);
    }
  });

  it('Antigravity panes without --log-file space launches apart and never guess from a mixed log', async () => {
    const home = tempDir('brainyard-agy-old-home-');
    const dirA = realpathSync(tempDir('brainyard-agy-old-a-'));
    const dirB = realpathSync(tempDir('brainyard-agy-old-b-'));
    const idA = 'aaaa5555-0000-4000-8000-000000000001';
    const idB = 'bbbb6666-0000-4000-8000-000000000002';
    process.env.FAKE_OLD = '1';
    clearFlagCache();
    let started: Awaited<ReturnType<typeof startPane>>[] = [];
    try {
      started = await Promise.all([
        startPane(
          {
            brain: 'antigravity',
            cwd: dirA,
            command: FAKE.antigravity,
            homes: { antigravity: home },
            env: { FAKE_OLD: '1', FAKE_PANE: '1', FAKE_AGY_HOME: home, FAKE_AGY_DB: '1', FAKE_SESSION_ID: idA },
          },
          settings,
        ),
        startPane(
          {
            brain: 'antigravity',
            cwd: dirB,
            command: FAKE.antigravity,
            homes: { antigravity: home },
            env: { FAKE_OLD: '1', FAKE_PANE: '1', FAKE_AGY_HOME: home, FAKE_AGY_DB: '1', FAKE_SESSION_ID: idB },
          },
          settings,
        ),
      ]);
      for (const pane of started) {
        await until(
          () => capturePane(pane.pane, settings),
          (s) => Boolean(s && text(s.lines).includes('fake-agy ready')),
        );
      }
      const panes = await listPanes(settings);
      const foundA = await findPaneSession(panes.find((p) => p.pane === started[0]!.pane)!, {
        homes: { antigravity: home },
      });
      const foundB = await findPaneSession(panes.find((p) => p.pane === started[1]!.pane)!, {
        homes: { antigravity: home },
      });
      expect(foundA?.id).toBe(idA);
      expect(foundB?.id).toBe(idB);
      const logs = readdirSync(join(home, 'log')).filter((name) => /^cli-\d{8}_\d{6}\.log$/.test(name));
      expect(logs).toHaveLength(2);

      // A mixed log on disk must not let findPaneSession attribute a conversation to the folder.
      const mixedHome = tempDir('brainyard-agy-mixed-');
      const mixedDir = realpathSync(tempDir('brainyard-agy-mixed-dir-'));
      mkdirSync(join(mixedHome, 'log'), { recursive: true });
      const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
      };
      const db = new DatabaseSync(join(mixedHome, 'conversation_summaries.db'));
      db.exec(
        'CREATE TABLE conversation_summaries (conversation_id text, title text, workspace_uris text, status text, ' +
          'not_fully_idle numeric, killed numeric, last_modified_time datetime, last_user_input_time datetime)',
      );
      db.exec(
        "INSERT INTO conversation_summaries VALUES ('cccc7777-0000-4000-8000-000000000003', 'Mixed', '', 'CASCADE_RUN_STATUS_IDLE', 0, 0, datetime('now'), datetime('now'))",
      );
      db.close();
      writeFileSync(
        join(mixedHome, 'log', 'cli-20261125_201630.log'),
        `I1125 20:16:30.931034 1 server.go:315] Creating CLI server backend: product=antigravity workspaceDirs=[${mixedDir}] appDataDir=${mixedHome}\n` +
          'I1125 20:16:33.200623 416 server.go:1269] Created conversation cccc7777-0000-4000-8000-000000000003\n' +
          'I1125 20:16:33.205458 666 manager.go:1710] broken uI1125 20:16:33.305403 520 http_helpers.go:787] URL: x\n',
      );
      const fakePaneInfo = {
        pane: 'agy-deadbeef',
        brain: 'antigravity' as const,
        cwd: mixedDir,
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        attached: false,
        width: 80,
        height: 24,
      };
      expect(await findPaneSession(fakePaneInfo, { homes: { antigravity: mixedHome } })).toBeUndefined();
    } finally {
      for (const pane of started) await closePane(pane.pane, settings);
      delete process.env.FAKE_OLD;
      clearFlagCache();
    }
  }, 15_000);

  it('OpenCode gets instructions in its environment, whatever quotes they hold, and no message', async () => {
    const started = await startPane(
      {
        brain: 'opencode',
        cwd: tempDir(),
        command: FAKE.opencode,
        system: `Node k3f9's "goal"; $HOME`,
        env: { FAKE_PANE: '1' },
      },
      settings,
    );
    const screen = await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('build-prompt:')),
    );
    expect(text(screen!.lines)).toContain('fake-opencode ready []');
    expect(text(screen!.lines)).toContain(`build-prompt:Node k3f9's "goal"; $HOME`);
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

  it('a variable set to undefined is unset in the pane, even on a server that was started with it', async () => {
    const dirty = `${socket}-env`;
    const env = { ...process.env, NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    delete env.TMUX;
    spawnSync('tmux', ['-L', dirty, '-f', '/dev/null', 'new-session', '-d', '-s', 'keep', 'sleep 30'], { env });
    try {
      const shown = async (change: Record<string, string | undefined>) => {
        const started = await startPane(
          { brain: 'claude', cwd: tempDir(), command: FAKE.claude, env: { FAKE_PANE: '1', ...change } },
          { socket: dirty },
        );
        const screen = await until(
          () => capturePane(started.pane, { socket: dirty }),
          (s) => Boolean(s && text(s.lines).includes('node-env:')),
        );
        return /node-env:(\S+)/.exec(text(screen!.lines))?.[1];
      };
      expect(await shown({})).toBe('production');
      expect(await shown({ NODE_ENV: undefined })).toBe('-');
      expect(await shown({ NODE_ENV: 'development' })).toBe('development');
    } finally {
      spawnSync('tmux', ['-L', dirty, 'kill-server']);
    }
  });

  it('a variable set to undefined stays out of the environment of the server the pane starts', async () => {
    const fresh = `${socket}-fresh`;
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await startPane(
        { brain: 'claude', cwd: tempDir(), command: FAKE.claude, env: { FAKE_PANE: '1', NODE_ENV: undefined } },
        { socket: fresh },
      );
      const global = spawnSync('tmux', ['-L', fresh, '-f', '/dev/null', 'show-environment', '-g']).stdout.toString();
      expect(global).toContain('PATH=');
      expect(global).not.toMatch(/^NODE_ENV=/m);
    } finally {
      spawnSync('tmux', ['-L', fresh, 'kill-server']);
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  });

  it('text selected in a pane goes to the clipboard command, as a mouse selection does', async () => {
    const copied = join(tempDir(), 'copied.txt');
    const started = await startPane(
      {
        brain: 'claude',
        cwd: tempDir(),
        command: FAKE.claude,
        env: { FAKE_PANE: '1' },
      },
      // Never the clipboard of the machine the tests run on.
      { ...settings, env: { BRAINYARD_COPY_COMMAND: `cat > '${copied}'` } },
    );
    await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('fake-claude ready')),
    );
    const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args]);
    // What a drag does on release: copy-pipe-and-cancel with no command of its own.
    expect(tmux('show-options', '-s', 'copy-command').stdout.toString()).toContain(copied);
    tmux('copy-mode', '-t', `=${started.pane}:`);
    tmux('send-keys', '-t', `=${started.pane}:`, '-X', 'history-top');
    tmux('send-keys', '-t', `=${started.pane}:`, '-X', 'select-line');
    tmux('send-keys', '-t', `=${started.pane}:`, '-X', 'copy-pipe-and-cancel');
    const read = () => {
      try {
        return Promise.resolve(readFileSync(copied, 'utf8'));
      } catch {
        return Promise.resolve('');
      }
    };
    expect(await until(read, (got) => got.includes('fake-claude ready'))).toContain('fake-claude ready');
    expect(await closePane(started.pane, settings)).toBe(true);
  });

  it('sendToPane delivers 10 KB of text without hitting tmux command length limits', async () => {
    const log = join(tempDir(), 'pane-input.txt');
    const started = await startPane(
      {
        brain: 'claude',
        cwd: tempDir(),
        command: FAKE.claude,
        env: { FAKE_PANE: '1', FAKE_PANE_LOG: log },
      },
      settings,
    );
    await until(
      () => capturePane(started.pane, settings),
      (s) => Boolean(s && text(s.lines).includes('fake-claude ready')),
    );
    const payload = `${'a'.repeat(10_240)}END-10K`;
    await sendToPane(started.pane, payload, settings);
    const read = () => {
      try {
        return Promise.resolve(readFileSync(log, 'utf8'));
      } catch {
        return Promise.resolve('');
      }
    };
    const received = await until(read, (got) => got.includes('END-10K'));
    expect(received).toBe(payload);
    expect(await closePane(started.pane, settings)).toBe(true);
  });

  it('a pane is never named by prefix: closing one leaves the others', async () => {
    expect(await closePane('claude', settings)).toBe(false);
    expect(await capturePane('claude', settings)).toBeUndefined();
  });
});

describe('the clipboard a pane copies to', () => {
  it('is pbcopy on macOS, a Wayland or X tool elsewhere, or what BRAINYARD_COPY_COMMAND says', () => {
    const bin = tempDir();
    for (const tool of ['pbcopy', 'wl-copy', 'xclip']) {
      spawnSync('sh', ['-c', `printf '#!/bin/sh\n' > '${join(bin, tool)}' && chmod +x '${join(bin, tool)}'`]);
    }
    const env = { PATH: bin };
    expect(clipboardCommand(env, 'darwin')).toBe('LC_ALL=en_US.UTF-8 pbcopy');
    expect(clipboardCommand({ ...env, WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe('wl-copy');
    expect(clipboardCommand({ ...env, DISPLAY: ':0' }, 'linux')).toBe('xclip -selection clipboard');
    // No display, no clipboard: tmux keeps the selection.
    expect(clipboardCommand(env, 'linux')).toBeUndefined();
    expect(clipboardCommand({ ...env, BRAINYARD_COPY_COMMAND: 'my-copy' }, 'darwin')).toBe('my-copy');
    expect(clipboardCommand({ ...env, BRAINYARD_COPY_COMMAND: '' }, 'darwin')).toBeUndefined();
  });
});

describe('a tmux listing', () => {
  it('splits into fields whether tmux escapes the separator (3.4) or not', () => {
    const fields = ['claude-1a2b3c4d', 'claude', 'Узел; метка', '/work/app'];
    expect(formatFields(fields.join('\u001f'))).toEqual(fields);
    expect(formatFields(fields.join('\\037'))).toEqual(fields);
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
