/**
 * Antigravity CLI (`agy`): `agy -p= --input-format stream-json --output-format stream-json`.
 *
 * Events: `init`, `step_update` (user input, agent responses, tool steps),
 * `result`. Every stdin line is its own turn with its own `result`, and
 * `result.usage` is cumulative across the turns of one process.
 */
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BrainyardError } from '../errors.js';
import { clip, describeTool, tidyPaths } from '../humanize.js';
import type { Usage } from '../types.js';
import { emptyUsage } from '../types.js';
import {
  type Adapter,
  type Launch,
  type LaunchPlan,
  list,
  num,
  type Outcome,
  obj,
  type ParsedEvent,
  type StreamParser,
  str,
} from './adapter.js';

/**
 * `agy` in print mode used to end a turn after five minutes on its own — with
 * exit code 0, mid-work, looking exactly like success. A month is "no limit"
 * in words every version of its flag parser understands.
 */
export const PRINT_TIMEOUT = '720h';

// Where `agy` looks for workspace plugins.
const PLUGINS_DIR = join('.agents', 'plugins');

// `agy` keeps its own files here (MCP tool descriptions, long tool outputs) and
// reads them back. That is bookkeeping for a call already in the feed.
const SERVICE_DIR = '/.gemini/antigravity-cli/';

export const antigravity: Adapter = {
  id: 'antigravity',
  messageIsTurn: true,

  plan(launch: Launch): LaunchPlan {
    const warnings: string[] = [];
    // `-p=` puts the CLI in print mode without a positional prompt; the prompt
    // goes to stdin like every other message. Never as an argument: it has a
    // length limit, shows up in `ps`, and a leading dash reads as a flag.
    const args = [
      '-p=',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      `--print-timeout=${PRINT_TIMEOUT}`,
    ];
    if (launch.access === 'full') {
      // Without it print mode soft-denies every tool — and after a denial
      // `agy` ends the turn without a word of text.
      args.push('--dangerously-skip-permissions');
    } else if (launch.access === 'workspace') {
      // `accept-edits` alone lets the terminal write anywhere (checked: a file
      // in the home directory got written). Its own sandbox confines it — and
      // may refuse some commands outright, which is the honest price.
      args.push('--mode', 'accept-edits');
      if (launch.flags.has('--sandbox')) args.push('--sandbox');
      else warnings.push('this Antigravity version has no --sandbox: its shell is not confined to the workspace');
    } else {
      args.push('--mode', 'plan');
    }
    if (launch.webAsked && !launch.web) warnings.push('Antigravity has no switch for web access; it stays on');
    if (launch.shellAsked && !launch.shell) warnings.push('Antigravity has no switch for its shell; it stays on');

    let cleanup: (() => void) | undefined;
    const servers = Object.entries(launch.mcpServers);
    if (servers.length > 0) {
      cleanup = installPlugins(launch.cwd, launch.mcpServers);
      // Without a workspace `agy -p` does not load plugins at all.
      args.push('--add-dir', launch.cwd);
    }
    if (launch.resume) args.push('--conversation', launch.resume);
    if (launch.model) args.push('--model', launch.model);
    if (launch.effort) args.push('--effort', launch.effort);
    args.push(...launch.extraArgs);
    const prompt = launch.system?.trim() ? `${launch.system.trim()}\n\n${launch.prompt}` : launch.prompt;
    const plan: LaunchPlan = { args, prompt, input: 'stream-json', env: {}, warnings };
    if (cleanup) plan.cleanup = cleanup;
    return plan;
  },

  message(text: string): string {
    // `message` must be an object; a plain string is refused with
    // "cannot unmarshal string".
    return JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  },

  parser(cwd: string, model?: string): StreamParser {
    return new AntigravityParser(cwd, model);
  },
};

/**
 * MCP servers go into the working directory as plugins, for one run — not
 * into `~/.gemini`, where every conversation of the user would see them.
 */
function installPlugins(cwd: string, servers: Launch['mcpServers']): () => void {
  const root = join(cwd, PLUGINS_DIR);
  const created: string[] = [];
  const parents = [join(cwd, '.agents'), root].filter((dir) => !existsSync(dir));
  for (const [name, server] of Object.entries(servers)) {
    const folder = join(root, name);
    if (existsSync(folder)) {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
      throw new BrainyardError(
        'invalid_option',
        `${folder} already exists; Brainyard will not overwrite a plugin it did not create — rename the MCP server`,
        { brain: 'antigravity' },
      );
    }
    mkdirSync(folder, { recursive: true });
    created.push(folder);
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ name }));
    writeFileSync(join(folder, 'mcp_config.json'), JSON.stringify({ mcpServers: { [name]: server } }, null, 2));
  }
  return () => {
    // The server's env may hold secrets; they have no business staying in the project.
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    for (const dir of [...parents].reverse()) {
      try {
        rmdirSync(dir);
      } catch {
        // Not empty: something else lives there now.
      }
    }
  };
}

