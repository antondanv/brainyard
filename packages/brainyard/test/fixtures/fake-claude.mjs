#!/usr/bin/env node
// A stand-in for `claude` that speaks its stream-json dialect. Like the real
// CLI, with `--input-format stream-json` it does not exit until stdin closes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lines, recorder } from './fake-common.mjs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const record = recorder(args);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (args[0] === '--version') {
  console.log('2.1.999 (Claude Code)');
  process.exit(0);
}
if (args[0] === '--help') {
  console.log(
    'Usage: claude [options]\n  --safe-mode  --tools <tools...>  --no-session-persistence  --strict-mcp-config' +
      (process.env.FAKE_OLD
        ? ''
        : '\n  --session-id <uuid>  -n, --name <name>  --append-system-prompt <prompt>  --bg  -w, --worktree [name]'),
  );
  process.exit(0);
}
// Agent view: running sessions as JSON, from the test.
if (args[0] === 'agents') {
  console.log(process.env.FAKE_AGENTS ?? '[]');
  process.exit(0);
}
if (args[0] === 'stop') {
  if (process.env.FAKE_STOP_ERROR) console.error(process.env.FAKE_STOP_ERROR);
  process.exit(Number(process.env.FAKE_STOP_EXIT ?? 0));
}
// Without `-p` the real CLI is interactive: it owns the terminal until you
// exit. The fake records how it was called and exits.
if (!args.includes('-p') && args[0] !== 'auth') {
  // In a pane: a tiny terminal program that shows what it was given and echoes keys.
  if (process.env.FAKE_PANE === '1' && !args.includes('--bg')) {
    console.log(`fake-claude ready ${JSON.stringify(args)}`);
    const inherited = [
      'CLAUDECODE',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_EFFORT',
      'CLAUDE_PID',
    ].filter((name) => process.env[name] !== undefined);
    console.log(`inherited:${inherited.join(',') || 'none'} keep:${process.env.CLAUDE_CODE_USE_BEDROCK ?? '-'}`);
    console.log(`\u001b[31mred\u001b[0m and plain`);
    process.stdin.setRawMode?.(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      const shown = [...chunk].map((c) => (c < ' ' ? `^${String.fromCharCode(c.charCodeAt(0) + 64)}` : c)).join('');
      process.stdout.write(`got:${shown}\r\n`);
      if (chunk.includes('q')) process.exit(Number(process.env.FAKE_EXIT ?? 0));
    });
    await new Promise(() => undefined);
  }
  if (args.includes('--bg')) {
    if (process.env.FAKE_SCENARIO === 'untrusted') {
      console.log(
        `Workspace not trusted. Run \`claude\` in ${process.cwd()} once and accept the trust prompt, then retry.`,
      );
      process.exit(0);
    }
    const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'fake-1a';
    console.log(`Starting background service…\nbackgrounded · ${process.env.FAKE_BG_ID ?? '1a2b3c4d'} · ${name}`);
    console.log(`  claude attach ${process.env.FAKE_BG_ID ?? '1a2b3c4d'}    open in this terminal`);
  }
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
}
if (args[0] === 'auth') {
  if (process.env.FAKE_AUTH === 'out') console.log(JSON.stringify({ loggedIn: false }));
  else {
    console.log(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        subscriptionType: 'max',
        email: 'jane.doe@example.com',
      }),
    );
  }
  process.exit(0);
}
if (scenario === 'crash') {
  process.stderr.write("error: unknown option '--bogus'\nthe rest of a long echo of arguments\n");
  process.exit(1);
}

const streaming = args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json';
const input = lines(record);
const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'claude-session-1';
const model = args.includes('--model') ? `claude-${args[args.indexOf('--model') + 1]}-test` : 'claude-default-test';
const textOf = (line) => {
  if (!streaming) return line;
  const message = JSON.parse(line);
  return message.message.content[0].text;
};

const init = () =>
  out({
    type: 'system',
    subtype: 'init',
    session_id: session,
    model,
    tools: ['Bash', 'Write'],
    mcp_servers:
      scenario === 'mcp-fail'
        ? [
            { name: 'docs', status: 'failed' },
            { name: 'slow', status: 'pending' },
          ]
        : [],
    permissionMode: 'bypassPermissions',
  });
const say = (text, id = 'msg-1') =>
  out({
    type: 'assistant',
    message: {
      id,
      model,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
const result = (text, extra = {}) =>
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: session,
    total_cost_usd: 0.0123,
    num_turns: 2,
    permission_denials: [],
    queued_turn_count: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
      output_tokens_details: { thinking_tokens: 2 },
    },
    ...extra,
  });
const untilClosed = async () => {
  if (!streaming) return;
  // The real CLI treats open stdin as a conversation and waits for more.
  for (;;) {
    const line = await input.next();
    if (line === undefined) return;
  }
};

const prompt = streaming ? textOf(await input.next()) : await input.all();
init();

switch (scenario) {
  case 'ok': {
    const file = join(process.cwd(), 'hello.txt');
    out({
      type: 'assistant',
      message: {
        id: 'msg-0',
        model,
        content: [
          { type: 'thinking', thinking: 'Plan: write the file.' },
          { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: file, content: 'hi' } },
        ],
      },
    });
    writeFileSync(file, 'hi');
    out({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'File created successfully' }] },
    });
    say(`All done: ${prompt.slice(0, 40)}`);
    result('DONE');
    await untilClosed();
    break;
  }
  case 'hint': {
    out({
      type: 'assistant',
      message: {
        id: 'msg-0',
        model,
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 1' } }],
      },
    });
    const hint = textOf(await input.next());
    say(`heard: ${hint}`);
    result(`heard: ${hint}`);
    await untilClosed();
    break;
  }
  case 'silent': {
    result('');
    const line = await input.next();
    if (line === undefined) break;
    const nudge = textOf(line);
    say('LATE ANSWER');
    result(`LATE ANSWER (${nudge.slice(0, 20)})`);
    await untilClosed();
    break;
  }
  case 'limit': {
    result("You've hit your session limit · resets 6:50pm", {
      is_error: true,
      subtype: 'success',
      api_error_status: 429,
      total_cost_usd: 0,
    });
    process.exit(1);
    break;
  }
  case 'denied': {
    result('I could not run the command.', { permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1' }] });
    await untilClosed();
    break;
  }
  case 'limits-warning': {
    out({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        resetsAt: 1790719800,
        unifiedWindows: {
          five_hour: { utilization: 0.91, resetsAt: 1790719800 },
          seven_day: { utilization: 0.4, resetsAt: 1791280800 },
        },
      },
    });
    say('fine');
    result('fine');
    await untilClosed();
    break;
  }
  case 'broken': {
    process.stdout.write('this is not json\n');
    out({ type: 'something_new', payload: 1 });
    say('still here');
    result('still here');
    await untilClosed();
    break;
  }
  case 'cutoff': {
    say('working on it…');
    process.exit(0);
    break;
  }
  case 'mcp-fail': {
    say('ok');
    result('ok');
    await untilClosed();
    break;
  }
  case 'hang': {
    say('thinking forever');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
process.exit(0);
