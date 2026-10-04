import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { palette, plain as uncoloured } from '../src/term.js';
import { bar } from '../src/tui/pages.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseSettings,
  saveSettings,
  settingsPath,
  themeOf,
} from '../src/tui/settings.js';
import { type Effect, listFocus, type State } from '../src/tui/state.js';
import { cells } from '../src/tui/text.js';
import { update } from '../src/tui/update.js';
import { render } from '../src/tui/view.js';
import { HERE, LIVE, world } from './tui-world.js';

const plain = palette(false);
const trimmed = (lines: string[]) => lines.map((line) => uncoloured(line).trimEnd());

function press(state: State, ...keys: string[]): [State, Effect[]] {
  let current = state;
  const effects: Effect[] = [];
  for (const key of keys) {
    const [next, more] = update(current, { kind: 'key', key });
    current = next;
    effects.push(...more);
  }
  return [current, effects];
}

describe('the sessions page', () => {
  const state = world({ page: 'sessions', width: 140, height: 24 });

  it('lists what runs elsewhere and this folder’s sessions, with a card for the selected one', () => {
    const lines = trimmed(render(state, plain));
    expect(lines[1]).toMatch(/^╭─ Sessions {2}\/ filter ─+ 4 ─╮╭─ Nightly cleanup bg ─+╮$/);
    expect(lines[2]).toMatch(/^│ ▌ ● Nightly cleanup bg… {2}Claude Code {6}3m {2}working +││ Claude Code {2}cccc3333-/);
    expect(lines[3]).toMatch(/^│ {3}● Auth refactor +Claude Code {5}now {2}▣ claude-1a2b3c4d +31M ││/);
    // The card: the session's place, its times, what it does, how to stop it, how to go on with it elsewhere.
    const card = lines.slice(2).map((line) => (line.split('││ ')[1] ?? '').replace(/ *│$/, ''));
    expect(card).toContain('folder     /work/other');
    expect(card).toContain('updated    3m ago');
    expect(card).toContain('now        ● working');
    expect(card).toContain('s stop it: the conversation stays');
    expect(card).toContain('claude --resume cccc3333-0000-4000-8000-000000000003');
    for (const line of render(state, palette(true))) expect(cells(line)).toBe(140);
  });

  it('moves, shows usage in the card, and continues or goes into the selected session', () => {
    const [onSaved] = press(state, 'down', 'down');
    expect(listFocus(onSaved).item?.key).toBe('session:claude:dddd4444-0000-4000-8000-000000000004');
    expect(press(onSaved, 'enter')[1]).toEqual([
      { kind: 'start', brain: 'claude', cwd: HERE, resume: 'dddd4444-0000-4000-8000-000000000004' },
    ]);
    const [inPane] = press(state, 'down');
    const card = trimmed(render(inPane, plain)).map((line) => (line.split('││ ')[1] ?? '').replace(/ *│$/, ''));
    expect(card).toContain('used       1.2k in · 34k out · 31M cache');
    expect(card).toContain('cost       $4.21');
    expect(card).toContain('Enter into its pane · x close the pane');
    expect(press(inPane, 'enter')[1]).toEqual([{ kind: 'attach', pane: 'claude-1a2b3c4d' }]);
    expect(press(inPane, 'x')[0].dialog).toMatchObject({ effect: { kind: 'close', pane: 'claude-1a2b3c4d' } });
    expect(press(state, 's')[0].dialog).toMatchObject({ effect: { kind: 'stop', sessionId: LIVE[2]!.id } });
  });

  it('filters by what is typed, in any layout, and Esc clears it', () => {
    const [editing] = press(state, '/');
    expect(editing.list.editing).toBe(true);
    // Typed as the terminal sends it: Cyrillic stays Cyrillic, not keys of another layout.
    const [cyrillic] = update(editing, { kind: 'input', data: 'флаки' });
    expect(cyrillic.list.filter).toBe('флаки');
    const [typed] = update({ ...editing, list: { ...editing.list, filter: '' } }, { kind: 'input', data: 'flaky\r' });
    expect(typed.list).toMatchObject({ filter: 'flaky', editing: false });
    const lines = trimmed(render(typed, plain));
    expect(lines[1]).toMatch(/^╭─ Sessions {2}\/ flaky ─+ 1 ─╮/);
    expect(lines[2]).toContain('Fix the flaky test');
    const [none] = update(editing, { kind: 'input', data: 'zzz' });
    expect(trimmed(render(none, plain))[2]).toContain('nothing fits the filter · Esc clears it');
    const [cleared] = press(typed, 'esc');
    expect(cleared.list.filter).toBe('');
    expect(press(editing, 'x', 'backspace')[0].list.filter).toBe('');
  });
});

