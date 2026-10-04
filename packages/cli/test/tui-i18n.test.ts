import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { palette } from '../src/term.js';
import { ago, count, translator, until, windowLabel } from '../src/tui/i18n.js';
import { STATUS_WORDS } from '../src/tui/overview.js';
import { SETTING_LABELS, SETTINGS, settingValues } from '../src/tui/pages.js';
import { RU } from '../src/tui/ru.js';
import { DEFAULT_SETTINGS, PAGE_NAMES } from '../src/tui/settings.js';
import { cells } from '../src/tui/text.js';
import { HELP, render } from '../src/tui/view.js';
import { NOW, world } from './tui-world.js';

const sources = fileURLToPath(new URL('../src/tui/', import.meta.url));

/** Every English text the app passes to its translator, as written in the sources. */
function textsInSources(): string[] {
  const found = new Set<string>();
  for (const name of readdirSync(sources).filter((file) => file.endsWith('.ts') && file !== 'ru.ts')) {
    const source = readFileSync(`${sources}${name}`, 'utf8');
    const calls = /(?:\bt|tr\(\w+\))\(\s*'((?:\\.|[^'\\])*)'|noted\(\s*\w+,\s*'((?:\\.|[^'\\])*)'/g;
    for (const match of source.matchAll(calls)) found.add((match[1] ?? match[2] ?? '').replaceAll("\\'", "'"));
  }
  return [...found];
}

describe('the app in Russian', () => {
  it('has the Russian of every text it shows', () => {
    const texts = [
      ...textsInSources(),
      ...Object.values(PAGE_NAMES),
      ...Object.values(SETTING_LABELS),
      ...STATUS_WORDS,
      ...HELP.map(([, what]) => what).filter(Boolean),
      ...SETTINGS.filter((name) => name !== 'language' && name !== 'start').flatMap((name) => settingValues(name)),
      // The session card's fields and the reasons panes cannot start.
      ...['folder', 'started', 'updated', 'now', 'used', 'cost'],
      ...['panes need tmux, which Windows does not have', 'panes need tmux: brew install tmux'],
    ];
    expect(texts.length).toBeGreaterThan(150);
    const missing = texts.filter((text) => !RU[text]);
    expect(missing).toEqual([]);
    for (const [english, russian] of Object.entries(RU)) {
      // A parameter in one is a parameter in the other.
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(names(russian), english).toEqual(names(english));
    }
  });

  it('counts, says how long ago and how long until in Russian', () => {
    const t = translator('ru');
    expect([
      count(t, 1, 'pane'),
      count(t, 3, 'pane'),
      count(t, 5, 'pane'),
      count(t, 11, 'pane'),
      count(t, 21, 'pane'),
    ]).toEqual(['1 панель', '3 панели', '5 панелей', '11 панелей', '21 панель']);
    expect(count(translator('en'), 2, 'session')).toBe('2 sessions');
    expect(ago(t, NOW - 30_000, NOW)).toBe('сейчас');
    expect(ago(t, NOW - 5 * 60_000, NOW)).toBe('5 мин');
    expect(until(t, NOW + 130 * 60_000, NOW)).toBe('2 ч 10 мин');
    expect(windowLabel(t, { window: 'seven_day', windowMinutes: 10_080 })).toBe('неделя');
    expect(windowLabel(t, { window: 'five_hour', windowMinutes: 300 })).toBe('5 ч');
  });

  it('draws the overview in Russian when the setting says so, every row the screen’s width', () => {
    const state = world({ settings: { ...DEFAULT_SETTINGS, language: 'ru' } });
    const lines = render(state, palette(false));
    for (const line of lines) expect(cells(line)).toBe(100);
    const text = lines.map((line) => line.trimEnd());
    expect(text[0]).toMatch(
      /^Brainyard 0\.2\.0 {2}\[1 Обзор\] {2}2 Стена {3}3 Сессии {3}4 Расход {3}5 Настройки +⚠ 1 ждёт · 2 панели$/,
    );
    expect(text[1]).toMatch(/^╭─ Claude Code ─+ готов ─╮/);
    expect(text[3]).toMatch(/^│ 5 ч +█+.* 62% │/);
    expect(text[5]).toMatch(/─ данные 7 ч назад ─╯/);
    expect(text.join('\n')).toMatch(/╭─ Панели ─+ 2 панели · 405 MB ─╮/);
    expect(text.join('\n')).toContain('ждёт: approval');
    expect(text.join('\n')).toMatch(/╭─ Сессии · \/work\/app ─+ 3 сессии · \$4\.23 · 31M токенов ─╮/);
    expect(text.at(-1)).toBe(' Enter войти (Ctrl+Q назад) · x закрыть · n новая · ? справка · q выход');
  });
});
