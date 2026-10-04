#!/usr/bin/env node
// A stand-in for `opencode`. `run --format json` prints the parts of the session
// the way opencode 1.18.34 does: no final event, the process just exits. The TUI
// leaves its session in opencode.db under FAKE_OPENCODE_HOME, as the real one does.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lines, recorder } from './fake-common.mjs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const record = recorder(args);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const MODELS = [
  ['opencode/big-pickle', { name: 'Big Pickle', variants: {} }],
  ['opencode/muse-free', { name: 'Muse Free', variants: { minimal: {}, low: {}, high: {}, turbo: {} } }],
  ['sber/GigaChat-3-Pro', { name: 'GigaChat 3 Pro {beta}', variants: {} }],
];

if (args[0] === '--version') {
  console.log('1.18.999');
  process.exit(0);
}
if (args[0] === 'run' && args.includes('--help')) {
  console.log(
    'opencode run [message..]\n  --format  --title  --variant  --thinking  --auto  --session  --model  --agent',
  );
  process.exit(0);
}
if (args[0] === '--help') {
  console.log('opencode [project]\n  --prompt  --agent  --auto  --session  --model  --continue  --fork');
  process.exit(0);
}
if (args[0] === 'models') {
  // With no provider connected the real CLI lists nothing, and still exits 0.
  if (process.env.FAKE_AUTH === 'out') process.exit(0);
  for (const [id, meta] of MODELS) {
    console.log(id);
    if (args.includes('--verbose')) {
      const [providerID, ...rest] = id.split('/');
      console.log(JSON.stringify({ id: rest.join('/'), providerID, ...meta, cost: { input: 0, output: 0 } }, null, 2));
    }
  }
  process.exit(0);
}
if (args[0] !== 'run') {
  // The TUI: its session goes into the store, and it exits (or, in a pane, stays).
  const home = process.env.FAKE_OPENCODE_HOME;
  if (home) {
    const { openStore } = await import('./opencode-store.mjs');
    const store = openStore(join(home, 'opencode.db'));
    const resumed = flag('--session');
    const id = resumed ?? process.env.FAKE_SESSION_ID ?? 'ses_fakeTui0000000000000001';
    if (!resumed) store.session({ id, directory: process.cwd(), title: `New session - ${new Date().toISOString()}` });
    const prompt = args.find((arg) => arg.startsWith('--prompt='))?.slice('--prompt='.length);
    if (prompt) store.message({ session: id, role: 'user', text: prompt });
    store.close();
  }
  if (process.env.FAKE_PANE === '1') {
    console.log(`fake-opencode ready ${JSON.stringify(args)}`);
    await new Promise(() => undefined);
  }
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
}

const prompt = (await lines(record).all()).trim();
const session = flag('--session') ?? 'ses_fakeRun0000000000000001';
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const cost = Number(process.env.FAKE_COST ?? 0);
let seq = 0;
const at = () => Date.now();
const emit = (type, part) =>
  out({
    type,
    timestamp: at(),
    sessionID: session,
    part: { id: `prt_${++seq}`, messageID: 'msg_1', sessionID: session, ...part },
  });
const step = () => emit('step_start', { type: 'step-start' });
const finish = (reason) =>
  emit('step_finish', {
    type: 'step-finish',
    reason,
    tokens: { total: 1335, input: 1000, output: 20, reasoning: 5, cache: { read: 300, write: 10 } },
    cost,
  });
const say = (text) => emit('text', { type: 'text', text, time: { start: at(), end: at() } });
const tool = (name, input, state = {}) =>
  emit('tool_use', {
    type: 'tool',
    tool: name,
    callID: `call_${seq}`,
    state: { status: 'completed', input, time: { start: at(), end: at() }, ...state },
  });
const fail = (error) => {
  out({ type: 'error', timestamp: at(), sessionID: session, error });
  process.exit(1);
};

switch (scenario) {
  case 'ok': {
    step();
    say('I will write the file first.');
    const file = join(process.cwd(), 'hello.txt');
    writeFileSync(file, 'hi');
    tool(
      'write',
      { content: 'hi', filePath: file },
      { output: 'Wrote file successfully.', metadata: { exists: false } },
    );
    finish('tool-calls');
    step();
    tool(
      'bash',
      { command: 'echo hi', description: 'Say hi' },
      { output: 'hi\n', metadata: { output: 'hi\n', exit: 0 } },
    );
    tool('bash', { command: 'false', description: 'Fail' }, { output: 'boom', metadata: { output: 'boom', exit: 1 } });
    finish('tool-calls');
    step();
    if (args.includes('--thinking')) {
      emit('reasoning', { type: 'reasoning', text: 'Everything is in place.', time: { start: at(), end: at() } });
    }
    say(`All done: ${prompt.slice(0, 40)}`);
    finish('stop');
    break;
  }
  case 'denied': {
    step();
    tool(
      'write',
      { content: 'x', filePath: '/elsewhere/x.txt' },
      { status: 'error', error: 'The user rejected permission to use this specific tool call.' },
    );
    finish('tool-calls');
    // Without this setting the real CLI ends the turn right here, without a word.
    if (config.experimental?.continue_loop_on_deny) {
      step();
      say('I could not write outside the folder.');
      finish('stop');
    }
    break;
  }
  case 'mcp': {
    step();
    for (const name of Object.keys(config.mcp ?? {})) tool(`${name}_secret_word`, {}, { output: 'marmalade' });
    finish('tool-calls');
    step();
    say('marmalade');
    finish('stop');
    break;
  }
  case 'subagent': {
    // The stream carries the task call, never the parts of the subagent's own session.
    step();
    tool(
      'task',
      { description: 'say kiwi', prompt: 'Reply with kiwi', subagent_type: 'general' },
      { output: '<task_result>kiwi</task_result>', metadata: { sessionId: 'ses_fakeChild', parentSessionId: session } },
    );
    finish('tool-calls');
    step();
    say('kiwi');
    finish('stop');
    break;
  }
  case 'cutoff': {
    step();
    tool('read', { filePath: join(process.cwd(), 'a.txt') }, { output: 'a' });
    finish('tool-calls');
    break;
  }
  case 'fail':
    fail({
      name: 'APIError',
      data: {
        message: 'Cannot connect to API: Unable to connect. Is the computer able to access the url?',
        isRetryable: true,
      },
    });
    break;
  case 'unknown':
    fail({
      name: 'UnknownError',
      data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_8a21f8a7' },
    });
    break;
  case 'hang': {
    step();
    say('thinking forever');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
process.exit(0);
