import type { Access, AgentEvent, BrainId, LimitWindow, McpServer, Usage } from '../types.js';

/** A run after defaults and validation: what an adapter builds the CLI call from. */
export interface Launch {
  brain: BrainId;
  prompt: string;
  /** Absolute. */
  cwd: string;
  model?: string;
  effort?: string;
  resume?: string;
  access: Access;
  web: boolean;
  /** The caller set `web` (a default the CLI cannot honour is not worth a warning). */
  webAsked: boolean;
  shell: boolean;
  shellAsked: boolean;
  mcpServers: Record<string, McpServer>;
  extraArgs: string[];
  /** Keep stdin open for messages while the agent works. */
  steerable: boolean;
  /** One-shot answer: no project context, no user MCP servers, minimal tools. */
  isolated: boolean;
  /** Framing instructions (one-shot answers). */
  system?: string;
  /** Flags this CLI build supports, from its `--help`. Empty when not probed. */
  flags: ReadonlySet<string>;
}

export interface LaunchPlan {
  args: string[];
  /** The prompt as it goes to stdin. */
  prompt: string;
  /** `text`: the prompt, then EOF. `stream-json`: one JSON message per line, stdin stays open. */
  input: 'text' | 'stream-json';
  env: Record<string, string>;
  warnings: string[];
  /** Removes what the adapter created for this run. */
  cleanup?: () => void;
}

/** An event before the runner stamps it with a number, a time and the brain. */
export type ParsedEvent = Omit<AgentEvent, 'seq' | 'at' | 'brain'>;

export interface Outcome {
  text: string;
  sessionId?: string;
  model?: string;
  usage: Usage;
  costUsd?: number;
  error?: string;
  deniedTools: string[];
  limits: LimitWindow[];
  /** Final result events seen so far. A CLI that exits without one was cut off. */
  results: number;
}

export interface StreamParser {
  /** One JSON object from the CLI's stdout → zero or more events. */
  push(obj: Record<string, unknown>): ParsedEvent[];
  /** Turns the CLI says are still queued (Claude Code reports this in `result`). */
  readonly queuedTurns: number;
  outcome(): Outcome;
}

export interface Adapter {
  readonly id: BrainId;
  /**
   * Whether every message written to stdin becomes its own turn with its own
   * result (Antigravity), rather than being folded into the running turn
   * (Claude Code). Decides when stdin can be closed.
   */
  readonly messageIsTurn: boolean;
  plan(launch: Launch): LaunchPlan;
  /** A user message in this CLI's stream-json input format: one line, no newline. */
  message(text: string): string;
  /** `model`: the one asked for, until the CLI names the one it runs. */
  parser(cwd: string, model?: string): StreamParser;
}

/** Numbers from untyped JSON, without NaN. */
export function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function str(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

export function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
