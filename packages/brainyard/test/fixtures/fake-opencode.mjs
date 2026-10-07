#!/usr/bin/env node
// A stand-in for `opencode`. `run --format json` prints the parts of the session
// the way opencode 1.18.34 does: no final event, the process just exits. `serve`
// plays the same turns over HTTP and server-sent events, takes messages mid-turn
// and asks for permissions. The TUI leaves its session in opencode.db under
// FAKE_OPENCODE_HOME, as the real one does.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lines, recorder } from './fake-common.mjs';

const args = process.argv.slice(2);
// Deleting a session is a call of its own; it must not overwrite the record of the run.
if (args[0] === 'session' && args[1] === 'delete') {
  if (process.env.FAKE_DELETE_LOG) appendFileSync(process.env.FAKE_DELETE_LOG, `${args[2]}\n`);
  console.log(`Session ${args[2]} deleted`);
  process.exit(0);
}
const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const record = recorder(args);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// Like the real CLI, the folder it works in is PWD, not the process's own cwd.
const here = process.env.PWD || process.cwd();

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
if (args[0] !== 'run' && args[0] !== 'serve') {
  // The TUI: its session goes into the store, and it exits (or, in a pane, stays).
  const home = process.env.FAKE_OPENCODE_HOME;
  if (home) {
    const { openStore } = await import('./opencode-store.mjs');
    const store = openStore(join(home, 'opencode.db'));
    const resumed = flag('--session');
    const id = resumed ?? process.env.FAKE_SESSION_ID ?? 'ses_fakeTui0000000000000001';
    if (!resumed) store.session({ id, directory: here, title: `New session - ${new Date().toISOString()}` });
    const prompt = args.find((arg) => arg.startsWith('--prompt='))?.slice('--prompt='.length);
    if (prompt) store.message({ session: id, role: 'user', text: prompt });
    store.close();
  }
  if (process.env.FAKE_PANE === '1') {
    console.log(`fake-opencode ready ${JSON.stringify(args)}`);
    const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
    console.log(`build-prompt:${inline.agent?.build?.prompt ?? '-'}`);
    await new Promise(() => undefined);
  }
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
}

const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const cost = Number(process.env.FAKE_COST ?? 0);
const at = () => Date.now();
const TOKENS = { total: 1335, input: 1000, output: 20, reasoning: 5, cache: { read: 300, write: 10 } };
const REJECTED = 'The user rejected permission to use this specific tool call.';

/**
 * One turn of a scenario. `io` says how parts come out (`run` lines or server
 * events) and how the turn hears messages and permission answers.
 */
