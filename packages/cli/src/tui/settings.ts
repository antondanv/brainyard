/**
 * The app's settings: a theme and an accent, the wall's layout, the bell,
 * the page it opens on. Changed on the settings page and kept in
 * `$XDG_CONFIG_HOME/brainyard/app.json` (`~/.config/brainyard/app.json`),
 * where your own colours can go too: `"colors": {"accent": "#ff8700"}`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Colour, Theme } from '../term.js';

/** The app's pages, left to right; digits 1–5 open them. */
export const PAGES = ['overview', 'wall', 'sessions', 'usage', 'settings'] as const;
export type Page = (typeof PAGES)[number];

/** How the wall lays its tiles out. */
export const LAYOUTS = ['grid', 'main', 'columns'] as const;
export type Layout = (typeof LAYOUTS)[number];

export const THEMES = {
  /** The terminal's own sixteen colours: whatever its theme makes of them. */
  terminal: {},
  ocean: {
    accent: '38;5;45',
    cyan: '38;5;80',
    blue: '38;5;39',
    green: '38;5;79',
    yellow: '38;5;221',
    red: '38;5;204',
    magenta: '38;5;141',
    gray: '38;5;67',
  },
  ember: {
    accent: '38;5;208',
    cyan: '38;5;216',
    blue: '38;5;173',
    green: '38;5;150',
    yellow: '38;5;214',
    red: '38;5;196',
    magenta: '38;5;211',
    gray: '38;5;137',
  },
  forest: {
    accent: '38;5;114',
    cyan: '38;5;108',
    blue: '38;5;109',
    green: '38;5;71',
    yellow: '38;5;186',
    red: '38;5;167',
    magenta: '38;5;139',
    gray: '38;5;242',
  },
  contrast: {
    accent: '96',
    cyan: '96',
    blue: '94',
    green: '92',
    yellow: '93',
    red: '91',
    magenta: '95',
    gray: '37',
  },
  /** No colours: bold, dim and inverse say it all. */
  mono: { accent: '1', cyan: '', blue: '', green: '', yellow: '', red: '', magenta: '', gray: '' },
} satisfies Record<string, Theme>;
export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/** The accent over the theme's own. */
export const ACCENTS = {
  theme: undefined,
  cyan: '36',
  blue: '34',
  magenta: '35',
  green: '32',
  yellow: '33',
  orange: '38;5;208',
  pink: '38;5;205',
  violet: '38;5;141',
} satisfies Record<string, string | undefined>;
export type AccentName = keyof typeof ACCENTS;
export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

export interface Settings {
  theme: ThemeName;
  accent: AccentName;
  layout: Layout;
  /** Ring when an agent starts waiting for the person. */
  bell: boolean;
  start: Page;
  /** Your own colours over the theme, by name: `#rrggbb` or a number of the 256. Kept from the file. */
  colors?: Partial<Record<Colour, string>>;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'terminal',
  accent: 'theme',
  layout: 'grid',
  bell: true,
  start: 'overview',
};

const COLOURS: readonly Colour[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'gray', 'accent'];

/** `#5fd7ff` or `45` as an SGR foreground code; undefined for anything else. */
export function colourCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) return `38;5;${value}`;
  if (typeof value !== 'string') return undefined;
  const hex = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (hex)
    return `38;2;${hex
      .slice(1)
      .map((part) => Number.parseInt(part, 16))
      .join(';')}`;
  return /^\d{1,3}$/.test(value.trim()) ? colourCode(Number(value)) : undefined;
}

/** The theme's codes with the accent and your own colours over them. */
export function themeOf(settings: Settings): Theme {
  const theme: Theme = { ...THEMES[settings.theme] };
  const accent = ACCENTS[settings.accent];
  if (accent) theme.accent = accent;
  for (const [name, value] of Object.entries(settings.colors ?? {})) {
    const code = colourCode(value);
    if (code && (COLOURS as readonly string[]).includes(name)) theme[name as Colour] = code;
  }
  return theme;
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Settings from whatever the file holds: what is unknown or wrong falls back to the default. */
export function parseSettings(data: unknown): Settings {
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const settings: Settings = {
    theme: pick(raw.theme, THEME_NAMES, DEFAULT_SETTINGS.theme),
    accent: pick(raw.accent, ACCENT_NAMES, DEFAULT_SETTINGS.accent),
    layout: pick(raw.layout, LAYOUTS, DEFAULT_SETTINGS.layout),
    bell: typeof raw.bell === 'boolean' ? raw.bell : DEFAULT_SETTINGS.bell,
    start: pick(raw.start, PAGES, DEFAULT_SETTINGS.start),
  };
  if (raw.colors && typeof raw.colors === 'object' && !Array.isArray(raw.colors)) {
    const colors = Object.fromEntries(
      Object.entries(raw.colors as Record<string, unknown>).filter(
        ([name, value]) => (COLOURS as readonly string[]).includes(name) && colourCode(value) !== undefined,
      ),
    ) as Partial<Record<Colour, string>>;
    if (Object.keys(colors).length > 0) settings.colors = colors;
  }
  return settings;
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config');
  return join(base, 'brainyard', 'app.json');
}

export function loadSettings(path = settingsPath()): Settings {
  try {
    return parseSettings(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings, path = settingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
