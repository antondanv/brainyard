import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PaneInfo } from '@antondanv/brainyard';
import { describe, expect, it } from 'vitest';

import { Failure, UsageError } from '../src/args.js';
import { ago, bytes, shortPath } from '../src/format.js';
import { keyBytes, paneLines, resolvePane } from '../src/panes.js';
import { sessionLines } from '../src/sessions.js';
import { paint } from '../src/term.js';

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
