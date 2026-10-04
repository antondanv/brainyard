/**
 * Which models and efforts each CLI offers, and checking a choice against it.
 *
 * The list is asked from the CLI itself: models change faster than any
 * library. How to ask differs, and was found by running them:
 *
 * - **Codex** — `codex debug models` prints a JSON catalog; every model has
 *   its own reasoning levels and default.
 * - **Antigravity** — `agy models` prints `slug<TAB>label`, with the effort
 *   inside the slug (`gemini-3.8-flash-high`). The CLI takes the family plus
 *   `--effort`, and only that way: a family without effort is refused, a
 *   variant with a different effort "conflicts". So variants fold into a
 *   family with a set of efforts.
 * - **Claude Code** — has no list command, but has aliases it expands to the
 *   latest model (`fable`, `opus`, `sonnet`, `haiku`), which never go stale.
 *
 * **Efforts are checked here, not by the CLI**, because Claude Code does not
 * refuse an unknown effort: it prints a warning to stderr and silently runs
 * with its default. You would pay for something you did not choose.
 */
import { BRAINS } from './brains/info.js';
import { BrainyardError } from './errors.js';
import { type Command, capture, resolveCommand } from './process.js';
import type { BrainId, Effort } from './types.js';
import { EFFORT_ORDER } from './types.js';

export interface ModelInfo {
  id: string;
  label: string;
  efforts: Effort[];
  /** Empty: the CLI decides. */
  defaultEffort?: Effort;
  /** Antigravity families do not start without an effort. */
  effortRequired: boolean;
  /** Names with the effort inside: `[gemini-3.8-flash-high, high]`. */
  variants: [slug: string, effort: Effort][];
  note?: string;
}

export interface Catalog {
  brain: BrainId;
  models: ModelInfo[];
  /** Efforts when no model is chosen and the CLI's default model runs. */
  defaultEfforts: Effort[];
  /** `cli`: asked from the CLI just now. `builtin`: the fallback list shipped with Brainyard. */
  source: 'cli' | 'builtin';
  note?: string;
  fetchedAt: string;
}

/** Model names end up as a `--model` value. A name starting with a dash would be parsed as a flag. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;

const CLI_TTL_MS = 60 * 60 * 1000;
const BUILTIN_TTL_MS = 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 20_000;

function isEffort(value: string): value is Effort {
  return (EFFORT_ORDER as readonly string[]).includes(value);
}

function sortEfforts(values: Iterable<string>): Effort[] {
  const set = new Set(values);
  return EFFORT_ORDER.filter((effort) => set.has(effort));
}

function model(id: string, label: string, efforts: Effort[], extra: Partial<ModelInfo> = {}): ModelInfo {
  return { id, label, efforts, effortRequired: false, variants: [], ...extra };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
export const CLAUDE_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function claudeCatalog(): Catalog {
  return {
    brain: 'claude',
    models: [
      model('fable', 'Fable', CLAUDE_EFFORTS, { note: 'latest Fable; the CLI expands the alias' }),
      model('opus', 'Opus', CLAUDE_EFFORTS, { note: 'latest Opus; the CLI expands the alias' }),
      model('sonnet', 'Sonnet', CLAUDE_EFFORTS, { note: 'latest Sonnet; the CLI expands the alias' }),
      // Haiku has no effort setting: the CLI would accept the flag and ignore it.
      model('haiku', 'Haiku', [], { note: 'latest Haiku; effort is not configurable' }),
    ],
    defaultEfforts: CLAUDE_EFFORTS,
    source: 'builtin',
    note: 'Claude Code has no model list command; these are aliases it expands to the latest version',
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
const CODEX_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];

/** `codex debug models` → the models the CLI itself offers (hidden ones are Codex internals). */
export function parseCodexModels(raw: string): ModelInfo[] {
  const data: unknown = JSON.parse(raw);
  const rows = Array.isArray(data) ? data : (data as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return [];
  const out: [number, ModelInfo][] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    if ((entry.visibility ?? 'list') !== 'list') continue;
    const slug = String(entry.slug ?? '').trim();
    if (!slug || !MODEL_NAME.test(slug)) continue;
    const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
    const efforts = sortEfforts(
      levels.map((level) =>
        level && typeof level === 'object' ? String((level as { effort?: unknown }).effort ?? '') : String(level),
      ),
    );
    const fallback = String(entry.default_reasoning_level ?? '');
    const info = model(slug, String(entry.display_name ?? slug), efforts);
    if (isEffort(fallback) && efforts.includes(fallback)) info.defaultEffort = fallback;
    if (entry.description) info.note = String(entry.description);
    out.push([Number(entry.priority ?? 0), info]);
  }
  return out.sort((a, b) => a[0] - b[0]).map(([, info]) => info);
}

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------
const AGY_EFFORTS: Effort[] = ['low', 'medium', 'high'];
const VARIANT = /^(?<family>.+)-(?<effort>minimal|low|medium|high|xhigh|max)$/;
const LEVEL_IN_LABEL = /\s*\((?:minimal|low|medium|high|xhigh|max)\)\s*$/i;

