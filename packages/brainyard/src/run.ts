/**
 * Running an agent: spawn the CLI, feed it the prompt on stdin, translate its
 * stream into events, take hints and stops while it works, and account for
 * what it did.
 */
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { Adapter, LaunchPlan, ParsedEvent, StreamParser } from './brains/adapter.js';
import { ADAPTERS } from './brains/index.js';
import { BRAINS } from './brains/info.js';
import { estimateCost } from './cost.js';
import { BrainyardError, classifyFailure } from './errors.js';
import { clip, oneLine } from './humanize.js';
import { type Mode, type Resolved, resolveBrain, resolveLaunch } from './options.js';
import { spawnCommand, terminate } from './process.js';
import { redact } from './redact.js';
import { EventStream } from './stream.js';
import type { AgentEvent, BrainId, RunError, RunOptions, RunResult } from './types.js';

/** What stays of stderr for the error message: the CLI prints the error first. */
const STDERR_KEEP = 16_000;
const STDERR_SHOWN = 2_000;

/** The follow-up for a turn that ended without text: once, in the same conversation. */
export function continuePrompt(denied: readonly string[]): string {
  const why = denied.length > 0 ? ` (the CLI refused ${denied.join(', ')})` : '';
  return (
    `Your last turn ended without a text answer${why}. ` +
    'Reply now with the final answer to the original request as plain text, and nothing else.'
  );
}

/** A running agent. Iterate it for events; await `result` for the outcome. */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly brain: BrainId;
  /**
   * Resolves when the CLI is done — check `ok`. Rejects only when the run
   * never started: bad options or the CLI is not installed.
   */
  readonly result: Promise<RunResult>;
  /** Whether `hint()` can reach this run (Claude Code, Antigravity, OpenCode). */
  readonly steerable: boolean;
  /** Known once the CLI has started. */
  readonly sessionId: string | undefined;
  /** Events so far. */
  readonly events: readonly AgentEvent[];
  /** Sends a message to the working agent. False when it cannot be delivered. */
  hint(text: string): boolean;
  /** Stops the agent and everything it started. Work done so far stays on disk. */
  stop(reason?: string): void;
}

interface Behaviour extends Mode {
  /** A turn that ends without text gets one follow-up in the same conversation. */
  ensureText?: boolean;
}

class Run implements AgentRun {
  readonly brain: BrainId;
  readonly result: Promise<RunResult>;
  readonly #options: RunOptions;
  readonly #behaviour: Behaviour;
  readonly #adapter: Adapter;
  readonly #label: string;
  readonly #stream = new EventStream<AgentEvent>();
  readonly #steerable: boolean;
  #child: ChildProcess | undefined;
  #parser: StreamParser | undefined;
  #inputOpen = false;
  #unanswered = 0;
  #nudged = false;
  #halted: { kind: 'stopped' | 'timeout'; message: string } | undefined;
  #seq = 0;
  readonly #waiting: string[] = [];
  readonly #hints: string[] = [];

  constructor(options: RunOptions, behaviour: Behaviour) {
    this.brain = resolveBrain(options.brain);
    this.#options = options;
    this.#behaviour = behaviour;
    this.#adapter = ADAPTERS[this.brain];
    const info = BRAINS[this.brain];
    this.#label = info.label;
    this.#steerable = behaviour.kind === 'run' && info.capabilities.steering && options.steerable !== false;
    this.result = this.#execute();
    // Whoever awaits `result` still sees a rejection; nobody awaiting it is not a crash.
    this.result.catch(() => undefined);
  }

  get steerable(): boolean {
    return this.#steerable;
  }

  get sessionId(): string | undefined {
    return this.#parser?.outcome().sessionId;
  }

  get events(): readonly AgentEvent[] {
    return this.#stream.items;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.#stream[Symbol.asyncIterator]();
  }

