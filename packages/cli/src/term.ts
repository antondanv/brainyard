/** Terminal output without a dependency: colours honour NO_COLOR and FORCE_COLOR. */
import type { AgentEvent } from '@antondanv/brainyard';

/** Whether colours go to this stream. */
export function colourful(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return stream.isTTY === true && process.env.TERM !== 'dumb';
}

export interface Paint {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  magenta(text: string): string;
  cyan(text: string): string;
  gray(text: string): string;
  /** Swapped foreground and background: the selected row of the app. */
  inverse(text: string): string;
  /** The app's own colour: the open tab, the tile in focus. */
  accent(text: string): string;
}

/** The colours a theme can change, and the accent. */
export type Colour = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray' | 'accent';

/**
 * A theme: SGR codes by colour (`36`, `38;5;45`, `38;2;95;215;255`), `''` for
 * none, `1` for bold instead of a colour. Missing ones are the terminal's own.
 */
export type Theme = Partial<Record<Colour, string>>;

export function paint(stream: NodeJS.WriteStream, force?: boolean): Paint {
  return palette(force ?? colourful(stream));
}

const CODES: Record<Colour, string> = {
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  gray: '90',
  // Bright blue: Brainyard's indigo in most terminals, and apart from cyan, which means working.
  accent: '94',
};

/** Colours on or off, whatever the output is: the app draws the same frame for a terminal and a browser. */
export function palette(on: boolean, theme: Theme = {}): Paint {
  const wrap = (open: string, close: number) => (text: string) =>
    on && open ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  const colour = (name: Colour) => {
    const code = theme[name] ?? CODES[name];
    return wrap(code, code === '1' ? 22 : 39);
  };
  return {
    bold: wrap('1', 22),
    dim: wrap('2', 22),
    red: colour('red'),
    green: colour('green'),
    yellow: colour('yellow'),
    blue: colour('blue'),
    magenta: colour('magenta'),
    cyan: colour('cyan'),
    gray: colour('gray'),
    inverse: wrap('7', 27),
    accent: colour('accent'),
  };
}

// SGR colours (tmux writes underline styles with colons) and OSC sequences such as hyperlinks.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point.
const ANSI = /\u001b\[[0-9;:]*m|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** The text without colour codes. */
export function plain(text: string): string {
  return text.replace(ANSI, '');
}

/** Visible width, ignoring colour codes. */
export function width(text: string): number {
  return [...plain(text)].length;
}

export function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(0, size - width(text)));
}

/** Rows in columns two spaces apart; the `right` columns (numbers) line up on the right. */
export function table(rows: readonly string[][], right: ReadonlySet<number> = new Set()): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [column, cell] of row.entries()) widths[column] = Math.max(widths[column] ?? 0, width(cell));
  }
  return rows.map((row) =>
    row
      .map((cell, column) => {
        const room = (widths[column] ?? 0) - width(cell);
        if (right.has(column)) return ' '.repeat(Math.max(0, room)) + cell;
        return column < row.length - 1 ? cell + ' '.repeat(Math.max(0, room)) : cell;
      })
      .join('  ')
      .trimEnd(),
  );
}

const MARKS: Partial<Record<AgentEvent['kind'], string>> = {
  init: '◆',
  message: '›',
  thinking: '…',
  tool_call: '▸',
  command: '$',
  file_write: '✎',
  tool_result: '←',
  hint: '☞',
  denied: '⊘',
  warning: '!',
  error: '✗',
  stopped: '■',
  done: '✓',
};

/** One feed line for an event. */
export function feedLine(event: AgentEvent, c: Paint, startedAt: number): string {
  const elapsed = Math.max(0, Date.parse(event.at) - startedAt) / 1000;
  const clock = c.gray(
    `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`,
  );
  const failed = event.data?.isError === true;
  const mark = failed ? '✗' : (MARKS[event.kind] ?? '·');
  const ok = event.kind !== 'done' || event.data?.ok !== false;
  let line: string;
  switch (event.kind) {
    case 'message':
      line = `${c.cyan(mark)} ${event.summary}`;
      break;
    case 'thinking':
      line = c.dim(`${mark} ${event.summary}`);
      break;
    case 'hint':
      line = c.magenta(`${mark} ${event.summary}`);
      break;
    case 'warning':
      line = c.yellow(`${mark} ${event.summary}`);
      break;
    case 'error':
    case 'denied':
    case 'stopped':
      line = c.red(`${mark} ${event.summary}`);
      break;
    case 'done':
      line = ok ? c.green(`${mark} ${event.summary}`) : c.red(`✗ ${event.summary}`);
      break;
    case 'init':
      line = c.blue(`${mark} ${event.summary}`);
      break;
    case 'tool_result':
      line = failed ? c.red(`${mark} ${event.summary}`) : c.dim(`${mark} ${event.summary}`);
      break;
    default:
      line = `${c.gray(mark)} ${event.summary}`;
  }
  return `${clock} ${line}`;
}