async function play(io, prompt) {
  const step = () => io.part({ type: 'step-start' });
  const finish = (reason) => io.part({ type: 'step-finish', reason, tokens: TOKENS, cost });
  const say = (text) => io.part({ type: 'text', text, time: { start: at(), end: at() } });
  const tool = (name, input, state = {}) =>
    io.part({ type: 'tool', tool: name, callID: `call_${at()}`, state: { status: 'completed', input, ...state } });
  switch (scenario) {
    case 'ok': {
      step();
      say('I will write the file first.');
      const file = join(here, 'hello.txt');
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
      tool(
        'bash',
        { command: 'false', description: 'Fail' },
        { output: 'boom', metadata: { output: 'boom', exit: 1 } },
      );
      finish('tool-calls');
      step();
      if (io.thinking)
        io.part({ type: 'reasoning', text: 'Everything is in place.', time: { start: at(), end: at() } });
      say(`All done: ${prompt.slice(0, 40)}`);
      finish('stop');
      return;
    }
    case 'hint': {
      step();
      tool('bash', { command: 'sleep 1' }, { output: '', metadata: { output: '', exit: 0 } });
      finish('tool-calls');
      // A message sent now joins this turn.
      const hint = await io.hint(5000);
      step();
      say(hint ? `heard: ${hint}` : 'no hint');
      finish('stop');
      return;
    }
    case 'permission': {
      step();
      const answer = await io.permission({ permission: 'external_directory', patterns: ['/elsewhere/*'] });
      const input = { content: 'x', filePath: '/elsewhere/x.txt' };
      tool(
        'write',
        input,
        answer === 'reject' ? { status: 'error', error: REJECTED } : { output: 'Wrote file successfully.' },
      );
      finish('tool-calls');
      step();
      say(answer === 'reject' ? 'refused' : 'written');
      finish('stop');
      return;
    }
    case 'denied': {
      step();
      tool('write', { content: 'x', filePath: '/elsewhere/x.txt' }, { status: 'error', error: REJECTED });
      finish('tool-calls');
      // Without this setting the real CLI ends the turn right here, without a word.
      if (config.experimental?.continue_loop_on_deny) {
        step();
        say('I could not write outside the folder.');
        finish('stop');
      }
      return;
    }
    case 'mcp': {
      step();
      for (const name of Object.keys(config.mcp ?? {})) tool(`${name}_secret_word`, {}, { output: 'marmalade' });
      finish('tool-calls');
      step();
      say('marmalade');
      finish('stop');
      return;
    }
    case 'subagent': {
      // The stream carries the task call, never the parts of the subagent's own session.
      step();
      tool(
        'task',
        { description: 'say kiwi', prompt: 'Reply with kiwi', subagent_type: 'general' },
        {
          output: '<task_result>kiwi</task_result>',
          metadata: { sessionId: 'ses_fakeChild', parentSessionId: io.session },
        },
      );
      finish('tool-calls');
      step();
      say('kiwi');
      finish('stop');
      return;
    }
    case 'cutoff': {
      step();
      tool('read', { filePath: join(here, 'a.txt') }, { output: 'a' });
      finish('tool-calls');
      return;
    }
    case 'fail':
      io.error({
        name: 'APIError',
        data: {
          message: 'Cannot connect to API: Unable to connect. Is the computer able to access the url?',
          isRetryable: true,
        },
      });
      return;
    case 'unknown':
      io.error({
        name: 'UnknownError',
        data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_8a21f8a7' },
      });
      return;
    case 'hang': {
      step();
      say('thinking forever');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
      return;
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

if (args[0] === 'run') {
  const prompt = (await lines(record).all()).trim();
  const session = flag('--session') ?? 'ses_fakeRun0000000000000001';
  let seq = 0;
  let failed = false;
  const NAMES = {
    'step-start': 'step_start',
    'step-finish': 'step_finish',
    tool: 'tool_use',
    text: 'text',
    reasoning: 'reasoning',
  };
  await play(
    {
      session,
      thinking: args.includes('--thinking'),
      part: (part) =>
        out({
          type: NAMES[part.type],
          timestamp: at(),
          sessionID: session,
          part: { id: `prt_${++seq}`, messageID: 'msg_1', sessionID: session, ...part },
        }),
      error: (error) => {
        failed = true;
        out({ type: 'error', timestamp: at(), sessionID: session, error });
      },
      // `run` reads one message, and answers every question itself.
      hint: async () => undefined,
      permission: async () => (args.includes('--auto') ? 'once' : 'reject'),
    },
    prompt,
  );
  process.exit(failed ? 1 : 0);
}

// `serve`: the same turns, over HTTP and server-sent events.
const { createServer } = await import('node:http');
const password = process.env.OPENCODE_SERVER_PASSWORD;
record.http = [];
const streams = new Set();
const send = (type, properties) => {
  for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
};
const inbox = [];
let wake;
const answers = new Map();
let busy = false;
let seq = 0;
let messages = 0;

async function turn(session) {
  busy = true;
  send('session.status', { sessionID: session, status: { type: 'busy' } });
  const prompt = inbox.shift();
  const user = `msg_user${++messages}`;
  send('message.updated', { info: { id: user, role: 'user', sessionID: session } });
  // The person's own words come back as a part too; the bridge must not take them for an answer.
  send('message.part.updated', {
    part: {
      id: `prt_${++seq}`,
      messageID: user,
      sessionID: session,
      type: 'text',
      text: prompt,
      time: { start: at(), end: at() },
    },
  });
  const reply = `msg_reply${messages}`;
  send('message.updated', { info: { id: reply, role: 'assistant', sessionID: session } });
  await play(
    {
      session,
      thinking: true,
      part: (part) => {
        const full = { id: `prt_${++seq}`, messageID: reply, sessionID: session, ...part };
        // A tool reports itself running before it is done: one line per call, not two.
        if (part.type === 'tool')
          send('message.part.updated', { part: { ...full, state: { ...part.state, status: 'running' } } });
        send('message.part.updated', { part: full });
      },
      error: (error) => send('session.error', { sessionID: session, error }),
      hint: (ms) =>
        new Promise((resolve) => {
          if (inbox.length) return resolve(inbox.shift());
          const timer = setTimeout(() => {
            wake = undefined;
            resolve(undefined);
          }, ms);
          wake = () => {
            wake = undefined;
            clearTimeout(timer);
            resolve(inbox.shift());
          };
        }),
      permission: (asked) =>
        new Promise((resolve) => {
          const id = `per_${++seq}`;
          answers.set(id, resolve);
          send('permission.asked', { id, sessionID: session, ...asked });
        }),
    },
    prompt,
  );
  busy = false;
  send('session.status', { sessionID: session, status: { type: 'idle' } });
  send('session.idle', { sessionID: session });
  if (inbox.length) void turn(session);
}

const server = createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8').on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const path = new URL(req.url, 'http://fake').pathname;
    record.http.push({ method: req.method, path, body });
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    if (password && req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    const json = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.method === 'GET' && path === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.add(res);
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      return;
    }
    if (req.method === 'POST' && path === '/session') {
      const info = { id: 'ses_fakeServe00000000000001', directory: here, title: body?.title };
      json(info);
      send('session.created', { info });
      return;
    }
    const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(path);
    if (req.method === 'POST' && prompt) {
      inbox.push(body.parts.map((part) => part.text).join('\n'));
      res.writeHead(204).end();
      if (!busy) void turn(prompt[1]);
      else wake?.();
      return;
    }
    const permission = /^\/session\/[^/]+\/permissions\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && permission) {
      answers.get(permission[1])?.(body.response);
      json(true);
      return;
    }
    res.writeHead(404).end();
  });
});
server.listen(0, '127.0.0.1', () =>
  console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`),
);
process.on('SIGTERM', () => process.exit(0));