describe('the usage page', () => {
  it('draws every window as a bar, then the folder’s use by CLI and the sessions that used most', () => {
    const lines = trimmed(render(world({ page: 'usage', width: 110, height: 30 }), plain));
    const inside = (from: number, to: number) =>
      lines.slice(from, to).map((line) => line.replace(/^│ /, '').replace(/ *│$/, ''));
    expect(lines[1]).toMatch(/^╭─ Subscription limits ─+╮$/);
    expect(inside(2, 9)).toEqual([
      'Claude Code                  5h      ██████████████▉░░░░░░░░░   62%  resets in 1h      seen 7h ago',
      '                             weekly  ████████████████████████  100%  resets in 1d 12h',
      'Codex                        5h      ████████▏░░░░░░░░░░░░░░░   34%  resets in 2h      seen 3h ago',
      '                             weekly  ██████████████████████░░   92%  resets in 4d 3h',
      'Antigravity  Gemini          weekly  ▏░░░░░░░░░░░░░░░░░░░░░░░    1%',
      '             Claude and GPT  weekly  █████████▌░░░░░░░░░░░░░░   40%',
      'OpenCode     not installed',
    ]);
    expect(lines[10]).toMatch(/^╭─ Sessions of \/work\/app ─+ by CLI ─╮$/);
    expect(inside(11, 15)).toEqual([
      '             sessions    in   out  cache   cost',
      'Claude Code         2  2.1k   34k    31M  $4.23',
      'Codex               1   12k  3.4k      0         1 unpriced',
      'total               3   14k   38k    31M  $4.23  1 unpriced',
    ]);
    expect(lines[16]).toMatch(/^╭─ Most tokens ─+╮$/);
    expect(inside(17, 18)[0]).toMatch(/^○ Auth refactor {7}Claude Code {3}31M {5}\$4\.21$/);
  });

  it('fills a bar in eighths of a cell, green, then yellow from 70%, red from 90%', () => {
    expect(bar(0, 4, plain)).toBe('░░░░');
    expect(bar(0.5, 4, plain)).toBe('██░░');
    expect(bar(0.3, 4, plain)).toBe('█▏░░');
    expect(bar(1, 4, plain)).toBe('████');
    const colour = palette(true);
    expect(bar(0.5, 4, colour)).toContain('\u001b[32m');
    expect(bar(0.75, 4, colour)).toContain('\u001b[33m');
    expect(bar(0.95, 4, colour)).toContain('\u001b[31m');
  });
});

