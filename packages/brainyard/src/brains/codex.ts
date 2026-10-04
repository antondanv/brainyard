/**
 * Codex: `codex exec --json`.
 *
 * Two differences from the others worth knowing. Codex reports no dollar
 * cost, only tokens (`turn.completed.usage`). And it takes no input while it
 * works: the prompt goes to stdin (`-`), stdin closes, and that is the only
 * message of the run.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { clip, describeTool, shortPath, tidyPaths, unDouble } from '../humanize.js';
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

type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

const SANDBOX: Record<Launch['access'], Sandbox> = {
  full: 'danger-full-access',
  workspace: 'workspace-write',
  readonly: 'read-only',
};

export const codex: Adapter = {
  id: 'codex',
  messageIsTurn: true,

  plan(launch: Launch): LaunchPlan {
    const warnings: string[] = [];
    let sandbox = SANDBOX[launch.access];
    if (!launch.shell) {
      // Codex has no switch for its shell; its sandbox is the only lever.
      if (sandbox === 'danger-full-access') sandbox = 'workspace-write';
      if (launch.shellAsked) {
        warnings.push(`Codex cannot switch its shell off; it stays on inside the ${sandbox} sandbox`);
      }
    }
    // `--sandbox` always: without it `codex exec` is read-only and cannot write
    // anything. `exec resume` has no `--sandbox` flag, so there it goes as config.
    const args = launch.resume
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode=${toml(sandbox)}`]
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox];
    // A setting, not a flag: `--search` exists for interactive `codex` only.
    args.push('-c', `tools.web_search=${launch.web ? 'true' : 'false'}`);
    for (const [name, server] of Object.entries(launch.mcpServers)) {
      // MCP servers are config too. `codex exec` asks for approval of every MCP
      // call, and in a non-interactive run nobody answers: the call is
      // cancelled ("user cancelled MCP tool call"). Approval is lifted per
      // server, not by dropping the sandbox.
      const path = `mcp_servers.${name}`;
      args.push('-c', `${path}.command=${toml(server.command)}`);
      if (server.args?.length) args.push('-c', `${path}.args=${toml(server.args)}`);
      if (server.env && Object.keys(server.env).length > 0) args.push('-c', `${path}.env=${toml(server.env)}`);
      args.push('-c', `${path}.default_tools_approval_mode="approve"`);
    }
    if (launch.model) args.push('-m', launch.model);
    if (launch.effort) args.push('-c', `model_reasoning_effort=${toml(launch.effort)}`);
    if (launch.isolated && launch.flags.has('--ephemeral')) args.push('--ephemeral');
    args.push(...launch.extraArgs);
    // `-` means "read the prompt from stdin": an argument starting with a
    // dash would be taken for an option.
    if (launch.resume) args.push(launch.resume, '-');
    else args.push('-');
    const prompt = launch.system?.trim() ? `${launch.system.trim()}\n\n${launch.prompt}` : launch.prompt;
    return { args, prompt, input: 'text', env: {}, warnings };
  },

  message(text: string): string {
    return text;
  },

  parser(cwd: string, model?: string): StreamParser {
    return new CodexParser(cwd, model ?? codexDefaultModel());
  },
};

/**
 * A value for `-c key=value`: Codex parses the right side as TOML. Three forms
 * are needed — string, list of strings, flat table — so no TOML dependency.
 */
export function toml(value: string | readonly string[] | Record<string, string>): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(',')}]`;
  const entries = Object.entries(value as Record<string, string>).map(
    ([key, item]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}=${JSON.stringify(String(item))}`,
  );
  return `{${entries.join(',')}}`;
}

/** The model Codex uses when none is given, from its own config. */
export function codexDefaultModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  try {
    const text = readFileSync(join(home, 'config.toml'), 'utf8');
    // Top-level `model = "..."`, before the first [table].
    const top = text.split(/^\s*\[/m)[0] ?? '';
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(top)?.[1];
  } catch {
    return undefined;
  }
}

