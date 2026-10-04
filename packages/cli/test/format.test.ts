import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PaneInfo } from '@antondanv/brainyard';
import { describe, expect, it } from 'vitest';

import { Failure, UsageError } from '../src/args.js';
import { ago, bytes, money, shortPath, tokens, until, windowName } from '../src/format.js';
import { keyBytes, paneLines, resolvePane } from '../src/panes.js';
import { sessionLines } from '../src/sessions.js';
import { paint } from '../src/term.js';
import { limitLines } from '../src/usage.js';

const plain = paint(process.stdout, false);
const NOW = Date.parse('2026-10-04T12:00:00Z');

describe('printed numbers', () => {
  it('says how long ago in the largest whole unit', () => {
    expect(ago(NOW - 30_000, NOW)).toBe('now');
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(ago(NOW - 2 * 86_400_000, NOW)).toBe('2d');
  });

  it('keeps the end of a long path, where the folder is named', () => {
    expect(shortPath('/a/b', 10)).toBe('/a/b');
    expect(shortPath('~/Projects/Brainyard-cli', 14)).toBe('…Brainyard-cli');
  });

  it('prints tokens, dollars and the time left before a reset', () => {
    expect([tokens(950), tokens(1234), tokens(34_000), tokens(8_100_000), tokens(2_000_000_000)]).toEqual([
      '950',
      '1.2k',
      '34k',
      '8.1M',
      '2B',
    ]);
    expect([money(4.214), money(0.00051), money(0)]).toEqual(['$4.21', '$0.0005', '$0.00']);
    expect(until(NOW + 35 * 60_000, NOW)).toBe('35m');
    expect(until(NOW + 130 * 60_000, NOW)).toBe('2h 10m');
    expect(until(NOW + 99 * 3_600_000, NOW)).toBe('4d 3h');
    expect(until(NOW - 1000, NOW)).toBe('now');
  });

  it('names a limit window by its length where the CLI gives one', () => {
    expect(windowName({ window: 'primary', windowMinutes: 300 })).toBe('5h');
    expect(windowName({ window: 'secondary', windowMinutes: 10_080 })).toBe('weekly');
    expect(windowName({ window: 'five_hour' })).toBe('five-hour');
    expect(windowName({ window: 'monthly' })).toBe('monthly');
  });

  it('prints sizes with one decimal below ten', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(412 * 1024 * 1024)).toBe('412 MB');
    expect(bytes(1.3 * 1024 ** 3)).toBe('1.3 GB');
  });
});

describe('keys by name', () => {
  it('knows what a terminal sends for them', () => {
    expect(keyBytes('enter')).toBe('\r');
    expect(keyBytes('ESC')).toBe('\u001b');
    expect(keyBytes('shift-tab')).toBe('\u001b[Z');
    expect(keyBytes('up')).toBe('\u001b[A');
    expect(keyBytes('ctrl-c')).toBe('\u0003');
    expect(keyBytes('ctrl-d')).toBe('\u0004');
    expect(keyBytes('hyper-x')).toBeUndefined();
    expect(keyBytes('toString')).toBeUndefined();
  });
});

describe('naming a pane', () => {
  const panes: PaneInfo[] = [
    {
      pane: 'claude-1a2b3c4d',
      sessionId: '2dcf2506-5700-4147-8a45-db15a90ff48f',
      attached: false,
      width: 80,
      height: 24,
    },
    {
      pane: 'claude-1a9f0000',
      sessionId: 'aaaa0000-0000-4000-8000-000000000001',
      attached: false,
      width: 80,
      height: 24,
    },
    { pane: 'codex-0f0f0f0f', attached: false, width: 80, height: 24 },
  ];

  it('takes the exact name, or the start of a name or of a session id when only one fits', () => {
    expect(resolvePane('codex-0f0f0f0f', panes).pane).toBe('codex-0f0f0f0f');
    expect(resolvePane('claude-1a2', panes).pane).toBe('claude-1a2b3c4d');
    expect(resolvePane('codex', panes).pane).toBe('codex-0f0f0f0f');
    expect(resolvePane('2dcf2506', panes).pane).toBe('claude-1a2b3c4d');
  });

  it('refuses a name that fits several, and says when none fits', () => {
    expect(() => resolvePane('claude-1a', panes)).toThrow(UsageError);
    expect(() => resolvePane('claude-1a', panes)).toThrow(/fits 2 panes: claude-1a2b3c4d, claude-1a9f0000/);
    expect(() => resolvePane('gemini', panes)).toThrow(Failure);
    expect(() => resolvePane('', panes)).toThrow(UsageError);
  });
});

describe('the list of panes', () => {
  it('lines up name, CLI, session, memory, state, folder and label', () => {
    const lines = paneLines(
      [
        {
          pane: 'claude-1a2b3c4d',
          brain: 'claude',
          sessionId: '2dcf2506-5700-4147-8a45-db15a90ff48f',
          label: 'Brainyard · CLI',
          cwd: join(homedir(), 'code', 'app'),
          activityAt: new Date(NOW - 5 * 60_000).toISOString(),
          attached: false,
          width: 80,
          height: 24,
          memory: 412 * 1024 * 1024,
        },
        {
          pane: 'codex-0f0f0f0f',
          brain: 'codex',
          activityAt: new Date(NOW - 10_000).toISOString(),
          attached: true,
          width: 80,
          height: 24,
        },
        {
          pane: 'agy-00000000',
          brain: 'antigravity',
          activityAt: new Date(NOW).toISOString(),
          attached: false,
          width: 80,
          height: 24,
        },
      ],
      plain,
      NOW,
    );
    expect(lines).toEqual([
      'claude-1a2b3c4d  Claude Code  2dcf2506  412 MB  quiet 5m  ~/code/app  Brainyard · CLI',
      'codex-0f0f0f0f   Codex        —                 attached',
      'agy-00000000     Antigravity  —                 active',
    ]);
  });
});

