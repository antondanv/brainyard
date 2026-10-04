/**
 * One OpenCode run through its server, so that messages sent while the agent
 * works reach it. `opencode run` cannot do that: it exits as soon as its own
 * prompt is answered, before the answer to a message sent mid-turn (checked
 * with `run --attach`). Brainyard starts this file instead of the CLI and reads
 * its output as if it were `opencode run --format json`:
 *
 *   node opencode-bridge.js <opencode> [leading arguments…]
 *
 * - stdin: one JSON line per message, `{"type":"user","text":…}`; the first
 *   is the prompt, the rest are hints. Brainyard closes it when the turn ends.
 * - BRAINYARD_OPENCODE_BRIDGE: settings as JSON (model, agent, variant,
 *   resume, auto).
 * - It exits once the session is idle and stdin is closed.
 *
 * Node built-ins only: it runs as a process of its own, from source as well.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

interface Settings {
  /** `provider/model`. */
  model?: string;
  agent?: string;
  variant?: string;
  /** Continue this session instead of creating one. */
  resume?: string;
  /** Approve every question (`--auto` of `run`); otherwise every question is rejected. */
  auto?: boolean;
}

type Json = Record<string, unknown>;

// The rules `opencode run` gives its sessions: nobody is there to answer.
const RUN_RULES = [
  { permission: 'question', pattern: '*', action: 'deny' },
  { permission: 'plan_enter', pattern: '*', action: 'deny' },
  { permission: 'plan_exit', pattern: '*', action: 'deny' },
];

/** An idle session waits this long for a follow-up (Brainyard's nudge) before the bridge exits. */
const GRACE_MS = 1500;
const START_TIMEOUT_MS = 60_000;

const settings = object(safeJson(process.env.BRAINYARD_OPENCODE_BRIDGE)) as Settings;
const [file, ...leading] = process.argv.slice(2);

let server: ChildProcess | undefined;
let sessionID: string | undefined;
/** The run's session and the subagent sessions it starts. */
const sessions = new Set<string>();
const roles = new Map<string, string>();
const emitted = new Set<string>();
let idle = false;
let inputEnded = false;
let pending = 0;
let failed = false;
let graceTimer: NodeJS.Timeout | undefined;
let done = false;

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function safeJson(text: string | undefined): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function print(type: string, data: Json): void {
  process.stdout.write(`${JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data })}\n`);
}

function finish(code: number): void {
  if (done) return;
  done = true;
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    setTimeout(() => server?.kill('SIGKILL'), 2000).unref();
  }
  process.exitCode = code;
  // The event stream keeps the loop alive; nothing is left to read.
  setTimeout(() => process.exit(code), 50).unref();
}

function fail(message: string): void {
  print('error', { error: { name: 'BridgeError', data: { message } } });
  finish(1);
}

/** Exit when the session is idle and Brainyard has nothing more to say. */
function settle(): void {
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = undefined;
  if (!idle || pending > 0 || !sessionID) return;
  if (inputEnded) {
    finish(failed ? 1 : 0);
    return;
  }
  // A turn that ended without a final step leaves Brainyard waiting with stdin
  // open; a follow-up it sends arrives within moments.
  graceTimer = setTimeout(() => {
    if (idle && pending === 0) finish(failed ? 1 : 0);
  }, GRACE_MS);
}

