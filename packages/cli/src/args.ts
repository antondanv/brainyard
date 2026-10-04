/** Arguments of the `brainyard` command: flags, brains, numbers and prompts. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { type Access, BRAIN_IDS, type BrainId, brainId, type ModelPrice } from '@antondanv/brainyard';

/** A mistake in how the command was called: exit code 2 and a pointer to the help. */
export class UsageError extends Error {}

/** The command could not do what was asked (no such pane, nothing running): exit code 1. */
export class Failure extends Error {
  fix?: string;
  constructor(message: string, fix?: string) {
    super(message);
    if (fix) this.fix = fix;
  }
}

export function parse<T extends NonNullable<Parameters<typeof parseArgs>[0]>['options']>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function brainArg(value: string | undefined): BrainId {
  if (!value) throw new UsageError(`name a brain: ${BRAIN_IDS.join(', ')}`);
  try {
    return brainId(value);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function accessArg(value: string | undefined): Access | undefined {
  if (value === undefined) return undefined;
  if (value === 'full' || value === 'workspace' || value === 'readonly') return value;
  throw new UsageError(`--access must be full, workspace or readonly, not "${value}"`);
}

export function secondsArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError(`--timeout wants seconds, not "${value}"`);
  return seconds * 1000;
}

/** A whole number of at least `min`: `--limit`, `--width`, `--scroll`… */
export function countArg(flag: string, value: string, min = 1): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < min) throw new UsageError(`${flag} wants a number, not "${value}"`);
  return count;
}

/** `--prices <file.json>`: dollars per million tokens by model, as `prices` in the API. */
export function pricesArg(path: string): Record<string, ModelPrice> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`--prices: cannot read ${path}: ${(error as Error).message}`);
  }
  const shape = '--prices wants {"model": {"input": 3, "output": 15}} in dollars per million tokens';
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UsageError(shape);
  for (const [model, price] of Object.entries(data)) {
    const { input, output } = (price ?? {}) as Record<string, unknown>;
    if (typeof input !== 'number' || typeof output !== 'number') throw new UsageError(`${shape}; ${model} is not`);
  }
  return data as Record<string, ModelPrice>;
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Prompt from arguments; `-` or none reads stdin; piped stdin plus a prompt
 * become one (as with `codex exec`). Reading stdin waits for EOF, so a script
 * that leaves stdin open should pass `--no-stdin`.
 */
export async function promptFrom(words: string[], useStdin = true): Promise<string> {
  const joined = words.join(' ').trim();
  if (joined === '-') return (await readStdin()).trim();
  const piped = !useStdin || process.stdin.isTTY ? '' : (await readStdin()).trim();
  if (joined && piped) return `${joined}\n\n${piped}`;
  return joined || piped;
}
