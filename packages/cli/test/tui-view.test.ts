import type { SessionInfo } from '@antondanv/brainyard';
import { describe, expect, it } from 'vitest';

import { palette, plain as uncoloured } from '../src/term.js';
import type { State } from '../src/tui/state.js';
import { cells } from '../src/tui/text.js';
import { render } from '../src/tui/view.js';
import { HERE, NOW, world } from './tui-world.js';

const plain = palette(false);
const colour = palette(true);

/** Every frame is the screen's size exactly: rows of the screen's width in cells, no control characters but colours. */
function expectScreen(lines: string[], state: State): void {
  expect(lines).toHaveLength(state.height);
  for (const line of lines) {
    expect(cells(line)).toBe(state.width);
    const control = [...uncoloured(line)].filter((char) => char < ' ' || (char >= '\u007f' && char < '\u00a0'));
    expect(control).toEqual([]);
  }
}

const trimmed = (lines: string[]) => lines.map((line) => line.trimEnd());

describe('the screen', () => {
  it('shows the agents as cards with their limits, then boxes of panes and sessions', () => {
    const state = world();
    const lines = render(state, plain);
    expectScreen(lines, state);
    expect(trimmed(lines)).toEqual([
      'Brainyard 0.2.0  [1 Overview]  2 Wall   3 Sessions   4 Usage   5 Settings      ⚠ 1 waiting · 2 panes',
      '╭─ Claude Code ────────────────────────── ready ─╮╭─ Codex ──────────────────────────────── ready ─╮',
      '│ 2.1.999  claude.ai · max                       ││ 0.50.0  ChatGPT                                │',
      '│ 5h       ███████████████████▊░░░░░░░░░░░░  62% ││ 5h       ██████████▉░░░░░░░░░░░░░░░░░░░░░  34% │',
      '│ weekly   ████████████████████████████████ 100% ││ weekly   █████████████████████████████▍░░  92% │',
      '╰────────────────────────────────── seen 7h ago ─╯╰────────────────────────────────── seen 3h ago ─╯',
      '╭─ Antigravity ────────────────────────── ready ─╮╭─ OpenCode ───────────────────── not installed ─╮',
      '│ 1.2.0  signed in                               ││ —  npm install -g opencode-ai                  │',
      '│ Gemini   ▎░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   1% ││                                                │',
      '│ Claude   ████████████▊░░░░░░░░░░░░░░░░░░░  40% ││                                                │',
      '╰────────────────────────────────────────────────╯╰────────────────────────────────────────────────╯',
      '╭─ Panes ─────────────────────────────────────────────────────────────────────── 2 panes · 405 MB ─╮',
      '│ ▌ ● auth refactor                      Claude Code  working                      active   285 MB │',
      '│   ● (no label) · /work/other           Codex        waiting: approval         quiet 12m   120 MB │',
      '╰──────────────────────────────────────────────────────────────────────────────────────────────────╯',
      '╭─ Running in other folders ─────────────────────────────────────────────────────────────────── 1 ─╮',
      '│   ● Nightly cleanup bg · /work/other                   Claude Code      3m  working              │',
      '╰──────────────────────────────────────────────────────────────────────────────────────────────────╯',
      '╭─ Sessions · /work/app ───────────────────────────────────────── 3 sessions · $4.23 · 31M tokens ─╮',
      '│   ● Auth refactor                   Claude Code     now  ▣ claude-1a2b3c4d        31M      $4.21 │',
      '│   ○ Fix the flaky test              Claude Code      3h                          1.1k      $0.02 │',
      '│   ○ Explain CRDTs                   Codex            2d                           15k   no price │',
      '╰──────────────────────────────────────────────────────────────────────────────────────────────────╯',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      ' Enter go in (Ctrl+Q back) · x close · n new · ? help · q quit',
    ]);
  });

  it('is the same frame in colour: the selection marked in the accent, every row still the screen’s width', () => {
    const state = world();
    const lines = render(state, colour);
    expectScreen(lines, state);
    expect(lines.map(uncoloured)).toEqual(render(state, plain));
    const selected = lines.filter((line) => line.includes('\u001b[36m▌'));
    expect(selected).toHaveLength(1);
    expect(uncoloured(selected[0]!)).toContain('auth refactor');
    expect(lines.join('\n')).toContain('\u001b[31m██');
    // The card of the selected agent takes the accent too.
    const agent = render(world({ selected: 'agent:codex' }), colour);
    expect(agent[1]).toContain('\u001b[36m╭─');
  });

  it('puts two cards in a row on a narrower screen, one on a narrow one, and asks for room below that', () => {
    const middle = world({ width: 80, height: 30 });
    const two = render(middle, plain);
    expectScreen(two, middle);
    expect(two[1]).toMatch(/^╭─ Claude Code ─+ ready ─╮╭─ Codex ─+ ready ─╮$/);
    const narrow = world({ width: 60, height: 30 });
    const lines = render(narrow, plain);
    expectScreen(lines, narrow);
    // A narrow screen names only the open page; the memory of the panes goes first.
    expect(lines[0]).toMatch(/^Brainyard {2}\[1 Overview\] 2 {2}3 {2}4 {2}5 +⚠ 1 waiting · 2 panes$/);
    expect(lines[1]).toMatch(/^╭─ Claude Code ─+ ready ─╮$/);
    // Columns give way: the pane's state stays, its name and memory go first.
    expect(lines.find((line) => line.includes('auth refactor'))).toContain('working');

    const tiny = world({ width: 30, height: 5 });
    const shown = render(tiny, plain);
    expectScreen(shown, tiny);
    expect(shown[0]).toBe('Brainyard needs at least 40×8 ');
  });

  it('says what is still being read, and what could not be', () => {
    const loading = world(
      {},
      {
        status: undefined,
        limits: undefined,
        panes: undefined,
        live: undefined,
        sessions: undefined,
        usage: undefined,
      },
    );
    const text = trimmed(render(loading, plain)).join('\n');
    expect(text).toMatch(/╭─ Claude Code ─+ checking… ─╮/);
    expect(text).toMatch(/╭─ Panes ─+╮\n│ {3}reading… +│/);
    expect(text).toMatch(/╭─ Sessions · \/work\/app ─+╮\n│ {3}reading… +│/);

    const failing = world(
      {},
      { status: undefined, panes: [], tmux: false, errors: { status: 'claude: spawn EACCES' } },
    );
    const shown = trimmed(render(failing, plain)).join('\n');
    // Cards stand two in a row here: the next one follows on the same lines.
    expect(shown).toMatch(/╭─ Claude Code ─+ unknown ─╮╭/);
    expect(shown).toMatch(/│ claude: spawn EACCES +││/);
    expect(shown).toMatch(/╭─ Panes ─+ 0 panes ─╮\n│ {3}panes need tmux +│/);
  });

  it('asks before closing, offers the CLIs for a new pane and shows the keys on ?', () => {
    const asking = world({
      dialog: {
        kind: 'confirm',
        question: 'Close claude-1a2b3c4d?',
        effect: { kind: 'close', pane: 'claude-1a2b3c4d' },
      },
    });
    const lines = trimmed(render(asking, plain));
    expect(lines.at(-2)).toBe(' Close claude-1a2b3c4d?');
    expect(lines.at(-1)).toBe(' y yes · any other key no');

    const choosing = trimmed(render(world({ dialog: { kind: 'new', brain: 'codex' } }), plain));
    // OpenCode is not installed: it is not offered.
    expect(choosing.at(-2)).toBe(' New pane in /work/app:   Claude Code  [Codex]  Antigravity');
    expect(choosing.at(-1)).toBe(' ←→ choose · Enter start · Esc cancel');

    const help = trimmed(render(world({ dialog: { kind: 'help' }, scroll: 9 }), plain));
    expect(help[2]).toBe('Keys');
    expect(help.join('\n')).toContain('Enter            into the pane, full screen; Ctrl+Q — back');
    expect(help.join('\n')).toContain('i                type into it: every key goes to its CLI until Ctrl+Q');
    expect(help.at(-1)).toBe(' any key back');
  });

  it('shows a busy line, then a note, and keys for what is selected', () => {
    const keys = (selected: string) => trimmed(render(world({ selected }), plain)).at(-1);
    expect(keys('agent:codex')).toBe(' Enter new Codex pane · n new · ? help · q quit');
    expect(keys('running:claude:cccc3333-0000-4000-8000-000000000003')).toBe(' s stop · n new · ? help · q quit');
    expect(keys('session:claude:dddd4444-0000-4000-8000-000000000004')).toBe(
      ' Enter continue in a pane · n new · ? help · q quit',
    );
    expect(keys('session:claude:aaaa1111-0000-4000-8000-000000000001')).toBe(
      ' Enter go in (Ctrl+Q back) · x close the pane · n new · ? help · q quit',
    );
    expect(trimmed(render(world({ busy: 'starting Codex…' }), plain)).at(-2)).toBe(' starting Codex…');
    expect(trimmed(render(world({ note: { text: 'closed it', tone: 'ok' } }), plain)).at(-2)).toBe(' closed it');
  });

  it('scrolls the body under a header and keys that stay', () => {
    const many: SessionInfo[] = Array.from({ length: 40 }, (_, index) => ({
      brain: 'codex',
      id: `ffff${String(index).padStart(4, '0')}-0000-4000-8000-000000000000`,
      cwd: HERE,
      title: `Session ${index}`,
      updatedAt: new Date(NOW - index * 60_000).toISOString(),
      interactive: true,
    }));
    const state = world({ height: 12, scroll: 30 }, { sessions: many, usage: [], live: [] });
    const lines = trimmed(render(state, plain));
    expect(lines[0]).toMatch(/^Brainyard/);
    expect(lines.at(-1)).toMatch(/q quit$/);
    expect(lines.slice(1, -2).some((line) => line.includes('Session 1'))).toBe(true);
    // Past the end, the last rows fill the body: the last session, then its box's bottom.
    const end = trimmed(render({ ...state, scroll: 999 }, plain));
    expect(end.at(-4)).toContain('Session 39');
    expect(end.at(-3)).toMatch(/^╰─+╯$/);
  });

  it('keeps a hostile or wide title from breaking the frame', () => {
    const title = 'Clear\u001b[2J\u001b]8;;http://x\u0007link\u001b]8;;\u0007 漢字テスト 🔥🔥 ok';
    const state = world(
      { width: 120 },
      { sessions: [{ brain: 'claude', id: 'abcd0000-1', cwd: HERE, title, interactive: true }], usage: [] },
    );
    const lines = render(state, colour);
    expectScreen(lines, state);
    const row = lines.find((line) => line.includes('Clearlink'))!;
    expect(row).not.toContain('\u001b[2J');
    expect(row).not.toContain('\u001b]8');
    expect(uncoloured(row)).toContain('Clearlink 漢字テスト 🔥🔥 ok');
  });
});
