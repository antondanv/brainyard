/** Small readers for persisted counters; native message contents stay out of the public API. */
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { obj } from './brains/adapter.js';
import type { Usage } from './types.js';
import { emptyUsage } from './types.js';

export interface UsageSample {
  model?: string;
  usage: Usage;
  costUsd?: number;
}

/** In-progress writers own the final unterminated line. */
export async function* jsonRecords(path: string, match?: RegExp): AsyncGenerator<Record<string, unknown>> {
  const decoder = new StringDecoder('utf8');
  let fragments: string[] = [];
  try {
    for await (const buffer of createReadStream(path)) {
      const chunk = decoder.write(buffer as Buffer);
      let start = 0;
      for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
        const line = fragments.length ? fragments.join('') + chunk.slice(start, end) : chunk.slice(start, end);
        fragments = [];
        start = end + 1;
        if (match && !match.test(line)) continue;
        try {
          const value: unknown = JSON.parse(line);
          if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Record<string, unknown>;
        } catch {
          // A damaged record does not erase earlier counters.
        }
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    }
  } catch {
    // A session may disappear while its store is being listed.
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function counters(raw: Record<string, unknown>, names: string[]): number[] | undefined {
  if (!names.some((name) => raw[name] !== undefined)) return undefined;
  const values = names.map((name) => (raw[name] === undefined ? 0 : count(raw[name])));
  return values.every((value) => value !== undefined) ? (values as number[]) : undefined;
}

export function claudeUsage(raw: Record<string, unknown>): Usage | undefined {
  const values = counters(raw, [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ]);
  if (!values) return undefined;
  return {
    inputTokens: values[0]!,
    outputTokens: values[1]!,
    cacheReadTokens: values[2]!,
    cacheWriteTokens: values[3]!,
    reasoningTokens: count(obj(raw.output_tokens_details).thinking_tokens) ?? 0,
  };
}

export function codexUsage(raw: Record<string, unknown>): Usage | undefined {
  const values = counters(raw, [
    'input_tokens',
    'output_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'reasoning_output_tokens',
  ]);
  if (!values) return undefined;
  return {
    inputTokens: Math.max(0, values[0]! - values[2]!),
    outputTokens: values[1]!,
    cacheReadTokens: values[2]!,
    cacheWriteTokens: values[3]!,
    reasoningTokens: values[4]!,
  };
}

export function opencodeUsage(raw: Record<string, unknown>): Usage | undefined {
  const cache = obj(raw.cache);
  const values = counters({ ...raw, read: cache.read, write: cache.write }, [
    'input',
    'output',
    'reasoning',
    'read',
    'write',
  ]);
  if (!values) return undefined;
  return {
    inputTokens: values[0]!,
    outputTokens: values[1]! + values[2]!,
    reasoningTokens: values[2]!,
    cacheReadTokens: values[3]!,
    cacheWriteTokens: values[4]!,
  };
}

export function addUsage(total: Usage, value: Usage): void {
  for (const key of Object.keys(total) as (keyof Usage)[]) total[key] += value[key];
}

export function difference(total: Usage, before: Usage): Usage | undefined {
  const delta = emptyUsage();
  for (const key of Object.keys(delta) as (keyof Usage)[]) {
    delta[key] = total[key] - before[key];
    if (delta[key] < 0) return undefined;
  }
  return delta;
}

interface WireField {
  number: number;
  value: number | bigint | Uint8Array;
}

/** Only protobuf wire primitives: no dependency on the private CLI's generated code. */
function wireFields(data: Uint8Array): WireField[] {
  let offset = 0;
  const variable = (): number | bigint => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= data.length) throw new Error('truncated protobuf');
      const byte = data[offset++]!;
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) {
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      }
    }
    throw new Error('invalid protobuf integer');
  };
  const fields: WireField[] = [];
  while (offset < data.length) {
    const tag = variable();
    if (typeof tag !== 'number') throw new Error('invalid protobuf tag');
    const number = Math.floor(tag / 8);
    const type = tag % 8;
    if (!number) throw new Error('invalid protobuf field');
    if (type === 0) {
      fields.push({ number, value: variable() });
    } else {
      const length = type === 2 ? variable() : type === 1 ? 8 : type === 5 ? 4 : -1;
      if (typeof length !== 'number' || length < 0 || offset + length > data.length)
        throw new Error('invalid protobuf length');
      // Unknown fixed-width fields are skipped, not interpreted as counters.
      if (type === 2) fields.push({ number, value: data.subarray(offset, offset + length) });
      offset += length;
    }
  }
  return fields;
}

/** Persisted CortexStepGeneratorMetadata.chat_model.usage, verified against agy 1.2. */
export function agyUsage(data: unknown): UsageSample | undefined {
  if (!(data instanceof Uint8Array)) return undefined;
  try {
    const get = (fields: WireField[], number: number) => fields.find((field) => field.number === number)?.value;
    const chat = get(wireFields(data), 1);
    if (!(chat instanceof Uint8Array)) return undefined;
    const metadata = wireFields(chat);
    const stats = get(metadata, 4);
    if (!(stats instanceof Uint8Array)) return undefined;
    const fields = wireFields(stats);
    if (!fields.some((field) => [2, 3, 4, 5, 9].includes(field.number))) return undefined;
    const tokens = (number: number): number => {
      const value = get(fields, number);
      if (value === undefined) return 0;
      if (typeof value !== 'number') throw new Error('invalid protobuf counter');
      return value;
    };
    const cached = tokens(5);
    const model = get(metadata, 19) ?? get(metadata, 22);
    return {
      usage: {
        inputTokens: Math.max(0, tokens(2) - cached),
        outputTokens: tokens(3),
        cacheReadTokens: cached,
        cacheWriteTokens: tokens(4),
        reasoningTokens: tokens(9),
      },
      ...(model instanceof Uint8Array ? { model: Buffer.from(model).toString('utf8') } : {}),
    };
  } catch {
    return undefined;
  }
}
