/**
 * Which optional flags a CLI build supports, read from its `--help`. Newer
 * flags (`--safe-mode`, `--ephemeral`) are used only where they exist: an
 * unknown option makes the whole call fail on an older version.
 */
import { type Command, capture } from './process.js';
import type { BrainId } from './types.js';

const HELP_ARGS: Record<BrainId, string[][]> = {
  claude: [['--help']],
  codex: [['exec', '--help']],
  antigravity: [['--help']],
  // `run` and the TUI take different flags; one set serves both.
  opencode: [['--help'], ['run', '--help']],
};

const cache = new Map<string, Promise<ReadonlySet<string>>>();

export function cliFlags(brain: BrainId, command: Command): Promise<ReadonlySet<string>> {
  const key = [brain, command.file, ...command.args].join('\u0000');
  let flags = cache.get(key);
  if (!flags) {
    flags = probe(brain, command);
    cache.set(key, flags);
  }
  return flags;
}

async function probe(brain: BrainId, command: Command): Promise<ReadonlySet<string>> {
  const helps = await Promise.all(HELP_ARGS[brain].map((args) => capture(command, args, { timeoutMs: 15_000 })));
  return new Set(helps.flatMap((got) => `${got.stdout}\n${got.stderr}`.match(/--[a-z][a-z0-9-]*/g) ?? []));
}

export function clearFlagCache(): void {
  cache.clear();
}