  hint(text: string): boolean {
    const clean = String(text ?? '').trim();
    if (!clean) return false;
    if (!this.#steerable) {
      this.#warn(`hint not delivered: ${this.#label} takes no messages while it works`);
      return false;
    }
    if (this.#halted || this.#stream.closed) {
      this.#warn('hint not delivered: the run is over');
      return false;
    }
    if (!this.#child) {
      // Still validating options: the hint goes right after the prompt.
      this.#waiting.push(clean);
      return true;
    }
    if (!this.#inputOpen) {
      this.#warn('hint not delivered: the agent has already finished its turn');
      return false;
    }
    this.#deliver(clean);
    return true;
  }

  stop(reason = ''): void {
    this.#halt('stopped', reason ? `stopped: ${reason}` : 'stopped');
  }

  #halt(kind: 'stopped' | 'timeout', message: string): void {
    if (this.#halted || this.#stream.closed) return;
    this.#halted = { kind, message };
    this.#emit({ kind: 'stopped', summary: message, feed: true, data: { reason: kind } });
    this.#inputOpen = false;
    if (this.#child) terminate(this.#child);
  }

  async #execute(): Promise<RunResult> {
    const started = Date.now();
    // Listen before anything else: a signal that fires while options are
    // being checked must stop the run before a process exists.
    const signal = this.#options.signal;
    const onAbort = () => this.stop(signal?.reason instanceof Error ? signal.reason.message : 'aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.#launch(started, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #launch(started: number, signal: AbortSignal | undefined): Promise<RunResult> {
    if (signal?.aborted) this.stop(signal.reason instanceof Error ? signal.reason.message : 'aborted');
    let resolved: Resolved;
    let plan: LaunchPlan;
    try {
      resolved = await resolveLaunch(this.#options, this.#behaviour);
      plan = this.#adapter.plan(resolved.launch);
    } catch (error) {
      this.#stream.fail(error);
      throw error;
    }
    const { launch } = resolved;
    for (const warning of [...resolved.warnings, ...plan.warnings]) this.#warn(warning);

    const parser = this.#adapter.parser(launch.cwd, launch.model, Object.keys(launch.mcpServers));
    this.#parser = parser;
    if (this.#halted) {
      plan.cleanup?.();
      return this.#finish({ started, parser, launchModel: launch.model, code: null, stderr: '' });
    }

    let child: ChildProcess;
    try {
      // An adapter may drive its CLI through a program of its own (OpenCode's server bridge).
      const command = plan.through?.length
        ? {
            file: plan.through[0] as string,
            args: [...plan.through.slice(1), resolved.command.file, ...resolved.command.args],
            shell: false,
          }
        : resolved.command;
      child = spawnCommand(command, plan.args, {
        cwd: launch.cwd,
        env: { ...process.env, ...plan.env, ...(this.#options.env ?? {}) },
        stdin: 'pipe',
      });
    } catch (cause) {
      plan.cleanup?.();
      const error = new BrainyardError('failed', `could not start ${this.#label}: ${(cause as Error).message}`, {
        brain: this.brain,
        cause,
      });
      this.#stream.fail(error);
      throw error;
    }
    this.#child = child;

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((done) => {
      child.once('error', (error) => {
        // A process that never started emits no 'close' we can rely on.
        if (child.pid === undefined) done({ code: null, signal: null, spawnError: error });
      });
      child.once('close', (code, signal) => done({ code, signal }));
    });

    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < STDERR_KEEP) stderr += chunk;
    });
    // Writing to a CLI that already exited raises EPIPE on the stream; the
    // exit itself is handled below.
    child.stdin?.on('error', () => {
      this.#inputOpen = false;
    });

    if (plan.input === 'text') {
      child.stdin?.end(plan.prompt);
    } else {
      this.#inputOpen = true;
      this.#write(plan.prompt);
      this.#unanswered = 1;
      for (const hint of this.#waiting.splice(0)) this.#deliver(hint);
    }

    const timeoutMs = this.#options.timeoutMs;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => this.#halt('timeout', `timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
        : undefined;

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) this.#line(line, parser);
    }
    const { code, signal: killedBy, spawnError } = await exit;

    if (timer) clearTimeout(timer);
    this.#inputOpen = false;
    try {
      plan.cleanup?.();
    } catch {
      // Cleanup is best effort; the run's outcome does not depend on it.
    }

    return this.#finish({
      started,
      parser,
      launchModel: launch.model,
      code,
      stderr,
      ...(killedBy ? { killedBy } : {}),
      ...(spawnError ? { spawnError } : {}),
    });
  }

  #line(line: string, parser: StreamParser): void {
    const text = line.trim();
    if (!text) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      // Not an event: an info line, or a line cut in half. One bad line must
      // not cost the whole run — the agent keeps working.
      this.#emit({ kind: 'warning', summary: `unreadable output line: ${clip(text, 120)}`, feed: false });
      return;
    }
    const before = parser.outcome().results;
    let events: ParsedEvent[];
    try {
      events = parser.push(value as Record<string, unknown>);
    } catch (error) {
      // Reading the event is our job, not the agent's: tripping over it must
      // not throw away work in progress.
      events = [{ kind: 'warning', summary: `could not read an event: ${(error as Error).message}`, feed: false }];
    }
    for (const event of events) this.#emit(event, value);
    const ended = parser.outcome().results - before;
    if (ended > 0) this.#turnEnded(parser, ended);
  }

  #turnEnded(parser: StreamParser, count: number): void {
    this.#unanswered = Math.max(0, this.#unanswered - count);
    if (!this.#inputOpen || this.#unanswered > 0 || parser.queuedTurns > 0) return;
    const outcome = parser.outcome();
    if (this.#behaviour.ensureText && !this.#nudged && !outcome.error && !outcome.text.trim()) {
      // A CLI sometimes ends a turn silently for reasons of its own (a
      // refused tool, a crash of a built-in tool). A new process would not
      // remember what it tripped over; the same conversation does.
      this.#nudged = true;
      this.#warn('the turn ended without an answer; asking once to finish it');
      this.#write(continuePrompt(outcome.deniedTools));
      this.#unanswered += 1;
      return;
    }
    // Close the input as soon as nothing is pending: with stdin open, a
    // stream-json CLI treats it as a conversation and waits for the next
    // message forever — the finished work would hang until killed.
    this.#closeInput();
  }

  #write(text: string): void {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      this.#inputOpen = false;
      return;
    }
    stdin.write(`${this.#adapter.message(text)}\n`);
  }

  #deliver(text: string): void {
    this.#write(text);
    if (this.#adapter.messageIsTurn) this.#unanswered += 1;
    this.#hints.push(text);
    this.#emit({ kind: 'hint', summary: `you: ${clip(text, 160)}`, text, feed: true });
  }

  #closeInput(): void {
    this.#inputOpen = false;
    const stdin = this.#child?.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end();
  }

  #warn(summary: string): void {
    this.#emit({ kind: 'warning', summary, feed: true });
  }

  #emit(parsed: ParsedEvent, raw?: unknown): void {
    if (this.#stream.closed) return;
    const event: AgentEvent = {
      seq: ++this.#seq,
      at: new Date().toISOString(),
      brain: this.brain,
      kind: parsed.kind,
      summary: redact(parsed.summary),
      feed: parsed.feed,
    };
    if (parsed.text !== undefined) event.text = parsed.text;
    if (parsed.tool !== undefined) event.tool = parsed.tool;
    if (parsed.input !== undefined) event.input = parsed.input;
    if (parsed.data !== undefined) event.data = parsed.data;
    if (this.#options.includeRaw && raw !== undefined) event.raw = raw;
    this.#stream.push(event);
    try {
      this.#options.onEvent?.(event);
    } catch {
      // A listener's bug must not kill a paid run.
    }
  }

  #finish(end: {
    started: number;
    parser: StreamParser;
    launchModel: string | undefined;
    code: number | null;
    stderr: string;
    killedBy?: NodeJS.Signals;
    spawnError?: Error;
  }): RunResult {
    const outcome = end.parser.outcome();
    const stderr = end.stderr.trim();
    const shownStderr = stderr.length > STDERR_SHOWN ? `${stderr.slice(0, STDERR_SHOWN)}…` : stderr;
    const firstComplaint = oneLine(stderr.split(/\r?\n/).find((line) => line.trim()) ?? '');

    let error: RunError | undefined;
    if (this.#halted) {
      error = { kind: this.#halted.kind, message: this.#halted.message, retryable: false };
    } else if (end.spawnError) {
      const missing = (end.spawnError as NodeJS.ErrnoException).code === 'ENOENT';
      error = {
        kind: missing ? 'not_installed' : 'failed',
        message: `could not start ${this.#label}: ${end.spawnError.message}`,
        retryable: false,
      };
    } else if (outcome.error) {
      error = { message: outcome.error, ...classifyFailure(`${outcome.error}\n${stderr}`) };
    } else if (end.code !== 0) {
      const how = end.killedBy ? `was killed by ${end.killedBy}` : `exited with code ${end.code}`;
      const message = `${this.#label} ${how}${firstComplaint ? `: ${clip(firstComplaint, 300)}` : ''}`;
      error = { message, ...classifyFailure(`${message}\n${stderr}`) };
    } else if (outcome.results === 0) {
      // Exit code 0 without a final result is a turn cut short, not success.
      error = {
        kind: 'failed',
        message: `${this.#label} exited without a final result: the turn was cut off`,
        retryable: true,
      };
    }
    const ok = error === undefined;

    const events = this.#stream.items;
    const toolCalls = events.filter(
      (e) => e.kind === 'tool_call' || e.kind === 'command' || e.kind === 'file_write',
    ).length;
    const model = outcome.model ?? end.launchModel;

    let costUsd: number | null = null;
    let costSource: RunResult['costSource'] = null;
    if (outcome.costUsd !== undefined) {
      costUsd = outcome.costUsd;
      costSource = 'cli';
    } else {
      const estimate = estimateCost(model, outcome.usage, this.#options.prices);
      if (estimate !== undefined) {
        costUsd = estimate;
        costSource = 'estimate';
      }
    }
    const durationMs = Date.now() - end.started;

    if (error && !this.#halted) {
      const last = [...events].reverse().find((e) => e.kind === 'error');
      if (!last || last.summary !== redact(error.message)) {
        this.#emit({ kind: 'error', summary: clip(error.message, 300), feed: true, data: { ...error } });
      }
    }
    const seconds = (durationMs / 1000).toFixed(1);
    const price = costUsd === null ? '' : ` · $${costUsd.toFixed(4)}${costSource === 'estimate' ? ' (est.)' : ''}`;
    const actions = `${toolCalls} ${toolCalls === 1 ? 'action' : 'actions'}`;
    this.#emit({
      kind: 'done',
      summary: ok ? `done in ${seconds}s · ${actions}${price}` : `${error?.kind ?? 'failed'} after ${seconds}s${price}`,
      feed: true,
      data: { ok, durationMs, toolCalls, costUsd, ...(error ? { error } : {}) },
    });
    this.#stream.end();

    const result: RunResult = {
      ok,
      brain: this.brain,
      text: outcome.text,
      usage: outcome.usage,
      costUsd,
      costSource,
      durationMs,
      exitCode: end.code,
      toolCalls,
      deniedTools: outcome.deniedTools,
      warnings: this.#stream.items.filter((e) => e.kind === 'warning' && e.feed).map((e) => e.summary),
      hints: [...this.#hints],
      stopped: this.#halted !== undefined,
      limits: outcome.limits,
      events: [...this.#stream.items],
      stderr: shownStderr,
    };
    if (outcome.sessionId) result.sessionId = outcome.sessionId;
    if (model) result.model = model;
    if (error) result.error = error;
    return result;
  }
}

/**
 * Starts an agent run and returns at once. Throws synchronously only for an
 * unknown brain; everything else surfaces through `result`.
 */
export function start(options: RunOptions): AgentRun {
  return new Run(options, { kind: 'run', ensureText: options.nudge !== false });
}

/** Runs an agent to the end. */
export function run(options: RunOptions): Promise<RunResult> {
  return start(options).result;
}

/** @internal One-shot answers use the same machinery with isolation and a nudge for silent turns. */
export function startAnswer(options: RunOptions, system: string | undefined): AgentRun {
  return new Run(options, { kind: 'ask', ensureText: true, ...(system ? { system } : {}) });
}
