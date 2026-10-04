/**
 * The app in a terminal: the alternate screen, raw keys, only the rows that
 * changed are written. Entering a pane hands the terminal to tmux until
 * Ctrl+Q; leaving the app gives the terminal back as it was.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { attachPane } from '@antondanv/brainyard';

import { colourful } from '../term.js';
import { VERSION } from '../version.js';
import { type App, type Sources, startApp } from './app.js';
import { parseKeys } from './keys.js';

const ENTER = '\u001b[?1049h\u001b[?25l\u001b[?7l\u001b[2J';
const LEAVE = '\u001b[0m\u001b[?7h\u001b[?25h\u001b[?1049l';

/** The folder as given and as the file system resolves it: CLIs write down either. */
export function placesOf(cwd: string): string[] {
  const out = new Set([resolve(cwd)]);
  try {
    out.add(realpathSync(cwd));
  } catch {
    // A folder that is gone still has its given name.
  }
  return [...out];
}

/** Runs the app until the person quits; panes keep running after it. */
export async function runApp(options: { cwd?: string; sources?: Partial<Sources> } = {}): Promise<number> {
  const input = process.stdin;
  const output = process.stdout;
  const cwd = resolve(options.cwd ?? process.cwd());
  const size = () => ({ width: output.columns || 80, height: output.rows || 24 });
  const decoder = new StringDecoder('utf8');
  let shown: string[] = [];
  let app: App | undefined;
  let done: (code: number) => void = () => undefined;

  // Whatever else writes to stderr (a warning, a library) would tear the frame: it waits for the end.
  const held: string[] = [];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const hold = () => {
    process.stderr.write = ((chunk: string | Uint8Array) => {
      held.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
  };
  const release = () => {
    process.stderr.write = stderrWrite;
  };

  const onData = (chunk: Buffer) => {
    for (const key of parseKeys(decoder.write(chunk))) app?.dispatch({ kind: 'key', key });
  };
  const onResize = () => {
    shown = [];
    output.write('\u001b[2J');
    app?.dispatch({ kind: 'resize', ...size() });
  };

  const takeOver = () => {
    hold();
    output.write(ENTER);
    shown = [];
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  };
  const giveBack = () => {
    input.off('data', onData);
    input.setRawMode(false);
    input.pause();
    output.write(LEAVE);
    release();
  };

  const draw = (lines: string[]) => {
    let out = '';
    for (const [row, line] of lines.entries()) {
      if (shown[row] !== line) out += `\u001b[${row + 1};1H${line}\u001b[0m`;
    }
    shown = lines;
    if (out) output.write(out);
  };

  const attach = async (pane: string) => {
    giveBack();
    // As open() does before a CLI takes the terminal: flush a fresh pause first.
    input.resume();
    input.pause();
    await new Promise<void>((next) => setImmediate(next));
    try {
      await attachPane(pane, { hint: 'Ctrl+Q — back to Brainyard' });
    } finally {
      takeOver();
    }
  };

  // A signal or a crash must not leave the terminal raw and on the alternate screen.
  const onSignal = (signal: NodeJS.Signals) => {
    app?.stop();
    done(signal === 'SIGINT' ? 130 : 143);
  };
  const onCrash = (error: unknown) => {
    app?.stop();
    finish();
    process.stderr.write(`${String((error as Error)?.stack ?? error)}\n`);
    process.exit(1);
  };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    output.off('resize', onResize);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
    giveBack();
    if (held.length > 0) process.stderr.write(held.join(''));
  };

  return new Promise<number>((resolveRun) => {
    done = (code) => {
      finish();
      resolveRun(code);
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);
    output.on('resize', onResize);
    takeOver();
    app = startApp({
      cwd,
      places: placesOf(cwd),
      version: VERSION,
      ...size(),
      colour: colourful(output),
      ...(options.sources ? { sources: options.sources } : {}),
      host: {
        draw,
        attach,
        redraw: () => {
          shown = [];
          output.write('\u001b[2J');
        },
        quit: () => done(0),
      },
    });
  });
}
