/**
 * Finding and running the CLIs. Small on purpose: prompts never travel as
 * arguments (see the adapters), so the only things on a command line are
 * flags and short JSON.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join, normalize, resolve } from 'node:path';

const WINDOWS = process.platform === 'win32';

// Where installers put the CLIs when a GUI or a service starts us with a
// trimmed PATH. Only consulted when PATH has nothing.
function extraDirs(): string[] {
  if (WINDOWS) return [];
  const home = homedir();
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (WINDOWS) return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Full path of an executable, or undefined. */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = WINDOWS ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const candidates = (base: string) => (WINDOWS && extname(base) ? [base] : exts.map((ext) => base + ext));

  if (isAbsolute(bin) || bin.includes('/') || (WINDOWS && bin.includes('\\'))) {
    return candidates(resolve(bin)).find(isExecutable);
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of [...dirs, ...extraDirs()]) {
    const found = candidates(join(dir, bin)).find(isExecutable);
    if (found) return found;
  }
  return undefined;
}

/** What to spawn: an executable plus leading arguments. */
export interface Command {
  file: string;
  args: string[];
  /** Windows batch shims (`claude.cmd`) must go through cmd.exe. */
  shell: boolean;
}

/**
 * `command` option → `BRAINYARD_<ID>_BIN` → the default binary name. The
 * variable holds a path, or a JSON array such as `["node","fake-claude.mjs"]`.
 */
export function resolveCommand(
  command: string | readonly string[] | undefined,
  fallback: string,
  envVar: string,
  env: NodeJS.ProcessEnv = process.env,
): Command | undefined {
  let parts: string[];
  if (Array.isArray(command)) parts = [...command];
  else if (typeof command === 'string' && command) parts = [command];
  else {
    const fromEnv = env[envVar]?.trim();
    parts = fromEnv ? parseEnvCommand(fromEnv) : [fallback];
  }
  const [head, ...rest] = parts;
  if (!head) return undefined;
  const file = which(head, env);
  if (!file) return undefined;
  const ext = extname(file).toLowerCase();
  return { file, args: rest, shell: WINDOWS && (ext === '.cmd' || ext === '.bat') };
}

function parseEnvCommand(value: string): string[] {
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')) return parsed;
    } catch {
      // Not JSON after all: treat it as a path.
    }
  }
  return [value];
}

/** Human-readable command line for logs. */
export function describeCommand(command: Command, args: readonly string[] = []): string {
  return [command.file, ...command.args, ...args]
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

const live = new Set<ChildProcess>();
let exitHook = false;

function track(child: ChildProcess): void {
  live.add(child);
  child.once('exit', () => live.delete(child));
  child.once('error', () => {
    if (child.pid === undefined) live.delete(child);
  });
  if (!exitHook) {
    exitHook = true;
    // Children run in their own process group (so a stop takes down whatever
    // they spawned), which also means they outlive us unless told otherwise.
    process.once('exit', () => {
      for (const child of live) killTree(child, 'SIGKILL');
    });
  }
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: 'pipe' | 'ignore';
}

export function spawnCommand(command: Command, args: readonly string[], options: SpawnOptions): ChildProcess {
  const stdio: ['pipe' | 'ignore', 'pipe', 'pipe'] = [options.stdin, 'pipe', 'pipe'];
  let child: ChildProcess;
  if (command.shell) {
    const double = NPM_SHIM.test(command.file);
    const line = [
      escapeCmdCommand(command.file),
      ...[...command.args, ...args].map((part) => quoteForCmd(part, double)),
    ].join(' ');
    child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      cwd: options.cwd,
      env: options.env,
      stdio,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(command.file, [...command.args, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio,
      windowsHide: true,
      detached: !WINDOWS,
    });
  }
  track(child);
  return child;
}

// Batch files go through `cmd.exe /d /s /c "…"`, quoted the way cross-spawn
// (MIT) does it: the command gets its metacharacters caret-escaped, every
// argument is quoted with backslashes before quotes doubled, and arguments to
// an npm shim in node_modules/.bin are escaped twice, because the shim hands
// them to cmd once more.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const NPM_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

function escapeCmdCommand(file: string): string {
  return normalize(file).replace(CMD_META, '^$1');
}

export function quoteForCmd(arg: string, double = false): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  out = `"${out}"`.replace(CMD_META, '^$1');
  return double ? out.replace(CMD_META, '^$1') : out;
}

/** Stops a child and everything it started. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (WINDOWS) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () =>
      child.kill(signal),
    );
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** SIGTERM, then SIGKILL if the process is still around after `graceMs`. */
export function terminate(child: ChildProcess, graceMs = 3000): void {
  killTree(child, 'SIGTERM');
  const timer = setTimeout(() => killTree(child, 'SIGKILL'), graceMs);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn failed (not found, not executable). */
  error?: Error;
}

/** Runs a short command (`--version`, `auth status`) and collects its output. */
export function capture(
  command: Command,
  args: readonly string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Captured> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawnCommand(command, args, {
        cwd: options.cwd ?? homedir(),
        env: options.env ?? process.env,
        stdin: 'ignore',
      });
    } catch (error) {
      done({ code: null, stdout: '', stderr: '', timedOut: false, error: error as Error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let failure: Error | undefined;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: Captured = { code, stdout, stderr, timedOut };
      if (failure) result.error = failure;
      done(result);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < 4_000_000) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 200_000) stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, options.timeoutMs ?? 15_000);
    child.once('error', (error) => {
      failure = error;
      // A process that never started emits no 'close' we can rely on.
      if (child.pid === undefined) finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}
