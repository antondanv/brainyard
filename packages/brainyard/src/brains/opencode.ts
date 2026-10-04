/**
 * OpenCode: `opencode run --format json`.
 *
 * One prompt is the whole run: it goes to stdin (with no message argument,
 * `run` reads it from there) and nothing more can be sent while the agent
 * works. The stream is the session's parts as they finish — `step_start`,
 * `text`, `reasoning`, `tool_use`, `step_finish` with tokens and cost — plus
 * `error`. There is no final event: the process exits once the session is
 * idle, and the reason the last step finished says how the turn ended.
 *
 * Permissions, MCP servers and the agent `ask()` answers with go in through
 * the environment (`OPENCODE_PERMISSION`, `OPENCODE_CONFIG_CONTENT`): nothing
 * is written into the project or the user's config.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { clip, describeTool, shortPath, tidyPaths } from '../humanize.js';
import type { Usage } from '../types.js';
import { emptyUsage } from '../types.js';
import {
  type Adapter,
  type Launch,
  type LaunchPlan,
  num,
  type Outcome,
  obj,
  type ParsedEvent,
  type StreamParser,
  str,
} from './adapter.js';
import { ANSWER_SYSTEM } from './claude.js';

/** The agent one-shot answers run as: its prompt replaces OpenCode's coding persona. */
export const ANSWER_AGENT = 'brainyard-answer';

const WEB_TOOLS = ['webfetch', 'websearch', 'codesearch'];

// A refused tool call: asked and rejected (`run` answers every question with
// no) or denied by a rule.
const DENIED = /rejected permission|rule which prevents you/i;

type Rule = 'allow' | 'deny';

export const opencode: Adapter = {
  id: 'opencode',
  messageIsTurn: true,

  plan(launch: Launch): LaunchPlan {
    const warnings: string[] = [];
    const args = ['run', '--format', 'json'];
    // An empty title names the session after the prompt; without one OpenCode
    // spends another model call on a generated title.
    if (!launch.resume) args.push('--title=');
    if (launch.flags.has('--thinking')) args.push('--thinking');

    const permission: Record<string, Rule> = {};
    if (launch.access === 'full') {
      // `run` rejects whatever would need a question — a path outside the
      // folder above all. `--auto` approves it; explicit denials still hold.
      const old = launch.flags.has('--dangerously-skip-permissions') && !launch.flags.has('--auto');
      args.push(old ? '--dangerously-skip-permissions' : '--auto');
    } else if (launch.access === 'workspace') {
      permission.external_directory = 'deny';
      if (launch.shell) {
        // There is no sandbox: a command writes wherever it points (checked:
        // `echo x > ~/file` went through). Workspace access keeps the shell
        // only where a CLI can confine it.
        permission.bash = 'deny';
        warnings.push(
          'OpenCode cannot confine its shell to the folder, so workspace access turns the shell off; use full access to run commands',
        );
      }
    } else {
      permission.edit = 'deny';
      permission.bash = 'deny';
    }
    if (!launch.web) for (const tool of WEB_TOOLS) permission[tool] = 'deny';
    if (!launch.shell) permission.bash = 'deny';

    const config: Record<string, unknown> = {
      // Without it a refused tool ends the turn on the spot, without a word;
      // with it the agent hears the refusal and answers.
      experimental: { continue_loop_on_deny: true },
    };
    const servers = Object.entries(launch.mcpServers);
    if (servers.length > 0) {
      config.mcp = Object.fromEntries(
        servers.map(([name, server]) => [
          name,
          {
            type: 'local',
            command: [server.command, ...(server.args ?? [])],
            ...(server.env ? { environment: server.env } : {}),
          },
        ]),
      );
    }

    const env: Record<string, string> = {};
    let prompt = launch.prompt;
    if (launch.isolated) {
      // An answer is not an agent run: its own instructions instead of the
      // coding persona, and for `readonly` no tools at all. Tool definitions
      // are most of the prompt: 8.7k tokens for "pong" with them, 0.2k without.
      const agent: Record<string, unknown> = {
        description: 'One-shot answers for Brainyard',
        mode: 'primary',
        prompt: launch.system?.trim() || ANSWER_SYSTEM,
      };
      if (launch.access === 'readonly') {
        agent.permission = {
          '*': 'deny',
          ...(launch.web ? Object.fromEntries(WEB_TOOLS.map((tool) => [tool, 'allow'])) : {}),
        };
      }
      config.agent = { [ANSWER_AGENT]: agent };
      args.push('--agent', ANSWER_AGENT);
      // OpenCode reads Claude Code's CLAUDE.md and skills too; an answer has no use for them.
      env.OPENCODE_DISABLE_CLAUDE_CODE = '1';
    } else if (launch.system?.trim()) {
      prompt = `${launch.system.trim()}\n\n${launch.prompt}`;
    }

    // What the caller's environment already sets stays, under ours.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(merge(jsonObject(process.env.OPENCODE_CONFIG_CONTENT), config));
    if (Object.keys(permission).length > 0) {
      env.OPENCODE_PERMISSION = JSON.stringify({ ...jsonObject(process.env.OPENCODE_PERMISSION), ...permission });
    }

    if (launch.resume) args.push('--session', launch.resume);
    if (launch.model) args.push('--model', launch.model);
    if (launch.effort) args.push('--variant', launch.effort);
    args.push(...launch.extraArgs);
    return { args, prompt, input: 'text', env, warnings };
  },

  message(text: string): string {
    return text;
  },

  parser(cwd: string, model?: string, mcpServers: readonly string[] = []): StreamParser {
    return new OpencodeParser(cwd, model ?? opencodeDefaultModel(), mcpServers);
  },
};

