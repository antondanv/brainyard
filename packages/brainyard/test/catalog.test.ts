import { describe, expect, it } from 'vitest';

import { type Catalog, parseAgyModels, parseCodexModels, resolvePick } from '../src/catalog.js';
import { BrainyardError } from '../src/errors.js';

const AGY_OUTPUT = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

const CODEX_OUTPUT = JSON.stringify({
  models: [
    { slug: 'gpt-hidden', visibility: 'hide', priority: 0 },
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      visibility: 'list',
      priority: 12,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
    },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      visibility: 'list',
      priority: 1,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'ultra' }, { effort: 'low' }, { effort: 'max' }],
    },
    { slug: '--evil', visibility: 'list', priority: 3 },
  ],
});

describe('parseCodexModels', () => {
  it('keeps listed models in priority order with their own efforts', () => {
    const models = parseCodexModels(CODEX_OUTPUT);
    expect(models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5']);
    expect(models[0]?.efforts).toEqual(['low', 'max', 'ultra']);
    expect(models[0]?.defaultEffort).toBe('low');
    expect(models[1]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('refuses names that would parse as flags', () => {
    expect(parseCodexModels(CODEX_OUTPUT).some((m) => m.id.startsWith('-'))).toBe(false);
  });
});

describe('parseAgyModels', () => {
  it('folds effort variants into families', () => {
    const models = parseAgyModels(AGY_OUTPUT);
    const flash = models.find((m) => m.id === 'gemini-3.8-flash');
    expect(flash?.efforts).toEqual(['low', 'medium', 'high']);
    expect(flash?.effortRequired).toBe(true);
    expect(flash?.defaultEffort).toBe('high');
    expect(flash?.label).toBe('Gemini 3.8 Flash');
    expect(models.find((m) => m.id === 'gemini-3.1-pro')?.efforts).toEqual(['low', 'high']);
  });

  it('keeps models without an effort in the name as plain models', () => {
    const models = parseAgyModels(AGY_OUTPUT);
    expect(models.find((m) => m.id === 'claude-sonnet-4-6')?.efforts).toEqual([]);
    expect(models.find((m) => m.id === 'gpt-oss-120b')?.efforts).toEqual(['medium']);
  });

  it('skips the info line', () => {
    expect(parseAgyModels('Fetching available models...\n')).toEqual([]);
  });
});

const claude: Catalog = {
  brain: 'claude',
  models: [
    {
      id: 'opus',
      label: 'Opus',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      effortRequired: false,
      variants: [],
    },
    { id: 'haiku', label: 'Haiku', efforts: [], effortRequired: false, variants: [] },
  ],
  defaultEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  source: 'builtin',
  fetchedAt: '',
};
const agy: Catalog = {
  brain: 'antigravity',
  models: parseAgyModels(AGY_OUTPUT),
  defaultEfforts: ['low', 'medium', 'high'],
  source: 'cli',
  fetchedAt: '',
};

describe('resolvePick', () => {
  it('passes through a valid choice', () => {
    expect(resolvePick(claude, { model: 'opus', effort: 'high' })).toEqual({ model: 'opus', effort: 'high' });
  });

  it('refuses an effort the model does not have — Claude Code would silently ignore it', () => {
    expect(() => resolvePick(claude, { model: 'opus', effort: 'ultra' })).toThrow(/opus|Opus/);
    expect(() => resolvePick(claude, { model: 'haiku', effort: 'low' })).toThrow(/no configurable effort/);
  });

  it('refuses words that are not efforts at all', () => {
    const attempt = () => resolvePick(claude, { effort: 'turbo' });
    expect(attempt).toThrow(BrainyardError);
    expect(attempt).toThrow(/no effort "turbo"/);
  });

  it('refuses a model name that would be parsed as a flag', () => {
    expect(() => resolvePick(claude, { model: '--dangerous' })).toThrow(/model name/);
  });

  it('fills in the effort an Antigravity family cannot start without', () => {
    expect(resolvePick(agy, { model: 'gemini-3.8-flash' })).toEqual({ model: 'gemini-3.8-flash', effort: 'high' });
  });

  it('turns a variant name into family + effort', () => {
    expect(resolvePick(agy, { model: 'gemini-3.8-flash-low' })).toEqual({ model: 'gemini-3.8-flash', effort: 'low' });
    expect(() => resolvePick(agy, { model: 'gemini-3.8-flash-low', effort: 'high' })).toThrow(/already has effort low/);
  });

  it('lets unknown model names through: catalogs can be partial', () => {
    expect(resolvePick(claude, { model: 'claude-opus-5-5' })).toEqual({ model: 'claude-opus-5-5' });
  });

  it('checks the effort against the whole vocabulary for unknown models', () => {
    expect(() => resolvePick(agy, { model: 'gemini-99', effort: 'max' })).toThrow(/efforts: low, medium, high/);
  });

  it('returns nothing to change when nothing was asked', () => {
    expect(resolvePick(claude, {})).toEqual({});
  });
});
