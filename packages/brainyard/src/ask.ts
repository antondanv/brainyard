/**
 * One prompt, one answer — your installed CLI as a plain model call.
 *
 * Runs in a fresh empty directory: started inside a project, the CLI would
 * pick up its CLAUDE.md, settings and MCP servers, and they would silently
 * become part of the prompt. Claude Code additionally runs in safe mode with
 * its agent persona replaced and, unless you allow more, no tools at all.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADAPTERS } from './brains/index.js';
import { BRAINS } from './brains/info.js';
import { BrainyardError } from './errors.js';
import { commandFor } from './options.js';
import { capture } from './process.js';
import { startAnswer } from './run.js';
import type { AskOptions, AskResult, BrainId } from './types.js';
import { BRAIN_IDS } from './types.js';

export async function ask(brain: BrainId | string, prompt: string, options: AskOptions = {}): Promise<AskResult> {
  const dir = options.cwd ?? mkdtempSync(join(tmpdir(), 'brainyard-ask-'));
  try {
    const agent = startAnswer(
      {
        brain,
        prompt,
        cwd: dir,
        access: options.access ?? 'readonly',
        web: options.web ?? false,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.command !== undefined ? { command: options.command } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
        ...(options.validate !== undefined ? { validate: options.validate } : {}),
        ...(options.prices !== undefined ? { prices: options.prices } : {}),
      },
      options.system,
    );
    const result = await agent.result;
    await forget(result.brain, result.sessionId, options);
    if (!result.ok) {
      throw BrainyardError.from(
        result.error ?? { kind: 'failed', message: 'the run failed', retryable: false },
        result.brain,
      );
    }
    const text = result.text.trim();
    if (!text) {
      throw new BrainyardError('empty_answer', `${BRAINS[result.brain].label} finished without a text answer`, {
        brain: result.brain,
        retryable: true,
      });
    }
    const answer: AskResult = {
      brain: result.brain,
      text,
      usage: result.usage,
      costUsd: result.costUsd,
      costSource: result.costSource,
      durationMs: result.durationMs,
      limits: result.limits,
    };
    if (result.model) answer.model = result.model;
    return answer;
  } finally {
    if (options.cwd === undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An answer is not a conversation to come back to. Claude Code and Codex are
 * told not to keep it; a CLI that cannot be told deletes it afterwards. Best
 * effort: the answer does not depend on it.
 */
async function forget(brain: BrainId, sessionId: string | undefined, options: AskOptions): Promise<void> {
  const args = sessionId ? ADAPTERS[brain].forget?.(sessionId) : undefined;
  if (!args) return;
  try {
    await capture(commandFor(brain, options.command), args, {
      timeoutMs: 15_000,
      env: { ...process.env, ...options.env },
    });
  } catch {
    // Not installed any more, or gone already: nothing to clean.
  }
}

export interface AskAllEntry {
  brain: BrainId;
  result?: AskResult;
  error?: BrainyardError;
}

/**
 * The same prompt to several CLIs at once. Never throws: each entry carries
 * an answer or the reason there is none. Per-brain model and effort choices
 * do not apply here — each CLI answers with its default.
 */
export async function askAll(
  prompt: string,
  options: Omit<AskOptions, 'model' | 'effort' | 'command'> & { brains?: BrainId[] } = {},
): Promise<AskAllEntry[]> {
  const brains = options.brains ?? [...BRAIN_IDS];
  const { brains: _ignored, ...rest } = options;
  return Promise.all(
    brains.map(async (brain): Promise<AskAllEntry> => {
      try {
        return { brain, result: await ask(brain, prompt, rest) };
      } catch (error) {
        const wrapped =
          error instanceof BrainyardError
            ? error
            : new BrainyardError('failed', (error as Error)?.message ?? String(error), { brain, cause: error });
        return { brain, error: wrapped };
      }
    }),
  );
}
