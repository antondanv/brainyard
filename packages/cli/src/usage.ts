/**
 * `brainyard usage`: what the subscriptions have left, and the tokens and
 * cost of a folder's saved sessions. It reads the CLIs' stores and asks for
 * quota metadata; a real model call happens only with --live.
 */
import { resolve } from 'node:path';

import {
  BRAIN_IDS,
  BRAINS,
  type BrainUsage,
  clip,
  type LimitWindow,
  type SessionUsage,
  sessions,
  tidyPaths,
  type Usage,
  usage,
} from '@antondanv/brainyard';

import { brainArg, countArg, Failure, parse, pricesArg, secondsArg, UsageError } from './args.js';
import { ago, money, tokens, until, windowName } from './format.js';
import { type Paint, pad, paint, table } from './term.js';

const out = paint(process.stdout);
const err = paint(process.stderr);

function windowText(limit: LimitWindow, c: Paint, now: number): string {
  const used = Math.round(limit.utilization * 100);
  const tint = used >= 90 ? c.red : used >= 70 ? c.yellow : (text: string) => text;
  let resets = '';
  if (limit.resetsAt) {
    const left = until(limit.resetsAt * 1000, now);
    resets = c.dim(left === 'now' ? ' · resetting' : ` · resets in ${left}`);
  }
  return `${windowName(limit)} ${tint(`${used}%`)}${resets}`;
}

/** Why a CLI shows no windows, in the command's words where the reason is a flag. */
function noLimits(brain: BrainUsage): string {
  if (brain.limitsUnavailable === 'not_requested') {
    return brain.brain === 'claude'
      ? 'not checked: --live asks with one tiny real call, which may cost'
      : 'not checked: --offline';
  }
  return brain.detail ?? (brain.limits ? 'no windows' : 'unknown');
}

/** Each CLI's subscription windows, a model pool to a line, or why there are none. */
export function limitLines(brains: readonly BrainUsage[], c: Paint, now = Date.now()): string[] {
  const lines: string[] = [];
  for (const brain of brains) {
    const label = pad(BRAINS[brain.brain].label, 12);
    if (!brain.limits || brain.limits.length === 0) {
      lines.push(`${label} ${c.dim(noLimits(brain))}`);
      continue;
    }
    // Antigravity's model groups and Codex's separate buckets each have windows of their own.
    const pools = new Map<string, LimitWindow[]>();
    for (const limit of brain.limits) {
      const pool = limit.group ?? limit.limitId ?? '';
      pools.set(pool, [...(pools.get(pool) ?? []), limit]);
    }
    const seen = brain.limitsObservedAt ? ago(Date.parse(brain.limitsObservedAt), now) : 'now';
    const age = seen === 'now' ? '' : c.dim(`   seen ${seen} ago`);
    let first = true;
    for (const [pool, limits] of pools) {
      const name = pools.size > 1 && pool ? `${pool}: ` : '';
      const windows = limits.map((limit) => windowText(limit, c, now)).join('   ');
      lines.push(`${first ? label : ' '.repeat(12)} ${name}${windows}${first ? age : ''}`);
      first = false;
    }
    if (brain.error) lines.push(`${' '.repeat(12)} ${c.yellow(brain.error.message)}`);
  }
  return lines;
}

const sum = (list: readonly SessionUsage[], pick: (usage: Usage) => number) =>
  list.reduce((total, session) => total + (session.usage ? pick(session.usage) : 0), 0);
const cache = (usage: Usage) => usage.cacheReadTokens + usage.cacheWriteTokens;

