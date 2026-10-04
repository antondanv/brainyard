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
  it('shows agents with their limits, panes, sessions elsewhere and this folder’s sessions with their usage', () => {
    const state = world();
    const lines = render(state, plain);
    expectScreen(lines, state);
    expect(trimmed(lines)).toEqual([
      'Brainyard 0.2.0  [1 Overview]  2 Wall   3 Sessions   4 Usage   5 Settings      ⚠ 1 waiting · 2 panes',
      '',
      'Agents',
      '  ● Claude Code  2.1.999   ready         signed in with claude.ai, max as j***@example.com',
      '    limits  not checked: brainyard usage --live (one tiny real call)',
      '  ● Codex        0.50.0    ready         signed in with ChatGPT · default model gpt-5.5',
      '    limits  5h 34% · resets in 2h   weekly 92% · resets in 4d 3h   seen 3h ago',
      '  ● Antigravity  1.2.0     ready         signed in · model list fetched with your account',
      '    limits  Gemini: weekly 1%',
      '            Claude and GPT: weekly 40%',
      '  ● OpenCode     —         not installed → npm install -g opencode-ai',
      '',
      'Panes · 2',
      '› claude-1a2b3c4d  Claude Code  aaaa1111  285 MB  working            active     /work/app    auth r…',
      '  codex-5e6f7a8b   Codex        bbbb2222  120 MB  waiting: approval  quiet 12m  /work/other',
      '',
      'Running in other folders · 1',
      '  Claude Code  cccc3333  3m       /work/other  Nightly cleanup bg ● working',
      '',
      'Sessions of /work/app · 3 · $4.23 + 1 unpriced · 14k in · 38k out · 31M cache',
      '  Claude Code  aaaa1111  now  1.2k in   34k out  31M cache     $4.21  Auth refactor ● working ▣ cla…',
      '  Claude Code  dddd4444  3h    950 in   120 out                $0.02  Fix the flaky test',
      '  Codex        eeee5555  2d    12k in  3.4k out             no price  Explain CRDTs',
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

  it('is the same frame in colour: the selected row inverted, every row still the screen’s width', () => {
    const state = world();
    const lines = render(state, colour);
    expectScreen(lines, state);
    const selected = lines.find((line) => line.includes('claude-1a2b3c4d') && line.includes('›'));
    expect(selected?.startsWith('\u001b[7m')).toBe(true);
    expect(lines.filter((line) => line.startsWith('\u001b[7m'))).toHaveLength(1);
    expect(lines.map(uncoloured)).toEqual(render(state, plain));
    expect(lines.join('\n')).toContain('\u001b[31m92%');
  });

  it('cuts rows that do not fit, and asks for room when the window is too small', () => {
    const narrow = world({ width: 60, height: 20 });
    const lines = render(narrow, plain);
    expectScreen(lines, narrow);
    expect(lines.some((line) => line.endsWith('…'))).toBe(true);
    // A narrow screen names only the open page; the cost of the panes goes first.
    expect(lines[0]).toMatch(/^Brainyard {2}\[1 Overview\] 2 {2}3 {2}4 {2}5 +⚠ 1 waiting · 2 panes$/);

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
    expect(text).toContain('› ○ Claude Code  checking…');
    expect(text).toContain('  ○ Codex        checking…');
    expect(text).toContain('Panes\n  reading…');
    expect(text).toContain('Sessions of /work/app\n  reading…');

    const failing = world(
      {},
      { status: undefined, panes: [], tmux: false, errors: { status: 'claude: spawn EACCES' } },
    );
    const shown = trimmed(render(failing, plain)).join('\n');
    expect(shown).toContain('Agents · claude: spawn EACCES');
    expect(shown).toContain('Panes · 0\n  panes need tmux');
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
    expect(help.at(-1)).toBe(' any key — back');
  });

  it('shows a busy line, then a note, and keys for what is selected', () => {
    const keys = (selected: string) => trimmed(render(world({ selected }), plain)).at(-1);
    expect(keys('agent:codex')).toBe(' Enter new Codex pane · n new · ? help · q quit');
    expect(keys('running:claude:cccc3333-0000-4000-8000-000000000003')).toBe(' s stop · n new · ? help · q quit');
    expect(keys('session:claude:dddd4444-0000-4000-8000-000000000004')).toBe(
      ' Enter or r continue in a pane · n new · ? help · q quit',
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
    // Past the end, the last rows fill the body.
    const end = trimmed(render({ ...state, scroll: 999 }, plain));
    expect(end.at(-3)).toContain('Session 39');
  });

  it('keeps a hostile or wide title from breaking the frame', () => {
    const title = 'Clear\u001b[2J\u001b]8;;http://x\u0007link\u001b]8;;\u0007 漢字テスト 🔥🔥 ok';
    const state = world(
      { width: 72 },
      { sessions: [{ brain: 'claude', id: 'abcd0000-1', cwd: HERE, title, interactive: true }], usage: [] },
    );
    const lines = render(state, colour);
    expectScreen(lines, state);
    const row = lines.find((line) => line.includes('abcd0000'))!;
    expect(row).not.toContain('\u001b[2J');
    expect(row).not.toContain('\u001b]8');
    expect(row).toContain('Clearlink 漢字テスト 🔥🔥 ok');
  });
});
