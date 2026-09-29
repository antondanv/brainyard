#!/usr/bin/env node
// A stand-in for `agy` in print mode with stream-json input: every stdin line
// is a turn with its own result, usage is cumulative, and it waits for EOF.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lines, recorder } from './fake-common.mjs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const record = recorder(args);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (args[0] === '--version') {
  console.log('1.2.999');
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
  console.log('Usage of agy:\n  --print-timeout  --sandbox  --mode  --conversation  --add-dir');
  process.exit(0);
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
