/** A machine for the app's tests: four CLIs, their limits, two panes, sessions here and elsewhere. */
import {
  BRAINS,
  type BrainId,
  type BrainStatus,
  type BrainUsage,
  emptyUsage,
  type SessionInfo,
  type SessionUsage,
  type StatusReport,
} from '@antondanv/brainyard';

import type { PaneRow } from '../src/panes.js';
import { type Data, initialState, type State } from '../src/tui/state.js';

export const NOW = Date.parse('2026-10-04T12:00:00Z');
export const HERE = '/work/app';
const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MB = 1024 * 1024;

function brain(id: BrainId, over: Partial<BrainStatus>): BrainStatus {
  const info = BRAINS[id];
  return {
    id,
    label: info.label,
    vendor: info.vendor,
    binary: info.binary,
    homepage: info.homepage,
    capabilities: info.capabilities,
    availability: 'ready',
    summary: '',
    installed: true,
    auth: { state: 'logged_in' },
    checkedAt: iso(NOW),
    ...over,
  };
}

export const STATUS: StatusReport = {
  brains: [
    brain('claude', {
      version: '2.1.999',
      auth: { state: 'logged_in', method: 'claude.ai', plan: 'max', account: 'j***@example.com' },
    }),
    brain('codex', { version: '0.50.0', auth: { state: 'logged_in', method: 'ChatGPT' }, defaultModel: 'gpt-5.5' }),
    brain('antigravity', {
      version: '1.2.0',
      auth: { state: 'logged_in', detail: 'model list fetched with your account' },
    }),
    brain('opencode', {
      availability: 'not_installed',
      installed: false,
      auth: { state: 'unknown' },
      fix: 'npm install -g opencode-ai',
    }),
  ],
  ready: ['claude', 'codex', 'antigravity'],
  checkedAt: iso(NOW),
  brainyard: '0.2.0',
  node: 'v22.0.0',
  platform: 'darwin-arm64',
};

const seconds = (ms: number) => Math.round(ms / 1000);

export const LIMITS: BrainUsage[] = [
  { brain: 'claude', limits: null, limitsSource: null, limitsObservedAt: null, limitsUnavailable: 'not_requested' },
  {
    brain: 'codex',
    limits: [
      { window: 'primary', utilization: 0.34, windowMinutes: 300, resetsAt: seconds(NOW + 2 * HOUR) },
      { window: 'secondary', utilization: 0.92, windowMinutes: 10_080, resetsAt: seconds(NOW + 99 * HOUR) },
    ],
    limitsSource: 'rollout',
    limitsObservedAt: iso(NOW - 3 * HOUR),
    limitsUnavailable: null,
  },
  {
    brain: 'antigravity',
    limits: [
      { window: 'weekly', utilization: 0.01, windowMinutes: 10_080, group: 'Gemini' },
      { window: 'weekly', utilization: 0.4, windowMinutes: 10_080, group: 'Claude and GPT' },
    ],
    limitsSource: 'cli',
    limitsObservedAt: iso(NOW),
    limitsUnavailable: null,
  },
  {
    brain: 'opencode',
    limits: null,
    limitsSource: null,
    limitsObservedAt: null,
    limitsUnavailable: 'missing',
    detail: 'no OpenCode Go key',
  },
];

const pane = (over: Partial<PaneRow> & { pane: string }): PaneRow => ({
  attached: false,
  width: 100,
  height: 30,
  ...over,
});

export const PANES: PaneRow[] = [
  pane({
    pane: 'claude-1a2b3c4d',
    brain: 'claude',
    sessionId: 'aaaa1111-0000-4000-8000-000000000001',
    cwd: HERE,
    label: 'auth refactor',
    startedAt: iso(NOW - HOUR),
    activityAt: iso(NOW - 5_000),
    memory: 285 * MB,
  }),
  pane({
    pane: 'codex-5e6f7a8b',
    brain: 'codex',
    sessionId: 'bbbb2222-0000-4000-8000-000000000002',
    cwd: '/work/other',
    startedAt: iso(NOW - 2 * HOUR),
    activityAt: iso(NOW - 12 * MINUTE),
    memory: 120 * MB,
  }),
];

const session = (over: Partial<SessionInfo> & Pick<SessionInfo, 'brain' | 'id'>): SessionInfo => ({
  interactive: true,
  cwd: HERE,
  ...over,
});

export const LIVE: SessionInfo[] = [
  session({ brain: 'claude', id: PANES[0]!.sessionId!, live: { status: 'busy', kind: 'interactive' } }),
  session({
    brain: 'codex',
    id: PANES[1]!.sessionId!,
    cwd: '/work/other',
    live: { status: 'waiting', kind: 'interactive', waitingFor: 'approval' },
  }),
  session({
    brain: 'claude',
    id: 'cccc3333-0000-4000-8000-000000000003',
    cwd: '/work/other',
    title: 'Nightly cleanup',
    background: true,
    updatedAt: iso(NOW - 3 * MINUTE),
    live: { status: 'busy', kind: 'background', shortId: 'cccc3333', state: 'working' },
  }),
];

export const SESSIONS: SessionInfo[] = [
  session({ brain: 'claude', id: PANES[0]!.sessionId!, title: 'Auth refactor', updatedAt: iso(NOW - MINUTE) }),
  session({
    brain: 'claude',
    id: 'dddd4444-0000-4000-8000-000000000004',
    title: 'Fix the flaky test',
    updatedAt: iso(NOW - 3 * HOUR),
  }),
  session({
    brain: 'codex',
    id: 'eeee5555-0000-4000-8000-000000000005',
    title: 'Explain CRDTs',
    updatedAt: iso(NOW - 48 * HOUR),
  }),
];

function counted(base: SessionInfo, input: number, output: number, costUsd: number | null, cache = 0): SessionUsage {
  return {
    ...base,
    usage: { ...emptyUsage(), inputTokens: input, outputTokens: output, cacheReadTokens: cache },
    costUsd,
    costSource: costUsd === null ? null : 'cli',
    byModel: [],
    source: base.brain === 'codex' ? 'rollout' : 'transcript',
    unavailableReason: null,
  };
}

export const USAGE: SessionUsage[] = [
  counted(SESSIONS[0]!, 1_200, 34_000, 4.21, 31_000_000),
  counted(SESSIONS[1]!, 950, 120, 0.02),
  counted(SESSIONS[2]!, 12_000, 3_400, null),
];

export function data(over: Partial<Data> = {}): Data {
  return {
    status: STATUS,
    limits: LIMITS,
    tmux: true,
    panes: PANES,
    live: LIVE,
    sessions: SESSIONS,
    usage: USAGE,
    errors: {},
    ...over,
  };
}

/** The app in `HERE` at `NOW`, 100×32 unless said otherwise. */
export function world(over: Partial<State> = {}, with_: Partial<Data> = {}): State {
  return {
    ...initialState({ cwd: HERE, version: '0.2.0', width: 100, height: 32, now: NOW }),
    data: data(with_),
    ...over,
  };
}