/** `agy models` → families with efforts, and models without. */
export function parseAgyModels(raw: string): ModelInfo[] {
  const families = new Map<string, { label: string; variants: [string, Effort][]; plain: boolean }>();
  for (const line of raw.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue; // "Fetching available models..."
    const slug = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!slug || !MODEL_NAME.test(slug)) continue;
    const match = VARIANT.exec(slug);
    const family = match?.groups?.family ?? slug;
    let entry = families.get(family);
    if (!entry) {
      entry = { label: label.replace(LEVEL_IN_LABEL, '') || family, variants: [], plain: false };
      families.set(family, entry);
    }
    const effort = match?.groups?.effort;
    if (effort && isEffort(effort)) entry.variants.push([slug, effort]);
    else {
      entry.plain = true;
      entry.label = label || slug;
    }
  }
  const out: ModelInfo[] = [];
  for (const [family, entry] of families) {
    const variants = [...entry.variants].sort((a, b) => EFFORT_ORDER.indexOf(a[1]) - EFFORT_ORDER.indexOf(b[1]));
    if (variants.length === 0) {
      out.push(model(family, entry.label, []));
      continue;
    }
    const efforts = variants.map(([, effort]) => effort);
    const info = model(family, entry.label, efforts, {
      // A model that also exists without an effort in its name starts without one.
      effortRequired: !entry.plain,
      variants,
    });
    info.defaultEffort = efforts.includes('high') ? 'high' : (efforts[efforts.length - 1] as Effort);
    out.push(info);
  }
  return out;
}

function builtin(brain: BrainId, problem: string): Catalog {
  const fetchedAt = new Date().toISOString();
  if (brain === 'codex') {
    return {
      brain,
      models: [model('gpt-5.5', 'GPT-5.5', CODEX_EFFORTS, { defaultEffort: 'medium' })],
      defaultEfforts: CODEX_EFFORTS,
      source: 'builtin',
      note: `built-in list: ${problem}`,
      fetchedAt,
    };
  }
  const variants = (family: string, efforts: Effort[]) =>
    efforts.map((effort) => [`${family}-${effort}`, effort] as [string, Effort]);
  return {
    brain,
    models: [
      model('gemini-3.8-flash', 'Gemini 3.8 Flash', AGY_EFFORTS, {
        defaultEffort: 'high',
        effortRequired: true,
        variants: variants('gemini-3.8-flash', AGY_EFFORTS),
      }),
      model('gemini-3.1-pro', 'Gemini 3.1 Pro', ['low', 'high'], {
        defaultEffort: 'high',
        effortRequired: true,
        variants: variants('gemini-3.1-pro', ['low', 'high']),
      }),
    ],
    defaultEfforts: AGY_EFFORTS,
    source: 'builtin',
    note: `built-in list: ${problem}`,
    fetchedAt,
  };
}

async function ask(command: Command, args: string[]): Promise<{ out: string; problem: string }> {
  const shown = `${command.file.split(/[/\\]/).pop()} ${args.join(' ')}`;
  const got = await capture(command, args, { timeoutMs: DISCOVERY_TIMEOUT_MS });
  if (got.error) return { out: '', problem: `\`${shown}\` did not start: ${got.error.message}` };
  if (got.timedOut) return { out: '', problem: `\`${shown}\` did not answer in ${DISCOVERY_TIMEOUT_MS / 1000}s` };
  if (got.code !== 0) {
    const first = got.stderr.trim().split(/\r?\n/)[0] ?? '';
    return { out: '', problem: `\`${shown}\` exited with ${got.code}${first ? `: ${first.slice(0, 200)}` : ''}` };
  }
  return { out: got.stdout, problem: '' };
}

async function discover(brain: BrainId, command: Command | undefined): Promise<Catalog> {
  if (brain === 'claude') return claudeCatalog();
  if (!command) return builtin(brain, 'the CLI is not installed');
  if (brain === 'codex') {
    const { out, problem } = await ask(command, ['debug', 'models']);
    if (!out) return builtin(brain, problem);
    try {
      const models = parseCodexModels(out);
      if (models.length > 0) {
        return { brain, models, defaultEfforts: CODEX_EFFORTS, source: 'cli', fetchedAt: new Date().toISOString() };
      }
      return builtin(brain, '`codex debug models` named no models');
    } catch (error) {
      return builtin(brain, `\`codex debug models\` did not print a catalog: ${(error as Error).message}`);
    }
  }
  const { out, problem } = await ask(command, ['models']);
  if (!out) return builtin(brain, problem);
  const models = parseAgyModels(out);
  if (models.length > 0) {
    return { brain, models, defaultEfforts: AGY_EFFORTS, source: 'cli', fetchedAt: new Date().toISOString() };
  }
  return builtin(brain, '`agy models` named no models');
}

const cache = new Map<string, { catalog: Catalog; at: number }>();

function cacheKey(brain: BrainId, command: Command | undefined): string {
  return [brain, ...(command ? [command.file, ...command.args] : [])].join('\u0000');
}