describe('the settings page', () => {
  const state = world({ page: 'settings' });

  it('shows each setting with its values, the chosen one marked, and a preview', () => {
    const lines = trimmed(render({ ...state, settingsFile: '~/.config/brainyard/app.json' }, plain));
    const inside = lines.map((line) => line.replace(/^│ /, '').replace(/ *│$/, ''));
    expect(lines[1]).toMatch(/^╭─ Settings ─+ kept in ~\/\.config\/brainyard\/app\.json ─╮$/);
    expect(inside.slice(2, 8)).toEqual([
      '▌ Language                      [English]  Русский',
      '  Theme                         [terminal]  ocean   ember   forest   contrast   mono',
      '  Accent                        ◂ [theme] ▸  1/9',
      '  Wall layout                   [grid]  main   columns',
      '  Bell when an agent waits      [on]  off',
      '  Open on                       [Overview]  Wall   Sessions   Usage   Settings',
    ]);
    expect(lines[9]).toMatch(/^╭─ Preview ─+╮$/);
  });

  it('←→ change a setting and keep it; the layout goes to the wall too', () => {
    const [russian, kept] = press(state, 'right');
    expect(russian.settings.language).toBe('ru');
    expect(kept).toEqual([{ kind: 'save', settings: { ...DEFAULT_SETTINGS, language: 'ru' } }]);
    const [ocean, saved] = press(state, 'down', 'right');
    expect(ocean.settings.theme).toBe('ocean');
    expect(saved).toEqual([{ kind: 'save', settings: { ...DEFAULT_SETTINGS, theme: 'ocean' } }]);
    expect(press(state, 'down', 'left')[0].settings.theme).toBe('mono');
    const [main] = press(state, 'down', 'down', 'down', 'right');
    expect(main.settings.layout).toBe('main');
    expect(main.wall.layout).toBe('main');
    const [quiet] = press(state, 'down', 'down', 'down', 'down', 'enter');
    expect(quiet.settings.bell).toBe(false);
    expect(press(state, 'down', 'down', 'down', 'down', 'down', 'right')[0].settings.start).toBe('wall');
  });

  it('a theme repaints the frame: its own colours, an accent, your own colours from the file', () => {
    const ocean = { ...DEFAULT_SETTINGS, theme: 'ocean' as const };
    expect(themeOf(ocean).accent).toBe('38;5;45');
    expect(themeOf({ ...ocean, accent: 'orange' }).accent).toBe('38;5;208');
    expect(themeOf({ ...ocean, colors: { green: '#87d787', red: '203' } })).toMatchObject({
      green: '38;2;135;215;135',
      red: '38;5;203',
    });
    const frame = render(world(), palette(true, themeOf(ocean)))[0]!;
    expect(frame).toContain('\u001b[38;5;45m\u001b[1m[1 Overview]');
    // Mono: no colour at all, the open page still marked.
    const mono = render(world(), palette(true, themeOf({ ...DEFAULT_SETTINGS, theme: 'mono' })));
    expect(mono.join('\n').includes('\u001b[3')).toBe(false);
  });

  it('are read from the file, whatever it holds, and written back', () => {
    expect(parseSettings({ theme: 'forest', bell: false, layout: 'nonsense', colors: { accent: 99, bad: 1 } })).toEqual(
      {
        ...DEFAULT_SETTINGS,
        theme: 'forest',
        bell: false,
        colors: { accent: 99 },
      },
    );
    expect(parseSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(settingsPath({ XDG_CONFIG_HOME: '/x' })).toBe('/x/brainyard/app.json');
    expect(settingsPath({ HOME: '/h' })).toBe('/h/.config/brainyard/app.json');
    const file = join(mkdtempSync(join(tmpdir(), 'brainyard-settings-')), 'deep', 'app.json');
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'ember' }, file);
    expect(JSON.parse(readFileSync(file, 'utf8')).theme).toBe('ember');
    expect(loadSettings(file).theme).toBe('ember');
  });
});

describe('who waits for the person', () => {
  it('shows in the header and rings once when someone new starts waiting', () => {
    const calm = world(
      {},
      { live: LIVE.map((session) => ({ ...session, live: { status: 'busy', kind: 'interactive' } })) },
    );
    expect(trimmed(render(calm, plain))[0]).not.toContain('waiting');
    const [now, rang] = update(calm, { kind: 'loaded', source: 'live', data: { live: LIVE } });
    expect(rang).toEqual([{ kind: 'bell' }]);
    expect(trimmed(render(now, plain))[0]).toContain('⚠ 1 waiting');
    expect(update(now, { kind: 'loaded', source: 'live', data: { live: LIVE } })[1]).toEqual([]);
    const quiet = { ...calm, settings: { ...calm.settings, bell: false } };
    expect(update(quiet, { kind: 'loaded', source: 'live', data: { live: LIVE } })[1]).toEqual([]);
    // What already waits when the app opens is not news.
    const first = world({}, { live: undefined });
    expect(update(first, { kind: 'loaded', source: 'live', data: { live: LIVE } })[1]).toEqual([]);
  });
});
