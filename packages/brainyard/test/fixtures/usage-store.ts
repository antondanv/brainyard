import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { claudeProjectDir } from '../../src/sessions.js';

export function jsonl(path: string, entries: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return path;
}

export function claudeStore(home: string, cwd: string, id: string, messages: unknown[]): string {
  return jsonl(join(home, 'projects', claudeProjectDir(cwd), `${id}.jsonl`), [
    { type: 'user', cwd, entrypoint: 'cli', message: { content: 'Count this session' } },
    ...messages,
  ]);
}

export function claudeMessage(id: string, model: string, input = 10, output = 5): unknown {
  return {
    type: 'assistant',
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        output_tokens_details: { thinking_tokens: 2 },
      },
    },
  };
}

export function codexStore(home: string, cwd: string, id: string, events: unknown[]): string {
  return jsonl(join(home, 'sessions', '2026', '10', '04', `rollout-test-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd, source: 'cli' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Count this session' } },
    ...events,
  ]);
}

export function codexTokens(input = 100, output = 20, cached = 40): unknown {
  return {
    type: 'event_msg',
    timestamp: '2026-10-04T10:00:00Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: output,
          cached_input_tokens: cached,
          cache_write_input_tokens: 10,
          reasoning_output_tokens: 5,
        },
      },
    },
  };
}

export function codexLimits(at: string, percent: number, id = 'codex'): unknown {
  return {
    type: 'event_msg',
    timestamp: at,
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        limit_id: id,
        primary: { used_percent: percent, window_minutes: 300, resets_at: 1791115200 },
        secondary: { used_percent: 25, window_minutes: 10080, resets_at: 1791720000 },
      },
    },
  };
}

function variable(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function field(number: number, value: number | Buffer | string): Buffer {
  if (typeof value === 'number') return Buffer.concat([variable(number * 8), variable(value)]);
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([variable(number * 8 + 2), variable(data.length), data]);
}

// The persisted CortexStepGeneratorMetadata → ChatModelMetadata → ModelUsageStats.
export function agyGeneration(model: string, input = 100, output = 20, cached = 40): Buffer {
  const counters = Buffer.concat([
    field(2, input),
    field(3, output),
    field(4, 10),
    field(5, cached),
    field(9, 5),
    field(10, output - 5),
  ]);
  return Buffer.concat([
    field(2, Buffer.from([1, 2])),
    field(1, Buffer.concat([field(4, counters), field(19, model), field(80, 'future field')])),
    field(100, 1),
  ]);
}

export function agyStore(home: string, cwd: string, id: string, generations: Buffer[]): string {
  mkdirSync(join(home, 'conversations'), { recursive: true });
  writeFileSync(
    join(home, 'history.jsonl'),
    `${JSON.stringify({ conversationId: id, workspace: cwd, text: 'Count this session', timestamp: Date.now() })}\n`,
  );
  const path = join(home, 'conversations', `${id}.db`);
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer)');
  const insert = db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)');
  generations.forEach((data, index) => {
    insert.run(index, data, data.length);
  });
  db.close();
  return path;
}

export function opencodeStore(home: string, cwd: string, messages: unknown[], cost = 999): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE session (id text PRIMARY KEY, directory text, parent_id text, permission text, title text, time_created integer, time_updated integer, time_archived integer, cost real)',
  );
  db.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, data text)');
  db.exec('CREATE TABLE part (id text PRIMARY KEY, session_id text, message_id text, data text)');
  db.prepare('INSERT INTO session VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, ?)').run(
    'ses_test',
    cwd,
    'Saved OpenCode session',
    Date.now(),
    Date.now(),
    cost,
  );
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  messages.forEach((data, index) => {
    insert.run(`msg_${index}`, 'ses_test', index, JSON.stringify(data));
  });
  db.close();
  return path;
}

export function opencodeMessage(model = 'model-a', cost = 0): unknown {
  return {
    role: 'assistant',
    providerID: 'provider',
    modelID: model,
    cost,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } },
  };
}
