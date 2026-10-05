/**
 * The app on a made-up machine, in a browser: for screenshots of the README
 * and for a look at the screen without touching any real CLI, pane or store.
 *
 *   npm run demo                      # http://127.0.0.1:4848/#token=demo
 *   npm run demo -- --port 5000 --ru  # another port; the app in Russian
 *
 * Keys and clicks work as in `brainyard web`; panes are pictures that answer
 * nothing, and nothing is started, closed or stopped for real.
 */
import { parseArgs } from 'node:util';

import { emptyUsage, type PaneScreen, type SessionInfo, type SessionUsage } from '@antondanv/brainyard';
import { DEFAULT_SETTINGS } from '../packages/cli/src/tui/settings.js';
import { startWeb } from '../packages/cli/src/tui/web.js';
import { serve } from '../packages/cli/src/ui/server.js';
import { HERE, LIMITS, LIVE, NOW, PANES, SESSIONS, STATUS, USAGE } from '../packages/cli/test/tui-world.js';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '4848' }, ru: { type: 'boolean' } },
});

const ESC = '\u001b[';
const dim = (text: string) => `${ESC}2m${text}${ESC}22m`;
const bold = (text: string) => `${ESC}1m${text}${ESC}22m`;
const fg = (code: number, text: string) => `${ESC}38;5;${code}m${text}${ESC}39m`;

/** A few more sessions of the folder than the tests need: a screen with some life in it. */
const HOUR = 3_600_000;
const more = (brain: SessionInfo['brain'], id: string, title: string, ago: number): SessionInfo => ({
  brain,
  id,
  title,
  cwd: HERE,
  interactive: true,
  updatedAt: new Date(NOW - ago).toISOString(),
});
const EXTRA: SessionInfo[] = [
  more('claude', 'ffff6666-0000-4000-8000-000000000006', 'Write the release notes', 5 * HOUR),
  more('antigravity', 'gggg7777-0000-4000-8000-000000000007', 'Why is CI slow on macOS', 26 * HOUR),
  more('codex', 'hhhh8888-0000-4000-8000-000000000008', 'Upgrade the build to Node 22', 30 * HOUR),
  more('claude', 'iiii9999-0000-4000-8000-000000000009', 'Rate limiter for the public API', 3 * 24 * HOUR),
];
const counted = (session: SessionInfo, input: number, output: number, cache: number, costUsd: number | null) =>
  ({
    ...session,
    usage: { ...emptyUsage(), inputTokens: input, outputTokens: output, cacheReadTokens: cache },
    costUsd,
    costSource: costUsd === null ? null : 'estimate',
    byModel: [],
    source: session.brain === 'codex' ? 'rollout' : session.brain === 'antigravity' ? 'conversation_db' : 'transcript',
    unavailableReason: null,
  }) satisfies SessionUsage;
const DEMO_SESSIONS = [...SESSIONS, ...EXTRA];
const DEMO_USAGE: SessionUsage[] = [
  ...USAGE,
  counted(EXTRA[0]!, 3_400, 9_800, 2_100_000, 0.91),
  counted(EXTRA[1]!, 48_000, 6_200, 0, null),
  counted(EXTRA[2]!, 220_000, 31_000, 4_800_000, null),
  counted(EXTRA[3]!, 9_100, 41_000, 18_000_000, 6.37),
];

/** What each made-up CLI shows in its pane. */
const SCREENS: Record<string, string[]> = {
  'claude-1a2b3c4d': [
    fg(173, `╭${'─'.repeat(46)}╮`),
    `${fg(173, '│')} ${fg(173, '✻')} ${bold('Claude Code')}  ${dim('/work/app')}${' '.repeat(21)}${fg(173, '│')}`,
    fg(173, `╰${'─'.repeat(46)}╯`),
    '',
    `${dim('>')} Move the session store to Redis; keep the API as it is`,
    '',
    `${fg(114, '●')} I'll read the session store first.`,
    '',
    `${fg(114, '●')} ${bold('Read')}(src/auth/session.ts)`,
    `  ${dim('⎿  Read 142 lines')}`,
    '',
    `${fg(114, '●')} ${bold('Update')}(src/auth/session.ts)`,
    `  ${dim('⎿  Updated with 18 additions and 9 removals')}`,
    '',
    `${fg(114, '●')} ${bold('Bash')}(npm test -- auth)`,
    `  ${dim('⎿  Tests  41 passed (41)')}`,
    '',
    `${fg(114, '●')} The store now lives in Redis behind the same SessionStore`,
    '  interface; the tests pass. Next: the expiry job.',
    '',
    fg(240, '────────────────────────────────────────────────────'),
    `${dim('>')} `,
    fg(240, '────────────────────────────────────────────────────'),
    dim('  ⏵⏵ accept edits on · 62% of the 5h limit'),
  ],
  'codex-5e6f7a8b': [
    `${bold('>_ OpenAI Codex')} ${dim('(v0.50.0)')}`,
    dim('model: gpt-5.5   directory: /work/other'),
    '',
    `${fg(75, '›')} Upgrade the build to Node 22`,
    '',
    `${fg(114, '•')} Ran ${bold('npm test')}`,
    `  ${dim('└ 214 passed')}`,
    `${fg(114, '•')} Edited package.json ${fg(114, '+3')} ${fg(203, '-3')}`,
    '',
    `${fg(221, '▌')} ${bold('Allow command?')}`,
    `${fg(221, '▌')}   npm install --save-dev typescript@7`,
    `${fg(221, '▌')}`,
    `${fg(221, '▌')} ${fg(75, '› 1. Yes')}   2. Yes, always   3. No`,
  ],
};

function screen(pane: string): PaneScreen {
  const lines = SCREENS[pane] ?? [`${pane} ready`];
  return {
    lines,
    width: 100,
    height: 30,
    cursor: {
      x: 2,
      y: Math.max(
        0,
        lines.findIndex((line) => line.endsWith(`${dim('>')} `)),
      ),
      visible: true,
    },
    historySize: 0,
    scrollOffset: 0,
    mouseTracking: false,
    mouseSgr: false,
    alternate: false,
  };
}

const web = startWeb({
  cwd: HERE,
  clock: () => NOW,
  settings: { ...DEFAULT_SETTINGS, language: values.ru ? 'ru' : 'en' },
  settingsFile: '~/.config/brainyard/app.json',
  sources: {
    status: async () => STATUS,
    limits: async () => LIMITS,
    panes: async () => ({ tmux: true, panes: PANES }),
    live: async () => LIVE,
    sessions: async () => DEMO_SESSIONS,
    usage: async () => DEMO_USAGE,
    capture: async (pane) => screen(pane),
    resize: async () => true,
    send: async () => undefined,
    startPane: async () => {
      throw new Error('the demo starts nothing');
    },
    closePane: async () => false,
    stopSession: async () => 'not-running',
    saveSettings: () => undefined,
  },
  onQuit: () => process.exit(0),
});
const server = await serve({ port: Number(values.port), token: 'demo', app: web });
process.stdout.write(`Brainyard demo — Ctrl+C to stop\n  ${server.url}\n`);