class AntigravityParser implements StreamParser {
  readonly #cwd: string;
  #text = '';
  #sessionId: string | undefined;
  #model: string | undefined;
  #usage: Usage = emptyUsage();
  #error: string | undefined;
  #results = 0;
  readonly #denied: string[] = [];
  readonly #replies = new Map<string, string>();
  readonly #spoken = new Set<string>();
  #lastReply = '';
  readonly #toolSteps = new Set<string>();

  constructor(cwd: string, model?: string) {
    this.#cwd = cwd;
    this.#model = model;
  }

  get queuedTurns(): number {
    return 0;
  }

  push(event: Record<string, unknown>): ParsedEvent[] {
    switch (event.event) {
      case 'init': {
        this.#sessionId = str(event.conversation_id) || this.#sessionId;
        const init = obj(event.init);
        this.#model = str(init.model) || this.#model;
        return [
          {
            kind: 'init',
            summary: `Antigravity started${this.#model ? ` · ${this.#model}` : ''}`,
            feed: true,
            data: { model: this.#model, sessionId: this.#sessionId, tools: list(init.tools).length },
          },
        ];
      }
      case 'step_update':
        return this.#step(obj(event.step_update));
      case 'result':
        return this.#result(obj(event.result));
      case 'error': {
        this.#error = str(event.error ?? event.message) || 'error';
        return [{ kind: 'error', summary: clip(this.#error, 200), feed: true }];
      }
      default:
        return [];
    }
  }

  outcome(): Outcome {
    const out: Outcome = {
      text: this.#text,
      usage: { ...this.#usage },
      deniedTools: [...this.#denied],
      limits: [],
      results: this.#results,
    };
    if (this.#sessionId) out.sessionId = this.#sessionId;
    if (this.#model) out.model = this.#model;
    if (this.#error) out.error = this.#error;
    return out;
  }

  #step(step: Record<string, unknown>): ParsedEvent[] {
    const type = str(step.step_type);
    const state = str(step.state);
    const index = str(step.step_index);

    if (type === 'agent_response') {
      const key = `${this.#results}:${index}`;
      const delta = str(step.text_delta);
      if (delta) this.#replies.set(key, (this.#replies.get(key) ?? '') + delta);
      if (state !== 'DONE') return [];
      // Replies come per step: "let me check" before a tool call, the answer
      // after it. The answer is the last one; gluing them together would put
      // the working remarks into it.
      const text = (this.#replies.get(key) ?? '').trim();
      if (!text) return [];
      this.#lastReply = text;
      return [this.#say(text)];
    }

    if (type === 'tool') {
      const info = obj(step.tool_info);
      const name = str(step.tool_name) || str(info.name) || 'tool';
      const params = obj(info.parameters);
      const error = obj(info.error);
      const failed = state === 'ERROR' || Object.keys(error).length > 0;
      // Each tool step arrives twice (ACTIVE, then DONE). One line per action;
      // the second update is news only when it is a failure.
      const key = `${this.#results}:${index}`;
      const first = !index || !this.#toolSteps.has(key);
      if (index) this.#toolSteps.add(key);
      if (failed) {
        const message = str(error.message) || str(error.type) || 'failed';
        return [
          {
            kind: 'tool_result',
            summary: `${name} failed: ${clip(tidyPaths(message, this.#cwd), 140)}`,
            tool: name,
            feed: true,
            data: { isError: true },
          },
        ];
      }
      if (!first) return [];
      const described = describeTool(name, params, this.#cwd);
      const service = Object.values(params).some((value) => str(value).includes(SERVICE_DIR));
      return [
        {
          kind: described.kind,
          summary: service ? 'read its own tool notes' : described.summary,
          tool: name,
          input: params,
          feed: !service,
        },
      ];
    }
    return [];
  }

  #result(result: Record<string, unknown>): ParsedEvent[] {
    this.#results += 1;
    this.#sessionId = str(result.conversation_id) || this.#sessionId;
    const status = str(result.status);
    const response = str(result.response).trim() || this.#lastReply;
    const events: ParsedEvent[] = [];
    if (status && status !== 'SUCCESS') {
      this.#error = str(result.error) || status;
    } else {
      this.#error = undefined;
      if (response) {
        this.#text = response;
        // The answer sometimes arrives only here, never as a streamed reply.
        if (!this.#spoken.has(response)) events.push(this.#say(response));
      }
    }
    const usage = obj(result.usage);
    if (Object.keys(usage).length > 0) {
      // Cumulative across the turns of the process: the last one is the total.
      const cached = num(usage.cache_read_tokens);
      this.#usage = {
        inputTokens: Math.max(0, num(usage.input_tokens) - cached),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        reasoningTokens: num(usage.thinking_tokens),
      };
    }
    for (const raw of list(result.denied_actions)) {
      const action = obj(raw);
      const tool = str(action.display_name) || str(action.action);
      if (!tool || this.#denied.includes(tool)) continue;
      this.#denied.push(tool);
      events.push({ kind: 'denied', summary: `the CLI refused ${tool}`, tool, feed: true, data: { tool } });
    }
    return events;
  }

  #say(text: string): ParsedEvent {
    this.#spoken.add(text);
    return { kind: 'message', summary: clip(tidyPaths(text, this.#cwd), 200), text, feed: true };
  }
}