describe('the list of sessions', () => {
  it('marks what runs, what waits, how a background one ended and its pane', () => {
    const at = new Date(NOW - 3 * 3_600_000).toISOString();
    const saved = sessionLines(
      [
        { brain: 'claude', id: 'aaaaaaaa-0000', title: 'Plan the CLI', interactive: true, updatedAt: at },
        {
          brain: 'codex',
          id: 'bbbbbbbb-0000',
          interactive: true,
          live: { status: 'busy', kind: 'interactive' },
          updatedAt: at,
        },
        {
          brain: 'claude',
          id: 'cccccccc-0000',
          title: 'deploy',
          interactive: true,
          background: true,
          live: { status: 'idle', kind: 'background', state: 'done' },
        },
        {
          brain: 'claude',
          id: 'dddddddd-0000',
          title: 'review',
          interactive: true,
          live: { status: 'waiting', kind: 'interactive', waitingFor: 'approve Bash' },
        },
        { brain: 'codex', id: 'eeeeeeee-0000', title: 'exec run', interactive: false },
      ],
      plain,
      { now: NOW, panes: new Map([['dddddddd-0000', 'claude-1a2b3c4d']]) },
    );
    expect(saved).toEqual([
      'Claude Code  aaaaaaaa  3h       Plan the CLI',
      'Codex        bbbbbbbb  3h       (untitled) ● working',
      'Claude Code  cccccccc           deploy bg ● done',
      'Claude Code  dddddddd           review ● waiting: approve Bash ▣ claude-1a2b3c4d',
      'Codex        eeeeeeee           exec run headless',
    ]);
  });

  it('shows the folder in a list of the whole machine', () => {
    const [line] = sessionLines(
      [
        {
          brain: 'claude',
          id: 'aaaaaaaa-0000',
          title: 'tests',
          cwd: join(homedir(), 'code', 'app'),
          interactive: true,
        },
      ],
      plain,
      { folders: true, now: NOW },
    );
    expect(line).toBe('Claude Code  aaaaaaaa           ~/code/app  tests');
  });
});

describe('the subscription limits', () => {
  it('put a model pool to a line, flag what is nearly used up and say why a CLI has none', () => {
    const resets = Math.floor((NOW + 130 * 60_000) / 1000);
    const lines = limitLines(
      [
        {
          brain: 'claude',
          limits: null,
          limitsSource: null,
          limitsObservedAt: null,
          limitsUnavailable: 'not_requested',
        },
        {
          brain: 'codex',
          limits: [
            { window: 'primary', utilization: 0.23, windowMinutes: 300, resetsAt: resets, limitId: 'codex' },
            { window: 'secondary', utilization: 0.92, windowMinutes: 10_080, limitId: 'codex' },
          ],
          limitsSource: 'rollout',
          limitsObservedAt: new Date(NOW - 12 * 60_000).toISOString(),
          limitsUnavailable: null,
        },
        {
          brain: 'antigravity',
          limits: [
            { window: '5h', utilization: 0, windowMinutes: 300, group: 'Gemini Models', limitId: 'gemini-5h' },
            { window: '5h', utilization: 0.5, windowMinutes: 300, group: 'Claude and GPT', limitId: 'other-5h' },
          ],
          limitsSource: 'cli',
          limitsObservedAt: new Date(NOW).toISOString(),
          limitsUnavailable: null,
        },
        {
          brain: 'opencode',
          limits: null,
          limitsSource: null,
          limitsObservedAt: null,
          limitsUnavailable: 'missing',
          detail: 'No OpenCode Go key.',
        },
      ],
      plain,
      NOW,
    );
    expect(lines).toEqual([
      'Claude Code  not checked: --live asks with one tiny real call, which may cost',
      'Codex        5h 23% · resets in 2h 10m   weekly 92%   seen 12m ago',
      'Antigravity  Gemini Models: 5h 0%',
      '             Claude and GPT: 5h 50%',
      'OpenCode     No OpenCode Go key.',
    ]);
  });

  it('say a window has reset since it was seen, instead of its old share', () => {
    const past = Math.floor((NOW - 60 * 60_000) / 1000);
    const later = Math.floor((NOW + 36 * 3_600_000) / 1000);
    const lines = limitLines(
      [
        {
          brain: 'claude',
          limits: [
            { window: 'five_hour', utilization: 0.62, windowMinutes: 300, resetsAt: past },
            { window: 'seven_day', utilization: 1, windowMinutes: 10_080, resetsAt: later },
          ],
          limitsSource: 'cache',
          limitsObservedAt: new Date(NOW - 7 * 3_600_000).toISOString(),
          limitsUnavailable: null,
        },
      ],
      plain,
      NOW,
    );
    expect(lines).toEqual(['Claude Code  5h reset since seen   weekly 100% · resets in 1d 12h   seen 7h ago']);
  });
});
