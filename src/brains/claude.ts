/**
 * Claude Code: `claude -p --output-format stream-json --verbose`.
 *
 * Event shapes were taken from the running CLI, not from memory:
 * `system/init`, `rate_limit_event`, `assistant`, `user`, `result`. The
 * dollar cost comes in `result.total_cost_usd`, computed by the CLI.
 */
import { clip, describeTool, oneLine, tidyPaths } from '../humanize.js';
import type { LimitWindow, Usage } from '../types.js';
import { emptyUsage } from '../types.js';
import {
  type Adapter,
  isRoot,
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

const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const SHELL_TOOLS = ['Bash'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * One-shot answers replace Claude Code's agent persona. By default it is "an
 * agent in a repository", which is not a neutral background for an answer —
 * it is a competing set of instructions.
 */
export const ANSWER_SYSTEM = 'Answer the request directly and completely. Reply with the answer only.';

// MCP servers in these states will not give the agent their tools. Anything
// else (`connected`, `pending` while it starts) is fine: `pending` is what a
// healthy server reports at init, and treating it as a failure is a false alarm.
const MCP_BROKEN = new Set(['failed', 'error', 'disconnected', 'needs-auth', 'needs_auth']);

export const claude: Adapter = {
  id: 'claude',
  messageIsTurn: false,

  plan(launch: Launch): LaunchPlan {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    const env: Record<string, string> = {};
    // The prompt never travels as an argument: `-p` is a boolean flag, the
    // prompt would be a positional argument, and a prompt starting with a
    // dash ("---" front matter) is parsed as an unknown option.
    const input = launch.steerable ? 'stream-json' : 'text';
    if (input === 'stream-json') args.push('--input-format', 'stream-json');
    if (launch.resume) args.push('--resume', launch.resume);

    const blocked: string[] = [];
    const allowed: string[] = [];
    if (launch.access === 'full') {
      args.push('--dangerously-skip-permissions');
      // As root the flag is refused ("cannot be used with root/sudo
      // privileges") unless IS_SANDBOX=1 — which is what a container is.
      if (isRoot()) env.IS_SANDBOX = '1';
    } else if (launch.access === 'workspace') {
      args.push('--permission-mode', 'acceptEdits');
    } else {
      // `dontAsk` refuses whatever would need approval instead of waiting for
      // an answer nobody will give. Reads never need approval.
      args.push('--permission-mode', 'dontAsk');
      blocked.push(...WRITE_TOOLS, ...SHELL_TOOLS);
    }
    if (launch.web) {
      if (launch.access !== 'full') allowed.push(...WEB_TOOLS);
    } else {
      blocked.push(...WEB_TOOLS);
    }
    if (!launch.shell && !blocked.includes('Bash')) blocked.push(...SHELL_TOOLS);

    if (launch.isolated) {
      // An answer must not pick up the user's MCP servers, CLAUDE.md, hooks or
      // skills: they would silently end up in the prompt.
      args.push('--strict-mcp-config');
      if (launch.flags.has('--safe-mode')) args.push('--safe-mode');
      if (launch.flags.has('--no-session-persistence')) args.push('--no-session-persistence');
      args.push('--system-prompt', launch.system?.trim() || ANSWER_SYSTEM);
      // No tools at all when there is nothing to use them for: tool
      // definitions are the bulk of the prompt, and every call pays for them.
      if (launch.access === 'readonly' && launch.flags.has('--tools')) {
        args.push('--tools', launch.web ? WEB_TOOLS.join(',') : '');
      }
    }

    if (allowed.length > 0) args.push('--allowedTools', allowed.join(','));
    if (blocked.length > 0) args.push('--disallowedTools', blocked.join(','));
    if (launch.model) args.push('--model', launch.model);
    if (launch.effort) args.push('--effort', launch.effort);
    if (Object.keys(launch.mcpServers).length > 0) {
      // Without --strict-mcp-config the user's own servers stay available.
      args.push('--mcp-config', JSON.stringify({ mcpServers: launch.mcpServers }));
    }
    args.push(...launch.extraArgs);
    return { args, prompt: launch.prompt, input, env, warnings: [] };
  },

  message(text: string): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  },

  parser(cwd: string, model?: string): StreamParser {
    return new ClaudeParser(cwd, model);
  },
};

class ClaudeParser implements StreamParser {
  readonly #cwd: string;
  #text = '';
  #sessionId: string | undefined;
  #model: string | undefined;
  #usage: Usage | undefined;
  readonly #perMessage = new Map<string, Usage>();
  #cost: number | undefined;
  #error: string | undefined;
  #denied: string[] = [];
  readonly #limits = new Map<string, LimitWindow>();
  #limitStatus = 'allowed';
  #results = 0;
  #queued = 0;
  readonly #toolNames = new Map<string, string>();

  constructor(cwd: string, model?: string) {
    this.#cwd = cwd;
    this.#model = model;
  }

  get queuedTurns(): number {
    return this.#queued;
  }

  push(event: Record<string, unknown>): ParsedEvent[] {
    switch (event.type) {
      case 'system':
        return this.#system(event);
      case 'assistant':
        return this.#assistant(event);
      case 'user':
        return this.#user(event);
      case 'result':
        return this.#result(event);
      case 'rate_limit_event':
        return this.#rateLimit(event);
      default:
        return [];
    }
  }

  outcome(): Outcome {
    const out: Outcome = {
      text: this.#text,
      usage: this.#usage ?? sum(this.#perMessage.values()),
      deniedTools: [...this.#denied],
      limits: [...this.#limits.values()],
      results: this.#results,
    };
    if (this.#sessionId) out.sessionId = this.#sessionId;
    if (this.#model) out.model = this.#model;
    if (this.#cost !== undefined) out.costUsd = this.#cost;
    if (this.#error) out.error = this.#error;
    return out;
  }

  #system(event: Record<string, unknown>): ParsedEvent[] {
    if (event.subtype !== 'init') return [];
    this.#model = str(event.model) || this.#model;
    this.#sessionId = str(event.session_id) || this.#sessionId;
    const tools = list(event.tools);
    const events: ParsedEvent[] = [
      {
        kind: 'init',
        summary: `Claude Code started${this.#model ? ` · ${this.#model}` : ''}`,
        feed: true,
        data: {
          model: this.#model,
          sessionId: this.#sessionId,
          tools: tools.length,
          permissionMode: str(event.permissionMode) || undefined,
          version: str(event.claude_code_version) || undefined,
        },
      },
    ];
    // A server that did not come up means tools silently taken away: the agent
    // will not say so, it will just do the job with what is left.
    const broken = list(event.mcp_servers)
      .map(obj)
      .filter((server) => MCP_BROKEN.has(str(server.status).toLowerCase()))
      .map((server) => `${str(server.name) || '?'} (${str(server.status)})`);
    if (broken.length > 0) {
      events.push({
        kind: 'warning',
        summary: `MCP servers did not start: ${broken.join(', ')} — their tools are unavailable`,
        feed: true,
        data: { mcpServers: broken },
      });
    }
    return events;
  }

  #assistant(event: Record<string, unknown>): ParsedEvent[] {
    const message = obj(event.message);
    this.#model = str(message.model) || this.#model;
    this.#rememberUsage(message);
    const events: ParsedEvent[] = [];
    for (const raw of list(message.content)) {
      const block = obj(raw);
      if (block.type === 'thinking') {
        const text = str(block.thinking);
        if (text.trim()) events.push({ kind: 'thinking', summary: clip(text, 200), text, feed: false });
      } else if (block.type === 'text') {
        const text = str(block.text);
        if (text.trim()) {
          this.#text = text;
          events.push({ kind: 'message', summary: clip(tidyPaths(text, this.#cwd), 200), text, feed: true });
        }
      } else if (block.type === 'tool_use') {
        const name = str(block.name) || 'tool';
        const input = obj(block.input);
        const id = str(block.id);
        if (id) this.#toolNames.set(id, name);
        const { kind, summary } = describeTool(name, input, this.#cwd);
        events.push({ kind, summary, tool: name, input, feed: true });
      }
    }
    return events;
  }

  #user(event: Record<string, unknown>): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    for (const raw of list(obj(event.message).content)) {
      const block = obj(raw);
      if (block.type !== 'tool_result') continue;
      const failed = block.is_error === true;
      const body = flatten(block.content);
      const tool = this.#toolNames.get(str(block.tool_use_id));
      events.push({
        kind: 'tool_result',
        summary: failed
          ? `${tool ?? 'tool'} failed: ${clip(tidyPaths(body, this.#cwd), 160)}`
          : `${tool ?? 'tool'} → ${clip(tidyPaths(body, this.#cwd), 160)}`,
        text: body,
        ...(tool ? { tool } : {}),
        // A successful result is the file just read or "File created
        // successfully": the feed already said what happened. A failure is
        // the most interesting line there is.
        feed: failed,
        data: { isError: failed },
      });
    }
    return events;
  }

  #result(event: Record<string, unknown>): ParsedEvent[] {
    this.#results += 1;
    // `result` ends a turn, not the process: with stdin open the CLI waits
    // for the next message. The runner closes stdin once nothing is queued.
    this.#queued = num(event.queued_turn_count);
    this.#sessionId = str(event.session_id) || this.#sessionId;
    if (typeof event.total_cost_usd === 'number') this.#cost = event.total_cost_usd;
    const text = str(event.result);
    if (event.is_error === true) {
      const status = event.api_error_status ? `API error ${str(event.api_error_status)}: ` : '';
      this.#error = `${status}${oneLine(text) || str(event.subtype) || 'error'}`;
    } else {
      this.#error = undefined;
      if (text) this.#text = text;
    }
    const usage = obj(event.usage);
    if (Object.keys(usage).length > 0) {
      // The total from `result`, not a sum of messages: the same input
      // repeats across messages, and adding them up counts it twice.
      this.#usage = {
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        cacheWriteTokens: num(usage.cache_creation_input_tokens),
        reasoningTokens: num(obj(usage.output_tokens_details).thinking_tokens),
      };
    }
    const events: ParsedEvent[] = [];
    const denied = list(event.permission_denials)
      .map((d) => str(obj(d).tool_name) || str(d))
      .filter(Boolean);
    for (const tool of denied) {
      if (!this.#denied.includes(tool)) this.#denied.push(tool);
      events.push({ kind: 'denied', summary: `the CLI refused ${tool}`, tool, feed: true, data: { tool } });
    }
    return events;
  }

  #rateLimit(event: Record<string, unknown>): ParsedEvent[] {
    const info = obj(event.rate_limit_info);
    for (const [window, raw] of Object.entries(obj(info.unifiedWindows))) {
      const entry = obj(raw);
      const limit: LimitWindow = { window, utilization: num(entry.utilization) };
      if (entry.resetsAt !== undefined) limit.resetsAt = num(entry.resetsAt);
      this.#limits.set(window, limit);
    }
    const status = str(info.status);
    if (!status || status === this.#limitStatus) return [];
    this.#limitStatus = status;
    if (status === 'allowed') return [];
    const window = str(info.rateLimitType) || 'usage';
    const current = this.#limits.get(window);
    const share = current ? ` at ${Math.round(current.utilization * 100)}%` : '';
    const resets = num(info.resetsAt) ? `, resets ${new Date(num(info.resetsAt) * 1000).toLocaleString()}` : '';
    return [
      {
        kind: 'warning',
        summary:
          status === 'rejected'
            ? `Claude usage limit reached (${window}${resets})`
            : `Claude usage: ${window} window${share}${resets}`,
        feed: true,
        data: { status, window, limits: [...this.#limits.values()] },
      },
    ];
  }

  #rememberUsage(message: Record<string, unknown>): void {
    // One message arrives as several events with the same usage; keep it per id.
    const usage = obj(message.usage);
    const id = str(message.id);
    if (!id || Object.keys(usage).length === 0) return;
    this.#perMessage.set(id, {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      reasoningTokens: 0,
    });
  }
}

function sum(values: Iterable<Usage>): Usage {
  const total = emptyUsage();
  for (const usage of values) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.reasoningTokens += usage.reasoningTokens;
  }
  return total;
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => str(obj(block).text))
      .filter(Boolean)
      .join(' ');
  }
  return str(content);
}
