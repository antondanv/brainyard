/**
 * Public types. Everything a CLI emits is translated into these shapes: the
 * native event schema of Claude Code, Codex or Antigravity never leaks out.
 */

/** The agentic CLIs Brainyard drives. */
export type BrainId = 'claude' | 'codex' | 'antigravity';

/** Every id Brainyard knows, in display order. */
export const BRAIN_IDS: readonly BrainId[] = ['claude', 'codex', 'antigravity'];

/** Reasoning effort levels across all three CLIs, from lowest to highest. */
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const EFFORT_ORDER: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * What the agent may do on its own. A headless CLI has nobody to ask, so a
 * tool that would need approval is simply denied — pick the level up front.
 *
 * - `full` — every built-in tool, no prompts (shell, file writes anywhere, web).
 * - `workspace` — edits inside the working directory; shell only where the
 *   CLI can sandbox it.
 * - `readonly` — read and search, change nothing.
 */
export type Access = 'full' | 'workspace' | 'readonly';

/** A stdio MCP server, in the shape every CLI can be taught to load. */
export interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Token usage of a run. `inputTokens` excludes cached input; reasoning tokens
 * are a breakdown of `outputTokens`, not an addition to it.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

/**
 * The closed list of things that can happen during a run.
 *
 * - `init` — the CLI started: model, session id.
 * - `thinking` — a reasoning block (kept out of the human feed).
 * - `message` — the agent said something.
 * - `tool_call` / `command` / `file_write` — the agent did something.
 * - `tool_result` — what a tool returned (in the feed only when it failed).
 * - `hint` — your message reached the running agent.
 * - `denied` — the CLI refused a tool the agent wanted.
 * - `warning` — something you asked for is not enforced, or a limit is near.
 * - `error` — something broke; the run may still continue.
 * - `stopped` — the run was stopped by you, a signal or a timeout.
 * - `done` — the run ended (successfully or not); always the last event.
 */
export type EventKind =
  | 'init'
  | 'thinking'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'command'
  | 'file_write'
  | 'hint'
  | 'denied'
  | 'warning'
  | 'error'
  | 'stopped'
  | 'done';

export interface AgentEvent {
  /** 1-based position in the run. */
  seq: number;
  /** ISO timestamp. */
  at: string;
  brain: BrainId;
  kind: EventKind;
  /** One human-readable line. Secrets are redacted. */
  summary: string;
  /**
   * Worth showing in a human feed. False for ceremony that happens in every
   * run (a successful tool result, a reasoning block): true, but not news.
   */
  feed: boolean;
  /** Full text of a message or reasoning block. */
  text?: string;
  /** Tool name as the CLI calls it. */
  tool?: string;
  /** Tool input as the CLI sent it. */
  input?: Record<string, unknown>;
  /** Kind-specific details (model and session id on `init`, totals on `done`). */
  data?: Record<string, unknown>;
  /** The original CLI event. Only with `includeRaw: true`; its shape is the CLI's and may change. */
  raw?: unknown;
}

export type ErrorKind =
  | 'invalid_option'
  | 'not_installed'
  | 'not_logged_in'
  | 'rate_limited'
  | 'usage_limit'
  | 'network'
  | 'timeout'
  | 'stopped'
  | 'empty_answer'
  | 'failed';

export interface RunError {
  kind: ErrorKind;
  message: string;
  /** Worth retrying after a pause (throttling, a dropped connection). */
  retryable: boolean;
  /** When a subscription limit resets, as the CLI wrote it ("6:50pm"). */
  resetsAt?: string;
}

/** Subscription window usage, as reported by the CLI (Claude Code only today). */
export interface LimitWindow {
  window: string;
  /** 0..1 */
  utilization: number;
  /** Unix seconds. */
  resetsAt?: number;
}

export interface RunResult {
  /** The CLI finished its turn without an error and without being stopped. */
  ok: boolean;
  brain: BrainId;
  /** The agent's final answer. */
  text: string;
  /** Pass to `resume` to continue this conversation. */
  sessionId?: string;
  model?: string;
  usage: Usage;
  /** Reported by the CLI (Claude Code), estimated from `prices`, or unknown. */
  costUsd: number | null;
  costSource: 'cli' | 'estimate' | null;
  durationMs: number;
  exitCode: number | null;
  /** Tool calls, commands and file writes the agent made. */
  toolCalls: number;
  /** Tools the CLI refused. */
  deniedTools: string[];
  /** Options that could not be enforced by this CLI, and other notes. */
  warnings: string[];
  /** Hints that reached the running agent. */
  hints: string[];
  stopped: boolean;
  limits: LimitWindow[];
  error?: RunError;
  events: AgentEvent[];
  /** The start of what the CLI printed to stderr (the error is usually on the first line). */
  stderr: string;
}

/** Dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Defaults to 10% of input. */
  cacheRead?: number;
  /** Defaults to 125% of input. */
  cacheWrite?: number;
}

export interface RunOptions {
  brain: BrainId | string;
  prompt: string;
  /** Working directory of the agent. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Model id or alias the CLI understands (`sonnet`, `gpt-5.5`, `gemini-3.8-flash`). */
  model?: string;
  effort?: Effort | string;
  /** Session id from a previous result: continue that conversation. */
  resume?: string;
  /** Defaults to `full` for runs. */
  access?: Access;
  /** Let the agent search and read the web. Defaults to true for runs. */
  web?: boolean;
  /** Let the agent run shell commands. Defaults to true. */
  shell?: boolean;
  mcpServers?: Record<string, McpServer>;
  /** Extra environment for the CLI process. */
  env?: Record<string, string>;
  /** Raw arguments appended to the CLI call. You know which CLI you are talking to. */
  extraArgs?: string[];
  /** Executable to run instead of the default (`claude`, `codex`, `agy`); an array adds leading arguments. */
  command?: string | string[];
  /**
   * Keep the CLI's input open so `hint()` can reach the running agent.
   * Defaults to true where the CLI supports it (Claude Code, Antigravity).
   */
  steerable?: boolean;
  /** Hard time limit. None by default: a run killed halfway is paid in full and returns nothing. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for every event as it happens. */
  onEvent?: (event: AgentEvent) => void;
  /** Check model and effort against the CLI's catalog before starting. Defaults to true. */
  validate?: boolean;
  /**
   * When a turn ends without a text answer, ask once — in the same
   * conversation — to finish it. CLIs sometimes end a turn silently (a refused
   * tool, a crashed built-in tool); a new process would not remember what it
   * tripped over. Claude Code and Antigravity only. Defaults to true.
   */
  nudge?: boolean;
  /** Attach the original CLI event to every event as `raw`. */
  includeRaw?: boolean;
  /** Estimate cost for CLIs that report only tokens. */
  prices?: Record<string, ModelPrice>;
}

export interface AskOptions {
  model?: string;
  effort?: Effort | string;
  /** Instructions that frame the answer. */
  system?: string;
  /** Let the model search the web. Defaults to false. */
  web?: boolean;
  /** Defaults to `readonly`: an answer, not actions. */
  access?: Access;
  /** Defaults to a fresh empty directory, removed afterwards. */
  cwd?: string;
  env?: Record<string, string>;
  command?: string | string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  validate?: boolean;
  prices?: Record<string, ModelPrice>;
}

export interface AskResult {
  brain: BrainId;
  text: string;
  model?: string;
  sessionId?: string;
  usage: Usage;
  costUsd: number | null;
  costSource: 'cli' | 'estimate' | null;
  durationMs: number;
  limits: LimitWindow[];
}
