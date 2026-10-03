import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const panes = vi.hoisted(() => ({ listPanes: vi.fn(), capturePane: vi.fn() }));
vi.mock('../src/panes.js', async (original) => ({
  ...(await original<typeof import('../src/panes.js')>()),
  ...panes,
}));

import { liveSessions } from '../src/sessions.js';
import { tempDir } from './helpers.js';

const line = (type: string, payload: Record<string, unknown>) => `${JSON.stringify({ type, payload })}\n`;
const event = (type: string, extra: Record<string, unknown> = {}) => line('event_msg', { type, ...extra });
const call = (name: string, callId: string) => line('response_item', { type: 'function_call', name, call_id: callId });
const answer = (callId: string) =>
  line('response_item', { type: 'function_call_output', call_id: callId, output: '{}' });

function rollout(body: string) {
  const home = tempDir();
  const cwd = tempDir();
  const day = join(home, 'sessions', '2026', '10', '03');
  mkdirSync(day, { recursive: true });
  const path = join(day, 'rollout-test-codex-session.jsonl');
  const meta = line('session_meta', { id: 'codex-session', cwd, source: 'cli' });
  writeFileSync(path, meta + body);
  const options = { cwd, brains: ['codex'], homes: { codex: home } };
  const state = async () => (await liveSessions(options))[0]?.live;
  return { home, cwd, path, meta, options, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  panes.listPanes.mockResolvedValue([]);
  panes.capturePane.mockResolvedValue(undefined);
});

describe('Codex live turns', () => {
  it('sees work after the opening event leaves the last 32 KB, including the first poll', async () => {
    const log = rollout(event('task_started') + line('response_item', { type: 'message', text: 'x'.repeat(96_000) }));
    expect(await log.state()).toMatchObject({ status: 'busy' });
    appendFileSync(log.path, line('response_item', { type: 'message', text: 'x'.repeat(96_000) }));
    expect(await log.state()).toMatchObject({ status: 'busy' });
    appendFileSync(log.path, event('task_complete'));
    expect(await log.state()).toBeUndefined();
  });

  it('tracks real request_user_input calls until their matching answer, without latching waiting', async () => {
    const log = rollout(event('task_started') + call('request_user_input', 'question'));
    expect(await log.state()).toMatchObject({ status: 'waiting', waitingFor: 'input' });
    appendFileSync(log.path, event('token_count'));
    expect(await log.state()).toMatchObject({ status: 'waiting' });
    appendFileSync(log.path, answer('question'));
    expect(await log.state()).toEqual({ status: 'busy', kind: 'interactive' });
    appendFileSync(log.path, event('task_complete'));
    expect(await log.state()).toBeUndefined();
  });

  it('keeps another outstanding question waiting when only one has been answered', async () => {
    const log = rollout(event('task_started') + call('request_user_input', 'a') + call('request_user_input', 'b'));
    appendFileSync(log.path, answer('a'));
    expect(await log.state()).toMatchObject({ status: 'waiting' });
    appendFileSync(log.path, answer('b'));
    expect(await log.state()).toMatchObject({ status: 'busy' });
  });

  it.each(['exec_approval_response', 'exec_command_begin', 'exec_command_end'])(
    'clears a matching legacy approval on %s',
    async (type) => {
      const log = rollout(event('task_started') + event('exec_approval_request', { call_id: 'cmd' }));
      expect(await log.state()).toMatchObject({ status: 'waiting', waitingFor: 'approval' });
      appendFileSync(log.path, event(type, { call_id: 'cmd' }));
      expect(await log.state()).toEqual({ status: 'busy', kind: 'interactive' });
    },
  );

  it('accepts resumed work for legacy requests that had no call id', async () => {
    const log = rollout(event('task_started') + event('exec_approval_request') + event('agent_reasoning'));
    expect(await log.state()).toMatchObject({ status: 'busy' });
  });

  it('ignores late completion from a previous turn and clears waiting on abort or a new turn', async () => {
    const log = rollout(event('task_started', { turn_id: 'new' }) + call('request_user_input', 'question'));
    appendFileSync(log.path, event('task_complete', { turn_id: 'old' }));
    expect(await log.state()).toMatchObject({ status: 'waiting' });
    appendFileSync(log.path, event('turn_aborted', { turn_id: 'new' }));
    expect(await log.state()).toBeUndefined();
    appendFileSync(log.path, event('task_started', { turn_id: 'next' }));
    expect(await log.state()).toMatchObject({ status: 'busy' });
  });

  it('waits for complete JSON lines and invalidates a replaced or truncated rollout', async () => {
    const log = rollout(event('task_started'));
    expect(await log.state()).toMatchObject({ status: 'busy' });
    const pending = call('request_user_input', 'question');
    appendFileSync(log.path, pending.slice(0, 35));
    expect(await log.state()).toMatchObject({ status: 'busy' });
    appendFileSync(log.path, pending.slice(35));
    expect(await log.state()).toMatchObject({ status: 'waiting' });
    writeFileSync(log.path, log.meta + event('task_started') + event('task_complete'));
    expect(await log.state()).toBeUndefined();
    writeFileSync(log.path + '.new', log.meta + event('task_started'));
    renameSync(log.path + '.new', log.path);
    expect(await log.state()).toMatchObject({ status: 'busy' });
  });
});

describe('Codex approval dialogs in Brainyard panes', () => {
  const approval = [
    'Would you like to run the following command?',
    '$ /bin/sleep 20',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again (p)",
    'Press enter to confirm or esc to cancel',
  ];
  const working = [
    '✔ You approved codex to run /bin/sleep 20 this time',
    '• Working (8s • esc to interrupt)',
    '› Ask Codex to do anything',
    '? for shortcuts',
  ];

  it('sees an approval omitted from the rollout and clears it as soon as the command runs', async () => {
    const log = rollout(event('task_started'));
    panes.listPanes.mockResolvedValue([
      { pane: 'codex-test', brain: 'codex', sessionId: 'codex-session', cwd: log.cwd },
    ]);
    panes.capturePane.mockResolvedValue({ lines: approval });
    const options = { ...log.options, panes: { socket: 'brainyard-codex-test' } };
    expect((await liveSessions(options))[0]?.live).toMatchObject({ status: 'waiting', waitingFor: 'approval' });
    panes.capturePane.mockResolvedValue({ lines: working });
    expect((await liveSessions(options))[0]?.live).toEqual({ status: 'busy', kind: 'interactive' });
    appendFileSync(log.path, event('task_complete'));
    panes.capturePane.mockResolvedValue({
      lines: ['• STATUS_TEST_DONE', '› Ask Codex to do anything', '? for shortcuts'],
    });
    expect(await liveSessions(options)).toEqual([]);
  });

  it('uses only the current approval footer, skips other CLIs and does not capture panes unless requested', async () => {
    const log = rollout(event('task_started'));
    panes.listPanes.mockResolvedValue([
      { pane: 'codex-test', brain: 'codex', sessionId: 'codex-session' },
      { pane: 'claude-test', brain: 'claude', sessionId: 'other' },
    ]);
    await log.state();
    expect(panes.listPanes).not.toHaveBeenCalled();
    panes.capturePane.mockResolvedValue({ lines: [...approval, ...working] });
    const options = { ...log.options, panes: { socket: 'brainyard-codex-test' } };
    expect((await liveSessions(options))[0]?.live).toMatchObject({ status: 'busy' });
    expect(panes.capturePane.mock.calls.map((args) => args[0])).toEqual(['codex-test']);
  });
});