async function main(): Promise<void> {
  if (!file) {
    fail('the bridge needs the opencode command');
    return;
  }
  // The server is ours alone for this run: a password nobody else knows.
  const password = randomBytes(24).toString('hex');
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_SERVER_PASSWORD: password };
  delete env.BRAINYARD_OPENCODE_BRIDGE;
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  server = spawn(file, [...leading, 'serve', '--port', '0', '--hostname', '127.0.0.1'], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell,
  });
  server.on('exit', (code) => {
    if (!done) fail(`opencode serve exited with code ${code}`);
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => finish(143));

  const url = await new Promise<string | undefined>((resolve) => {
    let text = '';
    const timer = setTimeout(() => resolve(undefined), START_TIMEOUT_MS);
    server?.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      text += chunk;
      const match = /https?:\/\/[^\s]+/.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve(match[0].replace(/\/$/, ''));
      }
    });
    server?.once('exit', () => resolve(undefined));
  });
  if (!url) {
    if (!done) fail('opencode serve did not say where it listens');
    return;
  }

  const call = async (path: string, body?: Json): Promise<Response> =>
    fetch(`${url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const events = await call('/event');
  if (!events.ok || !events.body) {
    fail(`opencode serve refused its event stream: ${events.status}`);
    return;
  }
  const connected = read(events.body, (event) => handle(event, call));

  const model = settings.model?.includes('/')
    ? {
        providerID: settings.model.slice(0, settings.model.indexOf('/')),
        modelID: settings.model.slice(settings.model.indexOf('/') + 1),
      }
    : undefined;
  const send = async (text: string): Promise<void> => {
    idle = false;
    const res = await call(`/session/${sessionID}/prompt_async`, {
      parts: [{ type: 'text', text }],
      ...(model ? { model } : {}),
      ...(settings.agent ? { agent: settings.agent } : {}),
      ...(settings.variant ? { variant: settings.variant } : {}),
    });
    if (!res.ok) fail(`OpenCode did not take the message: ${res.status} ${(await res.text()).slice(0, 300)}`);
  };
  const open = async (text: string): Promise<void> => {
    await connected;
    if (settings.resume) sessionID = settings.resume;
    else {
      // Named after the prompt, as `run --title=` does: no extra model call for a title.
      const title = text.length > 50 ? `${text.slice(0, 50)}...` : text;
      const res = await call('/session', { title, permission: RUN_RULES });
      if (!res.ok) {
        fail(`OpenCode did not create a session: ${res.status} ${(await res.text()).slice(0, 300)}`);
        return;
      }
      sessionID = String(object(await res.json()).id ?? '');
    }
    sessions.add(sessionID);
    print('session', {});
  };

  // Messages go out one by one, the prompt first: a hint that arrives before
  // the session exists waits for it instead of getting lost.
  let chain = Promise.resolve();
  let lines = 0;
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  input.on('line', (line) => {
    const message = object(safeJson(line));
    const text = typeof message.text === 'string' ? message.text : line;
    if (!text.trim()) return;
    const prompt = lines++ === 0;
    pending += 1;
    chain = chain
      .then(async () => {
        if (prompt) await open(text);
        if (sessionID && !done) await send(text);
      })
      .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        pending -= 1;
        settle();
      });
  });
  input.on('close', () => {
    inputEnded = true;
    if (lines === 0) finish(0);
    else settle();
  });
}

/** Reads the server's event stream; resolves once it says it is connected. */
function read(body: ReadableStream<Uint8Array>, onEvent: (event: Json) => void): Promise<void> {
  return new Promise((connected) => {
    const timer = setTimeout(connected, 5000);
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = body.getReader();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          break;
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          const event = object(safeJson(data));
          if (event.type === 'server.connected') {
            clearTimeout(timer);
            connected();
          }
          if (event.type) onEvent(event);
        }
      }
      if (!done) fail('the OpenCode event stream ended');
    })();
  });
}

/** One server event → the line `opencode run --format json` prints for it, if any. */
function handle(event: Json, call: (path: string, body?: Json) => Promise<Response>): void {
  const props = object(event.properties);
  switch (event.type) {
    case 'session.created': {
      const info = object(props.info);
      if (sessions.has(String(info.parentID ?? ''))) sessions.add(String(info.id));
      return;
    }
    case 'message.updated': {
      const info = object(props.info);
      roles.set(String(info.id), String(info.role));
      return;
    }
    case 'message.part.updated': {
      const part = object(props.part);
      // Like `run`, only the run's own session: subagents work in sessions of their own.
      if (!sessionID || part.sessionID !== sessionID || roles.get(String(part.messageID)) === 'user') return;
      const once = (kind: string, data: Json) => {
        const key = `${kind}:${String(part.id)}`;
        if (emitted.has(key)) return;
        emitted.add(key);
        print(kind, data);
      };
      const status = object(part.state).status;
      if (part.type === 'step-start') once('step_start', { part });
      else if (part.type === 'step-finish') once('step_finish', { part });
      else if (part.type === 'tool' && (status === 'completed' || status === 'error')) once('tool_use', { part });
      else if (part.type === 'text' && object(part.time).end) once('text', { part });
      else if (part.type === 'reasoning' && object(part.time).end) once('reasoning', { part });
      return;
    }
    case 'session.error': {
      if (props.sessionID !== sessionID || !props.error) return;
      failed = true;
      print('error', { error: props.error });
      return;
    }
    case 'permission.asked': {
      const session = String(props.sessionID ?? '');
      if (!sessions.has(session)) return;
      pending += 1;
      void call(`/session/${session}/permissions/${String(props.id)}`, {
        response: settings.auto ? 'once' : 'reject',
      })
        .catch(() => undefined)
        .finally(() => {
          pending -= 1;
          settle();
        });
      return;
    }
    case 'session.status': {
      if (props.sessionID !== sessionID) return;
      idle = object(props.status).type === 'idle';
      settle();
      return;
    }
    case 'session.idle': {
      if (props.sessionID !== sessionID) return;
      idle = true;
      settle();
      return;
    }
    default:
      return;
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
