#!/usr/bin/env node
/**
 * `brainyard` — status, models, one-shot asks, streamed agent runs and the
 * local dashboard. The feed goes to stderr and the answer to stdout, so
 * `brainyard ask codex "…" > answer.md` does what it looks like.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  ask,
  askAll,
  BRAIN_IDS,
  BRAINS,
  BrainyardError,
  type Catalog,
  type McpServer,
  models,
  open,
  type RunResult,
  start,
  status,
} from '@antondanv/brainyard';
import { accessArg, brainArg, Failure, parse, promptFrom, secondsArg, UsageError } from './args.js';
import { paneCommand, panesCommand } from './panes.js';
import { sessionsCommand, stopCommand } from './sessions.js';
import { AVAILABILITY, details } from './status.js';
import { feedLine, pad, paint } from './term.js';
import { usageCommand } from './usage.js';
import { VERSION } from './version.js';

const out = paint(process.stdout);
const err = paint(process.stderr);

const HELP = `${out.bold('brainyard')} ${VERSION} — one interface to Claude Code, Codex, Antigravity and OpenCode

${out.bold('Usage')}
  brainyard                          the app, full screen: agents and their limits, panes, sessions, usage
                                     (piped or without a terminal: status)
  brainyard status                   which CLIs are installed, signed in and ready
  brainyard status --live            prove each with one tiny real call
  brainyard models [brain...]        models and reasoning efforts each CLI offers
  brainyard ask <brain|all> <prompt> one prompt, one answer (answer on stdout)
  brainyard run <brain> <prompt>     run an agent with a live feed; type to steer it
  brainyard sessions [brain...]      sessions of this folder in every CLI, running ones marked
  brainyard sessions --live          what runs on this machine now, in every CLI, and what it waits for
  brainyard stop <session>           stop a Claude Code background session; its conversation stays
  brainyard open <brain> [prompt]    open a CLI here as a session you can come back to
  brainyard panes                    CLI sessions in tmux panes, which outlive this terminal
  brainyard pane start <brain> …     open a CLI in a new pane, as open does; prints the pane's name
  brainyard pane attach <pane>       the pane full screen; Ctrl+Q — back
  brainyard pane show|send|close …   print its screen · type into it · end it (the session stays)
  brainyard usage [brain...]         what the subscriptions have left; tokens and cost of this folder's sessions
  brainyard web                      the app in a browser, on this machine (127.0.0.1)
  brainyard ui                       local dashboard: status, models and a playground
  brainyard serve                    the HTTP API alone, for scripts in any language (no browser)

${out.bold('The app')}  1–5 pages: overview, wall, sessions, usage, settings · Enter — into the pane (Ctrl+Q — back)
         n new pane · x close · s stop · r continue · on the wall: i type into a tile, z zoom, l layout · ? help · q quit

${out.bold('Brains')}  claude (Claude Code) · codex (Codex) · antigravity (Antigravity, alias agy) · opencode (OpenCode)

${out.bold('status')}   --live  --models  --json  --brain <id> (repeatable)  --reveal-account
${out.bold('models')}   --json  --refresh
${out.bold('ask')}      --model <m>  --effort <e>  --system <text>  --web  --access <full|workspace|readonly>
         --timeout <sec>  --json  --no-stdin
         piped stdin is read and appended to the prompt; a prompt of "-" means stdin only
${out.bold('run')}      --cwd <dir>  --model <m>  --effort <e>  --resume <session>
         --access <full|workspace|readonly>  --no-web  --no-shell  --mcp <servers.json>
         --timeout <sec>  --json  --raw  --verbose  --quiet  --no-nudge  --no-steer  --no-stdin
${out.bold('sessions')} --cwd <dir>  --headless  --limit <n> (per CLI)  --json
         --live: running now, on the whole machine unless --cwd  --all: with --live, finished background ones too
${out.bold('stop')}     <session>: its id, the start of it or its short id  --cwd <dir> (defaults to the session's)
${out.bold('open')}     --cwd <dir>  --resume <session>  --name <name>  --system <text>  --model <m>  --effort <e>
         --mode <permission mode>  --worktree [name]  --bg (Claude Code)  --json
${out.bold('panes')}    --json
${out.bold('pane')}     start <brain> [prompt]: open's flags but --bg, and --label <text>  --width <n>  --height <n>
                 --attach  --json
         show <pane>: --scroll <rows>  --json
         send <pane> [text|-]: Enter after the text unless --no-enter; --key <name> (repeatable):
                 enter, esc, tab, shift-tab, up, down, left, right, backspace, ctrl-<letter>…
         <pane> is its name, or the start of its name or of its session's id
${out.bold('usage')}    --cwd <dir>  --session <id>  --limits (subscriptions only)  --limit <n> (per CLI)  --headless
         --prices <file.json>  --offline (saved stores only)  --live (one tiny real Claude call)  --timeout <sec>  --json
${out.bold('web')}      --port <n> (4747)  --host <addr> (127.0.0.1)  --token <t>  --no-open  --json
${out.bold('ui')}       --port <n> (4747)  --host <addr> (127.0.0.1)  --token <t>  --no-open  --json
${out.bold('serve')}    --port <n> (4747)  --host <addr> (127.0.0.1)  --token <t> ($BRAINYARD_TOKEN)
         --json: one line on stdout, {url, port, token}, for the program that started it

${out.bold('Examples')}
  brainyard ask codex "Explain CRDTs in two sentences"
  brainyard ask all "Name one risk of eval() in JavaScript"
  git diff | brainyard ask claude --model haiku "Review this diff"
  brainyard run claude --cwd ./app "Add a unit test for src/math.ts"
  brainyard run codex --resume <session-id> "Now make it pass"
  brainyard open claude --name "auth refactor" "Plan the OAuth migration"
  brainyard sessions --cwd ~/code/app
  brainyard pane send claude-1a2b3c4d "Run the tests"

Docs: https://github.com/antondanv/brainyard`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      // In a terminal: the app. Piped or in a script: the status table, as before.
      if (process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb') return appCommand();
      return statusCommand([]);
    case 'status':
    case 'doctor':
      return statusCommand(rest);
    case 'models':
      return modelsCommand(rest);
    case 'ask':
      return askCommand(rest);
    case 'run':
      return runCommand(rest);
    case 'sessions':
      return sessionsCommand(rest);
    case 'stop':
      return stopCommand(rest);
    case 'usage':
      return usageCommand(rest);
    case 'open':
      return openCommand(rest);
    case 'panes':
      return panesCommand(rest);
    case 'pane':
      return paneCommand(rest);
    case 'web':
      return serverCommand(rest, 'web');
    case 'ui':
      return serverCommand(rest, 'ui');
    case 'serve':
      return serverCommand(rest, 'serve');
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${HELP}\n`);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    default:
      if (command.startsWith('-')) return statusCommand(argv);
      throw new UsageError(`unknown command "${command}"`);
  }
}

// ---------------------------------------------------------------------------
// the app
// ---------------------------------------------------------------------------
async function appCommand(): Promise<number> {
  const { runApp } = await import('./tui/terminal.js');
  const code = await runApp();
  // Reads still under way (a CLI asked for its status) are of no use now.
  process.exit(code);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
async function statusCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    json: { type: 'boolean' },
    live: { type: 'boolean' },
    models: { type: 'boolean' },
    brain: { type: 'string', multiple: true },
    'reveal-account': { type: 'boolean' },
  });
  const brains = values.brain?.map((value) => brainArg(value));
  const started = Date.now();
  if (!values.json && values.live && process.stderr.isTTY) {
    process.stderr.write(err.dim('checking with a real call to each installed CLI…\n'));
  }
  const report = await status({
    ...(brains ? { brains } : {}),
    live: values.live === true,
    models: values.models === true,
    revealAccount: values['reveal-account'] === true,
  });
  const wanted = brains ?? report.brains.map((brain) => brain.id);
  const healthy = brains ? wanted.every((id) => report.ready.includes(id)) : report.ready.length > 0;

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return healthy ? 0 : 1;
  }

  const lines = [`${out.bold('Brainyard')} ${out.dim(VERSION)}`, ''];
  const labelWidth = Math.max(...report.brains.map((brain) => brain.label.length));
  for (const brain of report.brains) {
    const [word, colour] = AVAILABILITY[brain.availability];
    const tint = out[colour];
    lines.push(
      `  ${tint('●')} ${pad(out.bold(brain.label), labelWidth)}  ${pad(out.dim(brain.version ?? '—'), 9)} ${pad(tint(word), 13)} ${details(brain, out)}`,
    );
    const windows = brain.ping?.limits ?? [];
    if (windows.length > 0) {
      const usage = windows.map((w) => `${w.window.replace('_', '-')} ${Math.round(w.utilization * 100)}%`).join(' · ');
      lines.push(`  ${' '.repeat(labelWidth + 27)}${out.dim(`subscription use: ${usage}`)}`);
    }
    if (brain.models) lines.push(...catalogLines(brain.models, '      '));
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  lines.push('');
  const tail = values.live ? '' : ` · prove each with a real call: ${out.cyan('brainyard status --live')}`;
  lines.push(out.dim(`  ${report.ready.length} of ${report.brains.length} ready · ${seconds}s`) + tail);
  process.stdout.write(`${lines.join('\n')}\n`);
  return healthy ? 0 : 1;
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------
function catalogLines(catalog: Catalog, indent: string): string[] {
  const idWidth = Math.max(8, ...catalog.models.map((model) => model.id.length));
  const lines = catalog.models.map((model) => {
    const efforts = model.efforts.length > 0 ? model.efforts.join(', ') : 'no effort setting';
    const notes = [
      model.defaultEffort ? `default ${model.defaultEffort}` : '',
      model.effortRequired ? 'effort required' : '',
    ].filter(Boolean);
    return `${indent}${pad(out.bold(model.id), idWidth)}  ${out.dim(efforts)}${notes.length ? out.dim(` (${notes.join(', ')})`) : ''}`;
  });
  if (catalog.note) lines.push(`${indent}${out.dim(catalog.note)}`);
  return lines;
}

async function modelsCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' }, refresh: { type: 'boolean' } });
  const ids = positionals.length > 0 ? positionals.map((value) => brainArg(value)) : [...BRAIN_IDS];
  const catalogs = await Promise.all(ids.map((id) => models(id, { refresh: values.refresh === true })));
  if (values.json) {
    process.stdout.write(`${JSON.stringify(catalogs, null, 2)}\n`);
    return 0;
  }
  const lines: string[] = [];
  for (const catalog of catalogs) {
    const source = catalog.source === 'cli' ? 'from the CLI' : 'built-in list';
    lines.push(`${out.bold(BRAINS[catalog.brain].label)} ${out.dim(`· ${source}`)}`);
    lines.push(...catalogLines(catalog, '  '), '');
  }
  process.stdout.write(lines.join('\n'));
  return 0;
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------
async function openCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    cwd: { type: 'string' },
    resume: { type: 'string' },
    name: { type: 'string' },
    system: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    mode: { type: 'string' },
    worktree: { type: 'string' },
    bg: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const [target, ...words] = positionals;
  const brain = brainArg(target);
  const prompt = words.join(' ').trim();
  const result = await open({
    brain,
    cwd: values.cwd ?? process.cwd(),
    ...(prompt ? { prompt } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values.system ? { system: values.system } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values.mode ? { permissionMode: values.mode } : {}),
    ...(values.worktree !== undefined ? { worktree: values.worktree || true } : {}),
    ...(values.bg ? { background: true } : {}),
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  for (const warning of result.warnings) process.stderr.write(`${err.yellow('!')} ${warning}\n`);
  if (result.error) {
    process.stderr.write(`${err.red('✗')} ${result.error.message}\n`);
    return 1;
  }
  if (result.sessionId) {
    const how = {
      claude: `claude --resume ${result.sessionId}`,
      codex: `codex resume ${result.sessionId}`,
      antigravity: `agy --conversation ${result.sessionId}`,
      opencode: `opencode --session ${result.sessionId}`,
    }[brain];
    process.stderr.write(`${err.dim('session')} ${result.sessionId} ${err.dim(`· continue: ${how}`)}\n`);
  }
  return result.ok ? 0 : (result.exitCode ?? 1);
}

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------
async function askCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    model: { type: 'string', short: 'm' },
    effort: { type: 'string', short: 'e' },
    system: { type: 'string', short: 's' },
    web: { type: 'boolean' },
    access: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
    'no-stdin': { type: 'boolean' },
  });
  const [target, ...words] = positionals;
  if (!target) throw new UsageError('usage: brainyard ask <brain|all> <prompt>');
  const prompt = await promptFrom(words, !values['no-stdin']);
  if (!prompt) throw new UsageError('the prompt is empty: pass it as arguments or pipe it in');
  const access = accessArg(values.access);
  const timeoutMs = secondsArg(values.timeout);
  const common = {
    ...(values.system ? { system: values.system } : {}),
    ...(values.web ? { web: true } : {}),
    ...(access ? { access } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };

  if (target === 'all') {
    if (values.model || values.effort) throw new UsageError('--model and --effort belong to one brain, not to "all"');
    const waiting = process.stderr.isTTY ? err.dim('asking every installed CLI…\n') : '';
    process.stderr.write(waiting);
    const entries = await askAll(prompt, common);
    if (values.json) {
      process.stdout.write(
        `${JSON.stringify(
          entries.map((entry) => ({
            brain: entry.brain,
            ...(entry.result ? { result: entry.result } : {}),
            ...(entry.error ? { error: { kind: entry.error.kind, message: entry.error.message } } : {}),
          })),
          null,
          2,
        )}\n`,
      );
      return entries.some((entry) => entry.result) ? 0 : 1;
    }
    for (const entry of entries) {
      const label = BRAINS[entry.brain].label;
      if (entry.result) {
        process.stdout.write(`${out.bold(`── ${label}`)} ${out.dim(meta(entry.result))}\n${entry.result.text}\n\n`);
      } else if (entry.error) {
        const tint = entry.error.kind === 'not_installed' ? out.gray : out.red;
        process.stdout.write(`${out.bold(`── ${label}`)} ${tint(`${entry.error.kind}: ${entry.error.message}`)}\n\n`);
      }
    }
    return entries.some((entry) => entry.result) ? 0 : 1;
  }

  const brain = brainArg(target);
  if (process.stderr.isTTY && !values.json) process.stderr.write(err.dim(`asking ${BRAINS[brain].label}…\r`));
  const answer = await ask(brain, prompt, {
    ...common,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
  });
  if (process.stderr.isTTY && !values.json) process.stderr.write('\u001b[2K');
  if (values.json) {
    process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${answer.text}\n`);
  process.stderr.write(`${err.dim(meta(answer))}\n`);
  return 0;
}

function meta(answer: {
  model?: string;
  durationMs: number;
  costUsd: number | null;
  costSource: string | null;
}): string {
  const parts = [answer.model, `${(answer.durationMs / 1000).toFixed(1)}s`];
  if (answer.costUsd !== null)
    parts.push(`$${answer.costUsd.toFixed(4)}${answer.costSource === 'estimate' ? ' est.' : ''}`);
  return parts.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
function loadServers(path: string): Record<string, McpServer> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`--mcp: cannot read ${path}: ${(error as Error).message}`);
  }
  const record = data as { mcpServers?: unknown };
  const servers = record && typeof record === 'object' && record.mcpServers ? record.mcpServers : data;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new UsageError('--mcp wants {"mcpServers": {"name": {"command": "…", "args": []}}}');
  }
  return servers as Record<string, McpServer>;
}

async function runCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    cwd: { type: 'string', short: 'C' },
    model: { type: 'string', short: 'm' },
    effort: { type: 'string', short: 'e' },
    resume: { type: 'string', short: 'r' },
    access: { type: 'string' },
    'no-web': { type: 'boolean' },
    'no-shell': { type: 'boolean' },
    mcp: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
    raw: { type: 'boolean' },
    verbose: { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
    'no-nudge': { type: 'boolean' },
    'no-steer': { type: 'boolean' },
    'no-stdin': { type: 'boolean' },
  });
  const [target, ...words] = positionals;
  const brain = brainArg(target);
  const prompt = await promptFrom(words, !values['no-stdin']);
  if (!prompt) throw new UsageError('the prompt is empty: pass it as arguments or pipe it in');
  const access = accessArg(values.access);
  const timeoutMs = secondsArg(values.timeout);

  const agent = start({
    brain,
    prompt,
    ...(values.cwd ? { cwd: values.cwd } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
    ...(access ? { access } : {}),
    ...(values['no-web'] ? { web: false } : {}),
    ...(values['no-shell'] ? { shell: false } : {}),
    ...(values.mcp ? { mcpServers: loadServers(values.mcp) } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(values.raw ? { includeRaw: true } : {}),
    ...(values['no-nudge'] ? { nudge: false } : {}),
  });

  // Ctrl+C once stops the agent (work so far stays on disk); twice quits now.
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts += 1;
    if (interrupts === 1) {
      process.stderr.write(err.yellow('\nstopping the agent… (Ctrl+C again to quit now)\n'));
      agent.stop('interrupted');
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', onInterrupt);

  // Typing while the agent works sends it a hint.
  const steering = agent.steerable && !values['no-steer'] && process.stdin.isTTY === true && !values.json;
  const input = steering ? createInterface({ input: process.stdin, terminal: false }) : undefined;
  input?.on('line', (line) => {
    if (line.trim()) agent.hint(line);
  });

  const startedAt = Date.now();
  if (!values.json && !values.quiet) {
    const how = steering ? ' · type a message + Enter to steer, Ctrl+C to stop' : ' · Ctrl+C to stop';
    process.stderr.write(err.dim(`${BRAINS[brain].label} is working${how}\n`));
  }

  for await (const event of agent) {
    if (values.json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      continue;
    }
    if (values.quiet) continue;
    if (!event.feed && !values.verbose) continue;
    process.stderr.write(`${feedLine(event, err, startedAt)}\n`);
  }

  let result: RunResult;
  try {
    result = await agent.result;
  } finally {
    process.off('SIGINT', onInterrupt);
    input?.close();
    if (steering) process.stdin.pause();
  }

  if (values.json) {
    const { events: _events, ...rest } = result;
    process.stdout.write(`${JSON.stringify({ kind: 'result', result: rest })}\n`);
  } else {
    if (result.text.trim()) process.stdout.write(`${values.quiet ? '' : '\n'}${result.text.trim()}\n`);
    if (!values.quiet) {
      const tail: string[] = [];
      if (result.sessionId) {
        tail.push(`session ${result.sessionId} · continue: brainyard run ${brain} --resume ${result.sessionId} "…"`);
      }
      if (!result.ok && result.error) {
        tail.push(err.red(`${result.error.kind}: ${result.error.message}`));
        if (result.error.resetsAt) tail.push(err.yellow(`the limit resets ${result.error.resetsAt}`));
      }
      if (tail.length > 0) process.stderr.write(`\n${tail.map((line) => err.dim(line)).join('\n')}\n`);
    }
  }
  if (result.stopped) return 130;
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// ui / serve
// ---------------------------------------------------------------------------
/**
 * `web` shows the app in a browser, `ui` the dashboard; `serve` is the same HTTP API for scripts, with
 * no browser.
 */