/** One line per saved session: CLI, id, age, title, tokens and cost; then the total. */
export function usageLines(list: readonly SessionUsage[], c: Paint, now = Date.now()): string[] {
  const reasoning = list.some((session) => (session.usage?.reasoningTokens ?? 0) > 0);
  const counts = (usage: Usage) => [
    tokens(usage.inputTokens),
    tokens(usage.outputTokens),
    tokens(cache(usage)),
    ...(reasoning ? [tokens(usage.reasoningTokens)] : []),
  ];
  const blank = reasoning ? ['', '', '', ''] : ['', '', ''];
  const rows = list.map((session) => {
    const when = session.updatedAt ?? session.startedAt;
    const head = [
      BRAINS[session.brain].label,
      c.dim(session.id.slice(0, 8)),
      when ? ago(Date.parse(when), now) : '',
      session.title ? clip(session.title, 40) : c.dim('(untitled)'),
    ];
    if (!session.usage) return [...head, ...blank, '', c.dim(session.unavailableReason ?? 'no counters')];
    const cost =
      session.costUsd === null
        ? c.dim('no price')
        : `${money(session.costUsd)}${session.costSource === 'estimate' ? c.dim(' est.') : ''}`;
    return [...head, ...counts(session.usage), cost];
  });
  const priced = list.filter((session) => session.costUsd !== null);
  const unpriced = list.filter((session) => session.usage && session.costUsd === null).length;
  const total = [
    c.bold('total'),
    '',
    '',
    c.dim(`${list.length} session${list.length === 1 ? '' : 's'}`),
    tokens(sum(list, (usage) => usage.inputTokens)),
    tokens(sum(list, (usage) => usage.outputTokens)),
    tokens(sum(list, cache)),
    ...(reasoning ? [tokens(sum(list, (usage) => usage.reasoningTokens))] : []),
    priced.length > 0 ? money(priced.reduce((dollars, session) => dollars + (session.costUsd ?? 0), 0)) : '',
    unpriced > 0 ? c.dim(`+ ${unpriced} without a price`) : '',
  ];
  const header = ['', '', '', '', 'input', 'output', 'cache', ...(reasoning ? ['reasoning'] : []), 'cost'].map(
    (title) => c.dim(title),
  );
  const numbers = new Set(reasoning ? [4, 5, 6, 7, 8] : [4, 5, 6, 7]);
  return table([header, ...rows, total], numbers);
}

export async function usageCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    cwd: { type: 'string' },
    session: { type: 'string' },
    limits: { type: 'boolean' },
    headless: { type: 'boolean' },
    limit: { type: 'string' },
    offline: { type: 'boolean' },
    live: { type: 'boolean' },
    prices: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (values.offline && values.live) {
    throw new UsageError('--offline reads only what is saved and --live makes a real call: pick one');
  }
  if (values.limits && (values.session || values.limit)) {
    throw new UsageError('--limits shows the subscriptions only: drop --session and --limit');
  }
  let brains = positionals.length > 0 ? positionals.map((value) => brainArg(value)) : [...BRAIN_IDS];
  const cwd = resolve(values.cwd ?? process.cwd());
  const limit = values.limits ? 0 : values.limit === undefined ? 20 : countArg('--limit', values.limit);
  const timeoutMs = secondsArg(values.timeout);
  const prices = values.prices ? pricesArg(values.prices) : undefined;

  let sessionId: string | undefined;
  if (values.session) {
    const ref = values.session;
    const saved = await sessions({ cwd, brains, headless: true, live: false, limit: Number.MAX_SAFE_INTEGER });
    const exact = saved.filter((session) => session.id === ref);
    const found = exact.length > 0 ? exact : saved.filter((session) => session.id.startsWith(ref));
    if (found.length === 0) {
      throw new Failure(`no saved session ${ref} in ${tidyPaths(cwd)}`, 'brainyard sessions --headless lists them');
    }
    if (found.length > 1) {
      throw new UsageError(`"${ref}" fits ${found.length} sessions: ${found.map((s) => s.id.slice(0, 8)).join(', ')}`);
    }
    sessionId = found[0]!.id;
    brains = [found[0]!.brain];
  }

  if (values.live && !values.json && process.stderr.isTTY) {
    process.stderr.write(err.dim('asking Claude Code with one tiny real call…\n'));
  }
  const report = await usage({
    cwd,
    brains,
    limit,
    // A session named by id is counted even when it was a headless run.
    ...(values.headless || sessionId ? { headless: true } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(values.offline ? { offline: true } : {}),
    ...(values.live ? { live: true } : {}),
    ...(prices ? { prices } : {}),
    ...(timeoutMs ? { timeoutMs: Math.round(timeoutMs) } : {}),
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const lines = [out.bold('Subscription limits'), ...limitLines(report.brains, out).map((line) => `  ${line}`)];
  if (!values.limits) {
    const list = [...report.sessions].sort(
      (a, b) =>
        (Date.parse(b.updatedAt ?? b.startedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? a.startedAt ?? '') || 0),
    );
    lines.push('', `${out.bold('Sessions of')} ${tidyPaths(cwd)}`);
    if (list.length === 0) lines.push(`  ${out.dim('no sessions in this folder yet')}`);
    else lines.push(...usageLines(list, out).map((line) => `  ${line}`));
    if (!prices && list.some((session) => session.usage && session.costUsd === null)) {
      lines.push(
        '',
        out.dim('  a cost without a price: --prices <file.json> gives dollars per million tokens by model'),
      );
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
