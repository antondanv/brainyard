/**
 * The app's languages: English, the default, and Russian. A text is its own
 * key: `t('waiting')` is `waiting` in English and its Russian from `RU`
 * otherwise; `{name}` takes a parameter. Every text the app shows goes
 * through here, and a test checks that each has its Russian.
 */
import { RU } from './ru.js';

export const LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', ru: 'Русский' };

export interface Translate {
  (text: string, params?: Record<string, string | number>): string;
  language: Language;
}

export function translator(language: Language): Translate {
  const t = ((text: string, params?: Record<string, string | number>) => {
    let out = language === 'ru' ? (RU[text] ?? text) : text;
    for (const [name, value] of Object.entries(params ?? {})) out = out.replaceAll(`{${name}}`, String(value));
    return out;
  }) as Translate;
  t.language = language;
  return t;
}

/** Nouns that follow a number: English has one and many, Russian one, few and many. */
const NOUNS: Record<string, { en: [string, string]; ru: [string, string, string] }> = {
  pane: { en: ['pane', 'panes'], ru: ['панель', 'панели', 'панелей'] },
  session: { en: ['session', 'sessions'], ru: ['сессия', 'сессии', 'сессий'] },
  waiting: { en: ['waiting', 'waiting'], ru: ['ждёт', 'ждут', 'ждут'] },
  unpriced: { en: ['unpriced', 'unpriced'], ru: ['без цены', 'без цены', 'без цены'] },
};

/** `3 panes`, `3 панели`, `5 панелей`. */
export function count(t: Translate, n: number, noun: keyof typeof NOUNS): string {
  const forms = NOUNS[noun]!;
  if (t.language === 'en') return `${n} ${n === 1 ? forms.en[0] : forms.en[1]}`;
  const tens = n % 100;
  const ones = n % 10;
  const form = tens >= 11 && tens <= 14 ? 2 : ones === 1 ? 0 : ones >= 2 && ones <= 4 ? 1 : 2;
  return `${n} ${forms.ru[form]}`;
}

const UNITS: Record<Language, { m: string; h: string; d: string }> = {
  en: { m: 'm', h: 'h', d: 'd' },
  ru: { m: ' мин', h: ' ч', d: ' д' },
};

/** How long ago, in the largest whole unit: `now`, `5m`, `3h`, `2d` — `сейчас`, `5 мин`, `3 ч`, `2 д`. */
export function ago(t: Translate, ms: number, now: number): string {
  const unit = UNITS[t.language];
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 90) return t('now');
  if (seconds < 3600) return `${Math.round(seconds / 60)}${unit.m}`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}${unit.h}`;
  return `${Math.round(seconds / 86_400)}${unit.d}`;
}

/** Time until a moment, coarse: `35m`, `2h 10m`, `4d 3h`; a moment past is `now`. */
export function until(t: Translate, ms: number, now: number): string {
  const unit = UNITS[t.language];
  const minutes = Math.round((ms - now) / 60_000);
  if (minutes <= 0) return t('now');
  if (minutes < 60) return `${minutes}${unit.m}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}${unit.h} ${minutes % 60}${unit.m}` : `${hours}${unit.h}`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}${unit.d} ${hours % 24}${unit.h}` : `${days}${unit.d}`;
}

/** A limit window by its length (`5h`, `weekly`), else by its own name. */
export function windowLabel(t: Translate, limit: { window: string; windowMinutes?: number }): string {
  const minutes = limit.windowMinutes;
  if (minutes === 10_080) return t('weekly');
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}${UNITS[t.language].d}`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}${UNITS[t.language].h}`;
  const named: Record<string, string> = { monthly: t('monthly'), weekly: t('weekly'), rolling: t('rolling') };
  return named[limit.window] ?? limit.window.replaceAll('_', '-');
}
