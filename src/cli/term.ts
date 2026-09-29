/** Terminal output without a dependency: colours honour NO_COLOR and FORCE_COLOR. */
import type { AgentEvent } from '../types.js';

function enabled(stream: NodeJS.WriteStream): boolean {
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
}

export function paint(stream: NodeJS.WriteStream, force?: boolean): Paint {
  const on = force ?? enabled(stream);
  const wrap = (open: number, close: number) => (text: string) =>
    on ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    gray: wrap(90, 39),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

/** Visible width, ignoring colour codes. */
export function width(text: string): number {
  return [...text.replace(ANSI, '')].length;
}

export function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(0, size - width(text)));
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