/**
 * The model OpenCode runs when none is given: `model` from the inline config,
 * else from the config files it loads (the later one wins).
 */
export function opencodeDefaultModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const inline = jsonObject(env.OPENCODE_CONFIG_CONTENT).model;
  if (typeof inline === 'string' && inline) return inline;
  const dir = join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'opencode');
  const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => join(dir, name));
  if (env.OPENCODE_CONFIG?.trim()) files.push(env.OPENCODE_CONFIG.trim());
  let model: string | undefined;
  for (const file of files) {
    let value: unknown;
    try {
      value = obj(parseJsonc(readFileSync(file, 'utf8'))).model;
    } catch {
      continue;
    }
    if (typeof value === 'string' && value) model = value;
  }
  return model;
}

/** JSON with comments and trailing commas, the way OpenCode's config files are written. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(withoutTrailingCommas(withoutComments(text)));
}

function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end - 1;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

function withoutTrailingCommas(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end - 1;
    } else if (char === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      // A comma right before a closing bracket.
    } else {
      out += char;
    }
  }
  return out;
}

/** Index just past the string that starts with the quote at `start`. */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

function jsonObject(text: string | undefined): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    return obj(JSON.parse(text));
  } catch {
    return {};
  }
}

function merge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? merge(obj(current), obj(value))
        : value;
  }
  return out;
}

class OpencodeParser implements StreamParser {
  readonly #cwd: string;
  readonly #model: string | undefined;
  /** `[name, prefix]`: OpenCode names an MCP tool `<server>_<tool>`. Longest first. */
  readonly #servers: [string, string][];
  #sessionId: string | undefined;
  #stepTexts: string[] = [];
  #text = '';
  readonly #usage: Usage = emptyUsage();
  #cost = 0;
  #error: string | undefined;
  #results = 0;
  readonly #denied: string[] = [];

  constructor(cwd: string, model: string | undefined, servers: readonly string[]) {
    this.#cwd = cwd;
    this.#model = model;
    this.#servers = servers
      .map((name): [string, string] => [name, `${name.replace(/[^A-Za-z0-9_-]/g, '_')}_`])
      .sort((a, b) => b[1].length - a[1].length);
  }

  get queuedTurns(): number {
    return 0;
  }