async function serverCommand(args: string[], mode: 'web' | 'ui' | 'serve'): Promise<number> {
  const { values } = parse(args, {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    token: { type: 'string' },
    'no-open': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
    throw new UsageError(`--port wants a number, not "${values.port}"`);
  // A script keeps its token in the environment rather than in the process list.
  const token = values.token ?? (mode === 'serve' ? process.env.BRAINYARD_TOKEN?.trim() || undefined : undefined);
  const { serve, openBrowser } = await import('./ui/server.js');
  // q in the browser ends the app as it does in a terminal: the server goes with it.
  let quit: () => void = () => undefined;
  const app = mode === 'web' ? (await import('./tui/web.js')).startWeb({ onQuit: () => quit() }) : undefined;
  // Without --port, 4747 or the next free port.
  const server = await serve({
    ...(port !== undefined ? { port } : {}),
    ...(values.host ? { host: values.host } : {}),
    ...(token ? { token } : {}),
    ...(app ? { app } : {}),
  }).catch((error: unknown) => {
    // The app reads on timers: a port taken must not leave the command running with no server.
    app?.stop();
    throw error;
  });
  // One line a parent process reads to know where to call.
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ url: server.origin, port: server.port, token: server.token })}\n`);
  }
  const title = { web: 'Brainyard', ui: 'Brainyard dashboard', serve: 'Brainyard API' }[mode];
  const where =
    mode === 'serve'
      ? `${err.bold(title)} ${err.dim('— Ctrl+C to stop')}\n  ${err.cyan(server.origin)}  ${err.dim(`token ${server.token}`)}\n`
      : `${err.bold(title)} ${err.dim('— Ctrl+C to stop')}\n  ${err.cyan(server.url)}\n`;
  process.stderr.write(where);
  if (!server.local) {
    process.stderr.write(
      err.yellow('  warning: listening beyond localhost — anyone with the link can run agents on this machine\n'),
    );
  }
  if (mode !== 'serve' && !values['no-open']) openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const stop = (signal?: NodeJS.Signals) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (signal === 'SIGINT') process.stderr.write('\n');
      app?.stop();
      void server.close().then(resolve);
    };
    quit = () => {
      process.stderr.write(err.dim('quit from the browser; the panes keep running\n'));
      // The answer to the key that quit, and the word to the page, go out first.
      setTimeout(stop, 200);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  // The app may still be asking a CLI for its status: of no use now.
  if (app) process.exit(0);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${err.red(`brainyard: ${error.message}`)}\n${err.dim('see: brainyard help')}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof Failure) {
      process.stderr.write(`${err.red(`brainyard: ${error.message}`)}\n`);
      if (error.fix) process.stderr.write(`${err.dim(`→ ${error.fix}`)}\n`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof BrainyardError) {
      process.stderr.write(`${err.red(`${error.kind}: ${error.message}`)}\n`);
      if (error.fix) process.stderr.write(`${err.dim(`→ ${error.fix}`)}\n`);
      if (error.resetsAt) process.stderr.write(`${err.yellow(`the limit resets ${error.resetsAt}`)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${err.red(String((error as Error)?.stack ?? error))}\n`);
    process.exitCode = 1;
  },
);
