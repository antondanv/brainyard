#!/usr/bin/env node
// A stand-in for `agy` in print mode with stream-json input: every stdin line
// is a turn with its own result, usage is cumulative, and it waits for EOF.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lines, recorder } from './fake-common.mjs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const record = recorder(args);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (args[0] === '--version') {
  console.log(process.env.FAKE_AGY_VERSION ?? '1.2.999');
  process.exit(0);
}
if (args[0] === 'models') {
  if (process.env.FAKE_AUTH === 'out') {
    process.stderr.write('Error: not signed in. Run agy to sign in.\n');
    process.exit(1);
  }
  console.log('Fetching available models...');
  console.log('gemini-9-flash-high\tGemini 9 Flash (High)');
  console.log('gemini-9-flash-low\tGemini 9 Flash (Low)');
  console.log('claude-x\tClaude X');
  process.exit(0);
}
if (args[0] === '--help') {
  console.log(
    'Usage of agy:\n  --print-timeout  --sandbox  --mode  --conversation  --add-dir  --prompt-interactive' +
      (process.env.FAKE_OLD ? '' : '  --log-file'),
  );
  process.exit(0);
}
if (args.includes('/usage')) {
  if (scenario === 'quota-delay') await new Promise((resolve) => setTimeout(resolve, 30000));
  if (scenario === 'quota-auth') {
    out({ status: 'ERROR', command: { name: 'usage' }, error: 'not signed in' });
    process.exit(1);
  }
  process.stdout.write(
    process.env.FAKE_QUOTA_REPORT ?? readFileSync(new URL('./agy-quota.json', import.meta.url), 'utf8'),
  );
  process.stdout.write('\n');
  process.exit(0);
}
// Without print mode the real CLI is interactive. The fake writes the run log
// (and either conversation_summaries.db when FAKE_AGY_DB=1 or history.jsonl)
// and exits, or stays alive when FAKE_PANE=1.
if (!args.some((arg) => arg === '-p' || arg.startsWith('-p=') || arg === '--print')) {
  const home = process.env.FAKE_AGY_HOME;
  if (home) {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { dirname, resolve, sep } = await import('node:path');
    mkdirSync(home, { recursive: true });
    const given = args.find((arg) => arg.startsWith('--prompt-interactive='));
    const resuming = args.includes('--conversation');
    const conversation = resuming
      ? args[args.indexOf('--conversation') + 1]
      : (process.env.FAKE_SESSION_ID ?? 'agy-int-1');
    const logArgIndex = args.indexOf('--log-file');
    const logArgEq = args.find((arg) => arg.startsWith('--log-file='));
    const requestedLog =
      logArgIndex >= 0 ? args[logArgIndex + 1] : logArgEq ? logArgEq.slice('--log-file='.length) : undefined;
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const glogTime =
      `${pad(now.getMonth() + 1)}${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds() * 1000, 6)}`;
    const inside = (file, root) => {
      const r = resolve(root);
      const f = resolve(file);
      return f === r || f.startsWith(`${r}${sep}`);
    };
    const logPath =
      requestedLog && (inside(requestedLog, home) || inside(requestedLog, tmpdir()))
        ? requestedLog
        : join(home, 'log', `cli-${stamp}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    const logLines = [
      `I${glogTime}      10 server.go:2781] Starting language server process with pid ${process.pid}`,
      `I${glogTime}       1 common.go:194] Launching CLI mode`,
      `I${glogTime}       1 server.go:315] Creating CLI server backend: product=antigravity workspaceDirs=[${process.cwd()}] appDataDir=${home} languageServer=true codeAssist=true`,
      `I${glogTime}       1 manager.go:610] Initializing CLI store manager for workspace ${process.cwd()}`,
    ];
    if (process.env.FAKE_AGY_SKIP_LOG_CONV !== '1') {
      logLines.push(
        resuming
          ? `I${glogTime}     416 server.go:3577] GetConversationDetail: found conversation ${conversation} (active=true)`
          : `I${glogTime}     416 server.go:1269] Created conversation ${conversation} (backend=BACKEND_TYPE_UNSPECIFIED)`,
      );
    }
    // Real agy opens its log with O_TRUNC: two processes on the same path clobber each other.
    writeFileSync(logPath, `${logLines.join('\n')}\n`);

    if (process.env.FAKE_AGY_DB === '1') {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(home, 'conversation_summaries.db'));
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(
        'CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id text primary key, title text, ' +
          'workspace_uris text, status text, not_fully_idle numeric, killed numeric, ' +
          'last_modified_time datetime, last_user_input_time datetime)',
      );
      const title = given ? given.slice('--prompt-interactive='.length).slice(0, 80) : 'Untitled';
      const sqlNow = now.toISOString().replace('T', ' ').replace('Z', '+00:00');
      db.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, 0, 0, ?, ?)').run(
        conversation,
        title,
        '',
        'CASCADE_RUN_STATUS_IDLE',
        sqlNow,
        sqlNow,
      );
      db.close();
    } else {
      appendFileSync(
        join(home, 'history.jsonl'),
        `${JSON.stringify({
          display: given ? given.slice('--prompt-interactive='.length) : 'hi',
          timestamp: Date.now(),
          workspace: process.cwd(),
          conversationId: conversation,
        })}\n`,
      );
    }
  }
  if (process.env.FAKE_PANE === '1') {
    console.log(`fake-agy ready ${JSON.stringify(args)}`);
    await new Promise(() => undefined);
  }
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
}

const input = lines(record);
const conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'agy-conv-1';
out({
  event: 'init',
  conversation_id: conversation,
  init: { model: 'gemini-9-flash', tools: ['write_to_file', 'run_command'] },
});

let turn = 0;
let step = 0;
for (;;) {
  const line = await input.next();
  if (line === undefined) break;
  const text = JSON.parse(line).message.content[0].text;
  turn += 1;
  const usage = {
    input_tokens: 100 * turn,
    output_tokens: 10 * turn,
    thinking_tokens: 3 * turn,
    cache_read_tokens: 20 * turn,
  };
  out({ event: 'step_update', step_update: { step_index: step++, step_type: 'user_input', state: 'DONE' } });
  if (scenario === 'silent' && turn === 1) {
    out({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: '',
        num_turns: turn,
        usage,
        denied_actions: [{ display_name: 'RunCommand' }],
      },
    });
    continue;
  }
  if (turn === 1) {
    const file = join(process.cwd(), 'x.txt');
    const tool = {
      step_index: step,
      step_type: 'tool',
      tool_name: 'write_to_file',
      tool_info: { name: 'write_to_file', parameters: { TargetFile: file } },
    };
    out({ event: 'step_update', step_update: { ...tool, state: 'ACTIVE' } });
    writeFileSync(file, 'x');
    out({ event: 'step_update', step_update: { ...tool, state: 'DONE' } });
    step += 1;
    const notes = {
      step_index: step++,
      step_type: 'tool',
      tool_name: 'view_file',
      state: 'ACTIVE',
      tool_info: { name: 'view_file', parameters: { AbsolutePath: '/home/u/.gemini/antigravity-cli/mcp/x.json' } },
    };
    out({ event: 'step_update', step_update: notes });
  }
  const reply = step++;
  out({
    event: 'step_update',
    step_update: { step_index: reply, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Reply ' },
  });
  out({
    event: 'step_update',
    step_update: {
      step_index: reply,
      step_type: 'agent_response',
      state: 'ACTIVE',
      text_delta: `${turn}: ${text.slice(0, 30)}`,
    },
  });
  out({
    event: 'step_update',
    step_update: { step_index: reply, step_type: 'agent_response', state: 'DONE', text_delta: '\n' },
  });
  out({
    event: 'result',
    result: {
      conversation_id: conversation,
      status: 'SUCCESS',
      response: `Reply ${turn}: ${text.slice(0, 30)}\n`,
      num_turns: turn,
      usage,
    },
  });
}
process.exit(0);