// `/bin/zsh -lc 'cat hello.txt'` → `cat hello.txt`: the wrapper is Codex's, not the agent's.
const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(?:(['"])([\s\S]*)\1|(\S+))$/;

export function unwrap(command: string): string {
  const match = SHELL_WRAPPER.exec(command.trim());
  return match?.[2] ?? match?.[3] ?? command;
}

class CodexParser implements StreamParser {
  readonly #cwd: string;
  readonly #model: string | undefined;
  #text = '';
  #sessionId: string | undefined;
  readonly #usage: Usage = emptyUsage();
  #error: string | undefined;
  #lastError: string | undefined;
  #results = 0;
  readonly #seen = new Set<string>();

  constructor(cwd: string, model?: string) {
    this.#cwd = cwd;
    this.#model = model;
  }

  get queuedTurns(): number {
    return 0;
  }

  push(event: Record<string, unknown>): ParsedEvent[] {
    switch (event.type) {
      case 'thread.started':
        this.#sessionId = str(event.thread_id) || this.#sessionId;
        return [
          {
            kind: 'init',
            // Codex does not name the model in its stream; this is the one asked for or configured.
            summary: `Codex started${this.#model ? ` · ${this.#model}` : ''}`,
            feed: true,
            data: { model: this.#model, sessionId: this.#sessionId },
          },
        ];
      case 'item.started':
        return this.#item(obj(event.item), false);
      case 'item.completed':
        return this.#item(obj(event.item), true);
      case 'turn.completed': {
        this.#results += 1;
        const usage = obj(event.usage);
        const cached = num(usage.cached_input_tokens);
        this.#usage.inputTokens += Math.max(0, num(usage.input_tokens) - cached);
        this.#usage.outputTokens += num(usage.output_tokens);
        this.#usage.cacheReadTokens += cached;
        this.#usage.cacheWriteTokens += num(usage.cache_write_input_tokens);
        this.#usage.reasoningTokens += num(usage.reasoning_output_tokens);
        return [];
      }
      case 'turn.failed': {
        this.#results += 1;
        this.#error = str(obj(event.error).message) || this.#lastError || 'the turn failed';
        return [{ kind: 'error', summary: clip(this.#error, 200), feed: true }];
      }
      case 'error': {
        // Stream-level trouble ("reconnecting…"). Remembered in case the
        // turn fails without a message of its own.
        this.#lastError = str(event.message) || 'error';
        return [{ kind: 'error', summary: clip(this.#lastError, 200), feed: true }];
      }
      default:
        return [];
    }
  }

  outcome(): Outcome {
    const out: Outcome = {
      text: this.#text,
      usage: { ...this.#usage },
      deniedTools: [],
      limits: [],
      results: this.#results,
    };
    if (this.#sessionId) out.sessionId = this.#sessionId;
    if (this.#model) out.model = this.#model;
    if (this.#error) out.error = this.#error;
    return out;
  }

  #item(item: Record<string, unknown>, completed: boolean): ParsedEvent[] {
    const id = str(item.id);
    const type = str(item.type);
    const first = !id || !this.#seen.has(id);
    if (id) this.#seen.add(id);
    const status = str(item.status);
    const failed = status === 'failed' || status === 'declined';

    switch (type) {
      case 'agent_message': {
        const text = str(item.text);
        if (!completed || !text.trim()) return [];
        this.#text = text;
        return [{ kind: 'message', summary: clip(tidyPaths(text, this.#cwd), 200), text, feed: true }];
      }
      case 'reasoning': {
        const text = str(item.text);
        if (!completed || !text.trim()) return [];
        return [{ kind: 'thinking', summary: clip(text, 200), text, feed: false }];
      }
      case 'command_execution': {
        const command = unwrap(str(item.command));
        const events: ParsedEvent[] = [];
        if (first) {
          events.push({
            kind: 'command',
            summary: `ran: ${clip(tidyPaths(command, this.#cwd), 100)}`,
            tool: 'shell',
            input: { command },
            feed: true,
          });
        }
        if (completed) {
          const exit = item.exit_code;
          const bad = failed || (typeof exit === 'number' && exit !== 0);
          const output = str(item.aggregated_output);
          events.push({
            kind: 'tool_result',
            summary: bad
              ? `command failed${typeof exit === 'number' ? ` (exit ${exit})` : ''}: ${clip(tidyPaths(output, this.#cwd), 140)}`
              : `shell → ${clip(tidyPaths(output, this.#cwd), 140)}`,
            text: output,
            tool: 'shell',
            feed: bad,
            data: { isError: bad, exitCode: exit },
          });
        }
        return events;
      }
      case 'file_change': {
        if (!completed) return [];
        const groups = new Map<string, string[]>();
        for (const raw of list(item.changes)) {
          const change = obj(raw);
          const verb = { add: 'created', delete: 'deleted', update: 'edited' }[str(change.kind)] ?? 'edited';
          const paths = groups.get(verb) ?? [];
          paths.push(shortPath(str(change.path), this.#cwd));
          groups.set(verb, paths);
        }
        const summary = [...groups].map(([verb, paths]) => `${verb} ${paths.join(', ')}`).join('; ') || 'changed files';
        return [
          {
            kind: failed ? 'error' : 'file_write',
            summary: failed ? `could not apply: ${summary}` : clip(summary, 160),
            tool: 'apply_patch',
            input: { changes: list(item.changes) },
            feed: true,
          },
        ];
      }
      case 'mcp_tool_call': {
        const server = unDouble(str(item.server ?? item.server_name));
        const tool = str(item.tool ?? item.tool_name ?? item.name);
        const events: ParsedEvent[] = [];
        if (first) {
          events.push({
            kind: 'tool_call',
            summary: describeTool(`mcp__${server}__${tool}`).summary,
            tool: `mcp__${server}__${tool}`,
            input: obj(item.arguments ?? item.input),
            feed: true,
          });
        }
        const error = str(obj(item.error).message ?? item.error);
        if (completed && (failed || error)) {
          events.push({
            kind: 'tool_result',
            summary: `${server}: ${tool} failed: ${clip(error || status, 140)}`,
            tool: `mcp__${server}__${tool}`,
            feed: true,
            data: { isError: true },
          });
        }
        return events;
      }
      case 'web_search': {
        if (!completed) return [];
        const query = str(item.query ?? obj(item.action).query);
        return [
          {
            kind: 'tool_call',
            summary: query ? `searched the web: ${clip(query, 100)}` : 'searched the web',
            tool: 'web_search',
            input: query ? { query } : {},
            feed: true,
          },
        ];
      }
      case 'todo_list':
        return first ? [{ kind: 'tool_call', summary: 'updated the plan', tool: 'todo_list', feed: true }] : [];
      case 'error': {
        if (!completed) return [];
        return [{ kind: 'error', summary: clip(str(item.message) || 'error', 200), feed: true }];
      }
      default: {
        if (!completed) return [];
        const text = str(item.text ?? item.message ?? item.command ?? item.query);
        return [
          {
            kind: 'tool_call',
            summary: text ? clip(tidyPaths(text, this.#cwd), 160) : `did ${type || 'a step'}`,
            ...(type ? { tool: type } : {}),
            feed: true,
          },
        ];
      }
    }
  }
}