export interface CatalogOptions {
  /** Ask the CLI again even if a fresh list is cached. */
  refresh?: boolean;
  command?: string | string[];
}

/** Models and efforts of one CLI. Cached for an hour (a minute for the built-in fallback). */
export async function models(brain: BrainId, options: CatalogOptions = {}): Promise<Catalog> {
  const { binary, envVar } = BRAINS[brain];
  const command = resolveCommand(options.command, binary, envVar);
  const key = cacheKey(brain, command);
  const hit = cache.get(key);
  if (hit && !options.refresh) {
    const ttl = hit.catalog.source === 'cli' ? CLI_TTL_MS : BUILTIN_TTL_MS;
    if (brain === 'claude' || Date.now() - hit.at < ttl) return hit.catalog;
  }
  const catalog = await discover(brain, command);
  cache.set(key, { catalog, at: Date.now() });
  return catalog;
}

/**
 * A catalog from `agy models` output someone already has (the status check
 * runs it anyway), cached as if `models()` had asked.
 */
export function rememberAgyModels(command: Command, raw: string): Catalog | undefined {
  const found = parseAgyModels(raw);
  if (found.length === 0) return undefined;
  const catalog: Catalog = {
    brain: 'antigravity',
    models: found,
    defaultEfforts: AGY_EFFORTS,
    source: 'cli',
    fetchedAt: new Date().toISOString(),
  };
  cache.set(cacheKey('antigravity', command), { catalog, at: Date.now() });
  return catalog;
}

/** Forget cached catalogs (tests, or after installing a CLI). */
export function clearCatalogCache(): void {
  cache.clear();
}

/** All efforts a CLI understands at all. */
export function vocabulary(catalog: Catalog): Effort[] {
  const known = new Set<string>(catalog.defaultEfforts);
  for (const entry of catalog.models) for (const effort of entry.efforts) known.add(effort);
  return sortEfforts(known);
}

export interface Pick {
  model?: string;
  effort?: Effort;
}

/**
 * A model/effort choice checked against the catalog, or a refusal in words.
 *
 * - The effort is checked against the model: Claude Code silently swaps an
 *   unknown one for its default, Antigravity fails on it.
 * - A missing effort is filled in when the CLI would not start without one
 *   (an Antigravity family).
 * - A variant name (`gemini-3.8-flash-low`) becomes family + effort.
 * - A model missing from the catalog is not refused: catalogs can be partial
 *   (hidden Codex models, full Claude names instead of aliases), and the CLI
 *   will refuse a wrong name itself — loudly, not by substitution.
 */
export function resolvePick(catalog: Catalog, wanted: { model?: string; effort?: string }): Pick {
  const name = wanted.model?.trim() ?? '';
  const effort = wanted.effort?.trim().toLowerCase() ?? '';
  const label = BRAINS[catalog.brain].label;
  if (name && !MODEL_NAME.test(name)) {
    throw new BrainyardError('invalid_option', `"${name}" does not look like a model name`, { brain: catalog.brain });
  }
  if (effort && !isEffort(effort)) {
    throw new BrainyardError('invalid_option', `there is no effort "${effort}"; known: ${EFFORT_ORDER.join(', ')}`, {
      brain: catalog.brain,
    });
  }
  const pick = (m: string, e: string): Pick => {
    const out: Pick = {};
    if (m) out.model = m;
    if (e) out.effort = e as Effort;
    return out;
  };
  if (!name && !effort) return {};

  const entry = name ? catalog.models.find((m) => m.id === name) : undefined;
  if (name && !entry) {
    for (const family of catalog.models) {
      const variant = family.variants.find(([slug]) => slug === name);
      if (!variant) continue;
      const [, inner] = variant;
      if (effort && effort !== inner) {
        throw new BrainyardError(
          'invalid_option',
          `"${name}" already has effort ${inner} in its name; for another effort use "${family.id}" (${family.efforts.join(', ')})`,
          { brain: catalog.brain },
        );
      }
      return pick(family.id, inner);
    }
    const known = vocabulary(catalog);
    if (effort && known.length > 0 && !known.includes(effort as Effort)) {
      throw new BrainyardError('invalid_option', `${label} efforts: ${known.join(', ')}`, { brain: catalog.brain });
    }
    return pick(name, effort);
  }

  const efforts = entry ? entry.efforts : catalog.defaultEfforts;
  const title = entry ? `${label} · ${entry.label}` : label;
  if (effort && efforts.length > 0 && !efforts.includes(effort as Effort)) {
    throw new BrainyardError('invalid_option', `${title} efforts: ${efforts.join(', ')} — not "${effort}"`, {
      brain: catalog.brain,
    });
  }
  if (effort && efforts.length === 0 && (entry || catalog.models.length > 0)) {
    throw new BrainyardError('invalid_option', `${title} has no configurable effort`, { brain: catalog.brain });
  }
  if (!effort && entry?.effortRequired && entry.defaultEffort) return pick(name, entry.defaultEffort);
  return pick(name, effort);
}
