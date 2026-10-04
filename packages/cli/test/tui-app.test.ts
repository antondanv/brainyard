import { BrainyardError, type PaneStart } from '@antondanv/brainyard';
import { describe, expect, it, vi } from 'vitest';

import type { PaneRow } from '../src/panes.js';
import { type App, type AppHost, type Sources, startApp } from '../src/tui/app.js';
import { HERE, LIMITS, LIVE, NOW, PANES, SESSIONS, STATUS, USAGE } from './tui-world.js';

/** The app over stand-in sources and a host that records frames and attachments. */
function harness(over: Partial<Sources> = {}) {
  let panes: PaneRow[] = [...PANES];
  const frames: string[][] = [];
  const attached: string[] = [];
  let quit = false;
  const sources: Sources = {
    status: async () => STATUS,
    limits: async () => LIMITS,
    panes: vi.fn(async () => ({ tmux: true, panes })),
    live: async () => LIVE,
    sessions: async () => SESSIONS,
    usage: async () => USAGE,
    startPane: vi.fn(async (options): Promise<PaneStart> => {
      const pane = `${options.brain}-00000001`;
      panes = [{ pane, brain: options.brain, cwd: options.cwd, attached: false, width: 80, height: 24 }, ...panes];
      return { pane, brain: options.brain, startedAt: new Date(NOW).toISOString(), warnings: [], display: '' };
    }),
    closePane: vi.fn(async (pane: string) => {
      const had = panes.some((row) => row.pane === pane);
      panes = panes.filter((row) => row.pane !== pane);
      return had;
    }),
    stopSession: vi.fn(async () => 'stopped' as const),
    ...over,
  };
  const host: AppHost = {
    draw: (lines) => frames.push(lines),
    attach: async (pane) => {
      attached.push(pane);
    },
    quit: () => {
      quit = true;
    },
  };
  const app = startApp({
    cwd: HERE,
    version: '0.2.0',
    width: 110,
    height: 34,
    colour: false,
    host,
    sources,
    // Nothing is read again on its own during a test.
    every: { panes: 1e9, live: 1e9, sessions: 1e9, usage: 1e9, limits: 1e9, status: 1e9 },
    clock: () => NOW,
  });
  const screen = () => (frames.at(-1) ?? []).join('\n');
  return { app, sources, frames, attached, screen, quit: () => quit, setPanes: (rows: PaneRow[]) => (panes = rows) };
}

async function keys(app: App, ...names: string[]): Promise<void> {
  for (const key of names) {
    app.dispatch({ kind: 'key', key });
    await app.idle();
  }
}

describe('the app at run time', () => {
  it('reads every source and draws what it read', async () => {
    const { app, screen } = harness();
    await app.idle();
    expect(screen()).toContain('Panes · 2');
    expect(screen()).toContain('› claude-1a2b3c4d');
    expect(screen()).toContain('5h 34% · resets in 2h');
    expect(screen()).toContain('Sessions of /work/app · 3 · $4.23 + 1 unpriced');
    app.stop();
  });

  it('Enter hands the screen to the pane, then reads the panes again', async () => {
    const { app, attached, sources } = harness();
    await app.idle();
    const before = vi.mocked(sources.panes).mock.calls.length;
    await keys(app, 'enter');
    expect(attached).toEqual(['claude-1a2b3c4d']);
    expect(vi.mocked(sources.panes).mock.calls.length).toBe(before + 1);
    app.stop();
  });

  it('n starts a pane at the size of the screen, goes into it and selects it after', async () => {
    const { app, attached, sources, screen } = harness();
    await app.idle();
    await keys(app, 'n', 'right', 'enter');
    expect(sources.startPane).toHaveBeenCalledWith({ brain: 'codex', cwd: HERE, width: 110, height: 34 });
    expect(attached).toEqual(['codex-00000001']);
    expect(screen()).toContain('› codex-00000001');
    expect(app.state().busy).toBeUndefined();
    app.stop();
  });

  it('r continues a saved session in its own folder', async () => {
    const { app, sources } = harness();
    await app.idle();
    app.dispatch({ kind: 'select', key: 'session:claude:dddd4444-0000-4000-8000-000000000004' });
    await keys(app, 'r');
    expect(sources.startPane).toHaveBeenCalledWith({
      brain: 'claude',
      cwd: HERE,
      resume: 'dddd4444-0000-4000-8000-000000000004',
      width: 110,
      height: 34,
    });
    app.stop();
  });

  it('x and y close the pane and say so; s and y stop a background session', async () => {
    const { app, sources, screen } = harness();
    await app.idle();
    await keys(app, 'x', 'y');
    expect(sources.closePane).toHaveBeenCalledWith('claude-1a2b3c4d');
    expect(screen()).toContain('closed claude-1a2b3c4d · what was said in it stays');
    expect(screen()).toContain('Panes · 1');

    app.dispatch({ kind: 'select', key: 'running:claude:cccc3333-0000-4000-8000-000000000003' });
    await keys(app, 's', 'y');
    expect(sources.stopSession).toHaveBeenCalledWith({
      brain: 'claude',
      sessionId: 'cccc3333-0000-4000-8000-000000000003',
      cwd: '/work/other',
    });
    expect(screen()).toContain('stopped cccc3333');
    app.stop();
  });

  it('a pane that cannot start says why, with the fix', async () => {
    const { app, attached, screen } = harness({
      startPane: async () => {
        throw new BrainyardError('not_installed', 'panes need tmux', { fix: 'brew install tmux' });
      },
    });
    await app.idle();
    await keys(app, 'n', 'enter');
    expect(attached).toEqual([]);
    expect(screen()).toContain('panes need tmux → brew install tmux');
    app.stop();
  });

  it('a source that fails shows its reason and the rest still draws', async () => {
    const { app, screen } = harness({
      live: async () => {
        throw new Error('claude agents timed out');
      },
    });
    await app.idle();
    expect(screen()).toContain('Panes · 2');
    expect(app.state().data.errors.live).toBe('claude agents timed out');
    app.stop();
  });

  it('q stops reading and hands back to the host', async () => {
    const { app, quit, frames } = harness();
    await app.idle();
    await keys(app, 'q');
    expect(quit()).toBe(true);
    const drawn = frames.length;
    app.dispatch({ kind: 'key', key: 'down' });
    await app.idle();
    expect(frames.length).toBe(drawn);
  });
});
