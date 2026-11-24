import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { lastMessage } from '../src/index.js';
import { claudeProjectDir, openSqlite } from '../src/sessions.js';
import { openStore } from './fixtures/opencode-store.mjs';
import { tempDir } from './helpers.js';

const lines = (...entries: unknown[]) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

function project(): string {
  return realpathSync(tempDir('brainyard-msg-project-'));
}

function writeClaude(home: string, cwd: string, id: string, entries: unknown[]): void {
  const dir = join(home, 'projects', claudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines(...entries));
}

function writeCodex(home: string, id: string, entries: unknown[], day = ['2026', '11', '24']): void {
  const dir = join(home, 'sessions', ...day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-11-24T10-00-00-${id}.jsonl`), lines(...entries));
}

const hasSqlite = (await openSqlite()) !== undefined;

describe('lastMessage: Claude Code', () => {
  it('returns the last assistant text after the last real user prompt, skipping tool_result and sidechains', async () => {
    const home = tempDir();
    const cwd = project();
    const id = '11111111-0000-4000-8000-000000000001';
    writeClaude(home, cwd, id, [
      {
        type: 'user',
        isSidechain: false,
        timestamp: '2026-11-24T10:00:00.000Z',
        message: { role: 'user', content: 'Run the check and explain' },
      },
      {
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-11-24T10:00:01.000Z',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'Текст A' }] },
      },
      {
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-11-24T10:00:02.000Z',
        message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        isSidechain: false,
        timestamp: '2026-11-24T10:00:03.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }] },
      },
      {
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-11-24T10:00:04.000Z',
        message: { id: 'msg_2', content: [{ type: 'thinking', thinking: 'hmm' }] },
      },
      {
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-11-24T10:00:05.000Z',
        message: { id: 'msg_2', content: [{ type: 'text', text: '  Текст B  ' }] },
      },
      {
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-11-24T10:00:06.000Z',
        message: { id: 'msg_side', content: [{ type: 'text', text: 'Sidechain note' }] },
      },
    ]);

    expect(await lastMessage('claude', id, { homes: { claude: home } })).toEqual({
      text: 'Текст B',
      at: '2026-11-24T10:00:05.000Z',
    });
  });

  it('joins multiple text entries sharing the same message.id', async () => {
    const home = tempDir();
    const id = '11111111-0000-4000-8000-000000000002';
    writeClaude(home, project(), id, [
      { type: 'user', isSidechain: false, message: { role: 'user', content: 'Explain both' } },
      {
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-11-24T10:01:00.000Z',
        message: { id: 'msg_join', content: [{ type: 'text', text: 'Part 1' }] },
      },
      {
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-11-24T10:01:01.000Z',
        message: { id: 'msg_join', content: [{ type: 'text', text: 'Part 2' }] },
      },
    ]);

    expect(await lastMessage('claude', id, { homes: { claude: home } })).toEqual({
      text: 'Part 1\n\nPart 2',
      at: '2026-11-24T10:01:01.000Z',
    });
  });

  it('returns undefined when only tool_use follows the last user prompt', async () => {
    const home = tempDir();
    const id = '11111111-0000-4000-8000-000000000003';
    writeClaude(home, project(), id, [
      { type: 'user', isSidechain: false, message: { role: 'user', content: 'First prompt' } },
      {
        type: 'assistant',
        isSidechain: false,
        message: { id: 'msg_old', content: [{ type: 'text', text: 'Earlier turn answer' }] },
      },
      { type: 'user', isSidechain: false, message: { role: 'user', content: 'Second prompt' } },
      {
        type: 'assistant',
        isSidechain: false,
        message: { id: 'msg_new', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      },
    ]);

    expect(await lastMessage('claude', id, { homes: { claude: home } })).toBeUndefined();
  });

  it('reads a 1 MB transcript from the tail and returns a 100 KB message whole', async () => {
    const home = tempDir();
    const id = '11111111-0000-4000-8000-000000000004';
    const padding = 'p'.repeat(40_000);
    const filler = Array.from({ length: 28 }, (_, i) => ({
      type: 'assistant',
      isSidechain: false,
      message: { id: `old_${i}`, content: [{ type: 'text', text: padding }] },
    }));
    const big = `${'Ж'.repeat(50_000)}END`; // >100 KB in UTF-8
    writeClaude(home, project(), id, [
      { type: 'user', isSidechain: false, message: { role: 'user', content: 'Old prompt' } },
      ...filler,
      { type: 'user', isSidechain: false, message: { role: 'user', content: 'Final prompt' } },
      {
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-11-24T10:05:00.000Z',
        message: { id: 'msg_big', content: [{ type: 'text', text: big }] },
      },
    ]);

    const got = await lastMessage('claude', id, { homes: { claude: home } });
    expect(got?.text).toBe(big);
    expect(Buffer.byteLength(got!.text, 'utf8')).toBeGreaterThan(100_000);
    expect(got?.at).toBe('2026-11-24T10:05:00.000Z');
  });

  it('finds a session saved under any project folder (e.g. a worktree)', async () => {
    const home = tempDir();
    const id = '11111111-0000-4000-8000-000000000005';
    writeClaude(home, '/somewhere/else/worktree-42', id, [
      { type: 'user', isSidechain: false, message: { role: 'user', content: 'Hi' } },
      {
        type: 'assistant',
        isSidechain: false,
        message: { id: 'msg_wt', content: [{ type: 'text', text: 'From worktree' }] },
      },
    ]);

    expect(await lastMessage('claude', id, { homes: { claude: home } })).toEqual({ text: 'From worktree' });
  });
});

describe('lastMessage: Codex', () => {
  it('prefers task_complete.last_agent_message when present', async () => {
    const home = tempDir();
    const id = '019f0000-0000-7000-8000-000000000001';
    writeCodex(home, id, [
      { type: 'session_meta', payload: { id, cwd: project(), source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      {
        type: 'response_item',
        timestamp: '2026-11-24T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'Checking files…' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-11-24T10:00:05.000Z',
        payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '  Done and verified.  ' },
      },
    ]);

    expect(await lastMessage('codex', id, { homes: { codex: home } })).toEqual({
      text: 'Done and verified.',
      at: '2026-11-24T10:00:05.000Z',
    });
  });

  it('without task_complete, picks final_answer over commentary', async () => {
    const home = tempDir();
    const id = '019f0000-0000-7000-8000-000000000002';
    writeCodex(home, id, [
      { type: 'session_meta', payload: { id, cwd: project(), source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      {
        type: 'response_item',
        timestamp: '2026-11-24T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'Reading the repository…' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-11-24T10:00:02.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Which option should I pick?' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-11-24T10:00:03.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'Trailing commentary' }],
        },
      },
    ]);

    expect(await lastMessage('codex', id, { homes: { codex: home } })).toEqual({
      text: 'Which option should I pick?',
      at: '2026-11-24T10:00:02.000Z',
    });
  });

  it('returns undefined when a new turn has started without an assistant message yet', async () => {
    const home = tempDir();
    const id = '019f0000-0000-7000-8000-000000000003';
    writeCodex(home, id, [
      { type: 'session_meta', payload: { id, cwd: project(), source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Old turn' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1' } },
    ]);

    expect(await lastMessage('codex', id, { homes: { codex: home } })).toBeUndefined();
  });

  it('returns a 100 KB message whole', async () => {
    const home = tempDir();
    const id = '019f0000-0000-7000-8000-000000000004';
    const big = `${'A'.repeat(102_400)}DONE`;
    writeCodex(home, id, [
      { type: 'session_meta', payload: { id, cwd: project(), source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      {
        type: 'event_msg',
        timestamp: '2026-11-24T10:10:00.000Z',
        payload: { type: 'task_complete', turn_id: 't1', last_agent_message: big },
      },
    ]);

    const got = await lastMessage('codex', id, { homes: { codex: home } });
    expect(got?.text).toBe(big);
    expect(got?.text.length).toBe(102_404);
  });
});

describe.skipIf(!hasSqlite)('lastMessage: OpenCode', () => {
  it('joins text parts of the last assistant message in id order and ignores non-text parts', async () => {
    const home = tempDir();
    const cwd = project();
    const dbPath = join(home, 'opencode.db');
    const store = openStore(dbPath);
    store.session({ id: 'ses_1', directory: cwd, title: 'Chat', created: 1_790_000_000_000 });
    store.message({ session: 'ses_1', role: 'user', text: 'Question?', at: 1_790_000_001_000 });
    const msgId = store.message({ session: 'ses_1', role: 'assistant', at: 1_790_000_002_000, completed: true });
    store.close();

    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (
        path: string,
      ) => {
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath);
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertPart.run(
      'prt_01',
      msgId,
      'ses_1',
      1_790_000_002_001,
      1_790_000_002_001,
      JSON.stringify({ type: 'reasoning', text: 'internal' }),
    );
    insertPart.run(
      'prt_02',
      msgId,
      'ses_1',
      1_790_000_002_002,
      1_790_000_002_002,
      JSON.stringify({ type: 'text', text: 'First block' }),
    );
    insertPart.run(
      'prt_03',
      msgId,
      'ses_1',
      1_790_000_002_003,
      1_790_000_002_003,
      JSON.stringify({ type: 'tool', name: 'bash' }),
    );
    insertPart.run(
      'prt_04',
      msgId,
      'ses_1',
      1_790_000_002_004,
      1_790_000_002_004,
      JSON.stringify({ type: 'text', text: 'Second block' }),
    );
    db.close();

    expect(await lastMessage('opencode', 'ses_1', { homes: { opencode: home } })).toEqual({
      text: 'First block\n\nSecond block',
      at: new Date(1_790_000_002_001).toISOString(),
    });
  });

  it('returns undefined when no assistant text follows the last user prompt, and keeps 100 KB whole', async () => {
    const home = tempDir();
    const cwd = project();
    const store = openStore(join(home, 'opencode.db'));
    store.session({ id: 'ses_wait', directory: cwd, title: 'Waiting', created: 1_790_000_000_000 });
    store.message({ session: 'ses_wait', role: 'user', text: 'Turn 1', at: 1_790_000_001_000 });
    store.message({ session: 'ses_wait', role: 'assistant', text: 'Old reply', at: 1_790_000_002_000 });
    store.message({ session: 'ses_wait', role: 'user', text: 'Turn 2', at: 1_790_000_003_000 });
    store.message({ session: 'ses_wait', role: 'assistant', at: 1_790_000_004_000, completed: false });

    const big = `${'B'.repeat(102_400)}END`;
    store.session({ id: 'ses_big', directory: cwd, title: 'Big', created: 1_790_000_000_000 });
    store.message({ session: 'ses_big', role: 'user', text: 'Write a lot', at: 1_790_000_001_000 });
    store.message({ session: 'ses_big', role: 'assistant', text: big, at: 1_790_000_002_000 });
    store.close();

    expect(await lastMessage('opencode', 'ses_wait', { homes: { opencode: home } })).toBeUndefined();
    const got = await lastMessage('opencode', 'ses_big', { homes: { opencode: home } });
    expect(got?.text).toBe(big);
  });
});

describe('lastMessage: Antigravity and resilience', () => {
  it('returns undefined for Antigravity', async () => {
    expect(await lastMessage('antigravity', 'conv-1', { homes: { antigravity: tempDir() } })).toBeUndefined();
    expect(await lastMessage('agy', 'conv-1', { homes: { antigravity: tempDir() } })).toBeUndefined();
  });

  it('never throws on missing stores, unknown sessions, corrupt files or bad arguments', async () => {
    const empty = tempDir();
    const corrupt = tempDir();
    const claudeDir = join(corrupt, 'projects', 'p');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'bad.jsonl'), '{not json\n{"type":"assistant"}\n');
    const codexDir = join(corrupt, 'sessions', '2026', '11', '24');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'rollout-2026-11-24T10-00-00-bad.jsonl'), 'not json\n');
    writeFileSync(join(corrupt, 'opencode.db'), 'not a sqlite database');

    expect(await lastMessage('claude', 'missing', { homes: { claude: empty } })).toBeUndefined();
    expect(await lastMessage('codex', 'missing', { homes: { codex: empty } })).toBeUndefined();
    expect(await lastMessage('opencode', 'missing', { homes: { opencode: empty } })).toBeUndefined();
    expect(await lastMessage('claude', 'bad', { homes: { claude: corrupt } })).toBeUndefined();
    expect(await lastMessage('codex', 'bad', { homes: { codex: corrupt } })).toBeUndefined();
    expect(await lastMessage('opencode', 'bad', { homes: { opencode: corrupt } })).toBeUndefined();
    expect(await lastMessage('claude', '../escape', { homes: { claude: corrupt } })).toBeUndefined();
    expect(await lastMessage('claude', '', { homes: { claude: empty } })).toBeUndefined();
    expect(await lastMessage('unknown-brain', 'id', { homes: { claude: empty } })).toBeUndefined();
  });
});
