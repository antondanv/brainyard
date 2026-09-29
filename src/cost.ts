import type { ModelPrice, Usage } from './types.js';

// `claude-haiku-4-5-20251001` → `claude-haiku-4-5`
const DATE_SUFFIX = /-\d{8}$/;

/**
 * Dollar estimate from tokens, for CLIs that report only tokens. Undefined
 * when the model has no price: an unknown price is not a zero price.
 */
export function estimateCost(
  model: string | undefined,
  usage: Usage,
  prices: Record<string, ModelPrice> | undefined,
): number | undefined {
  if (!model || !prices) return undefined;
  const price = prices[model] ?? prices[model.replace(DATE_SUFFIX, '')];
  if (!price) return undefined;
  const perMillion = (tokens: number, dollars: number) => (tokens * dollars) / 1_000_000;
  const total =
    perMillion(usage.inputTokens, price.input) +
    perMillion(usage.outputTokens, price.output) +
    perMillion(usage.cacheReadTokens, price.cacheRead ?? price.input * 0.1) +
    perMillion(usage.cacheWriteTokens, price.cacheWrite ?? price.input * 1.25);
  return Math.round(total * 1e8) / 1e8;
}