  push(event: Record<string, unknown>): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    const session = str(event.sessionID);
    if (session && !this.#sessionId) {
      this.#sessionId = session;
      events.push({
        kind: 'init',
        // OpenCode does not name the model in its stream; this is the one asked for or configured.
        summary: `OpenCode started${this.#model ? ` · ${this.#model}` : ''}`,
        feed: true,
        data: { model: this.#model, sessionId: session },
      });
    }
    const part = obj(event.part);
    // Subagents work in sessions of their own: only the run's session speaks for it.
    const own = !str(part.sessionID) || str(part.sessionID) === this.#sessionId;
    switch (event.type) {
      case 'step_start':
        if (own) this.#stepTexts = [];
        break;
      case 'text': {
        const text = str(part.text);
        if (!own || !text.trim()) break;
        // Replies come per step ("let me check" before a tool call, the answer
        // after it): the answer is the text of the last step that had any.
        this.#stepTexts.push(text.trim());
        this.#text = this.#stepTexts.join('\n\n');
        events.push({ kind: 'message', summary: clip(tidyPaths(text, this.#cwd), 200), text, feed: true });
        break;
      }
      case 'reasoning': {
        const text = str(part.text);
        if (text.trim()) events.push({ kind: 'thinking', summary: clip(text, 200), text, feed: false });
        break;
      }
      case 'tool_use':
        events.push(...this.#tool(part));
        break;
      case 'step_finish':
        events.push(...this.#finish(part, own));
        break;
      case 'error':
        events.push(this.#fail(obj(event.error)));
        break;
      default:
        break;
    }
    return events;
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
    // OpenCode prices tokens from its model catalog. A provider without prices
    // reports 0: an unknown price, not a free run.
    if (this.#cost > 0) out.costUsd = this.#cost;
    if (this.#error) out.error = this.#error;
    return out;
  }

  /** A tool call arrives once, finished: the action, or what went wrong with it. */
  #tool(part: Record<string, unknown>): ParsedEvent[] {
    const name = str(part.tool) || 'tool';
    const state = obj(part.state);
    const input = obj(state.input);
    if (str(state.status) === 'error') {
      const error = str(state.error) || 'failed';
      if (DENIED.test(error)) {
        if (!this.#denied.includes(name)) this.#denied.push(name);
        return [
          {
            kind: 'denied',
            summary: `the CLI refused ${name}`,
            tool: name,
            input,
            feed: true,
            data: { tool: name, reason: clip(error, 200) },
          },
        ];
      }
      return [
        {
          kind: 'tool_result',
          summary: `${name} failed: ${clip(tidyPaths(error, this.#cwd), 140)}`,
          text: error,
          tool: name,
          input,
          feed: true,
          data: { isError: true },
        },
      ];
    }
    const { kind, summary } = this.#describe(name, input);
    const metadata = obj(state.metadata);
    const output = str(metadata.output ?? state.output);
    const exit = metadata.exit;
    const failed = typeof exit === 'number' && exit !== 0;
    return [
      { kind, summary, tool: name, input, feed: true },
      {
        kind: 'tool_result',
        summary: failed
          ? `command failed (exit ${exit}): ${clip(tidyPaths(output, this.#cwd), 140)}`
          : `${name} → ${clip(tidyPaths(output, this.#cwd), 140)}`,
        text: output,
        tool: name,
        // A successful result is the file just read or "Wrote file
        // successfully": the feed already said what happened.
        feed: failed,
        data: { isError: failed, ...(typeof exit === 'number' ? { exitCode: exit } : {}) },
      },
    ];
  }

  #describe(name: string, input: Record<string, unknown>): ReturnType<typeof describeTool> {
    for (const [server, prefix] of this.#servers) {
      if (name.startsWith(prefix))
        return { kind: 'tool_call', summary: `called ${server}: ${name.slice(prefix.length)}` };
    }
    if (name === 'apply_patch' || name === 'patch') {
      const files = [...str(input.patchText).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) =>
        shortPath(str(match[1]).trim(), this.#cwd),
      );
      return {
        kind: 'file_write',
        summary: files.length > 0 ? `edited ${clip(files.join(', '), 120)}` : 'applied a patch',
      };
    }
    return describeTool(name, input, this.#cwd);
  }

  #finish(part: Record<string, unknown>, own: boolean): ParsedEvent[] {
    const tokens = obj(part.tokens);
    const cache = obj(tokens.cache);
    const reasoning = num(tokens.reasoning);
    // Every step is a call of its own and reports only its own tokens. OpenCode
    // counts reasoning apart from output; here it is a part of it.
    this.#usage.inputTokens += num(tokens.input);
    this.#usage.outputTokens += num(tokens.output) + reasoning;
    this.#usage.reasoningTokens += reasoning;
    this.#usage.cacheReadTokens += num(cache.read);
    this.#usage.cacheWriteTokens += num(cache.write);
    this.#cost += num(part.cost);
    const reason = str(part.reason);
    // `tool-calls` means another step follows; any other reason ends the turn.
    if (!own || reason === 'tool-calls') return [];
    this.#results += 1;
    if (reason === 'length') {
      return [
        { kind: 'warning', summary: 'the answer stopped at the model’s output limit', feed: true, data: { reason } },
      ];
    }
    return [];
  }

  #fail(error: Record<string, unknown>): ParsedEvent {
    const data = obj(error.data);
    const ref = str(data.ref);
    // "Unexpected server error" says nothing by itself; OpenCode's log has the
    // cause under this reference.
    const message = `${str(data.message) || str(error.name) || 'error'}${ref ? ` (OpenCode log: ${ref})` : ''}`;
    this.#error = message;
    this.#results += 1;
    return {
      kind: 'error',
      summary: clip(message, 200),
      feed: true,
      data: { name: str(error.name), ...(typeof data.statusCode === 'number' ? { status: data.statusCode } : {}) },
    };
  }
}
