import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAKE, tempDir } from '../../brainyard/test/helpers.js';

/** The CLI package: `src/main.ts` runs from here. */
export const root = fileURLToPath(new URL('..', import.meta.url));

/** The tmux server of the command's tests: never the one a person works in. */
export const TEST_SOCKET = `brainyard-test-${process.pid}-cli`;

/** The command's environment: fake CLIs, no colours, the test tmux server. */
export function cliEnv(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    BRAINYARD_TMUX_SOCKET: TEST_SOCKET,
    BRAINYARD_CLAUDE_BIN: JSON.stringify(FAKE.claude),
    BRAINYARD_CODEX_BIN: JSON.stringify(FAKE.codex),
    BRAINYARD_AGY_BIN: JSON.stringify(FAKE.antigravity),
    BRAINYARD_OPENCODE_BIN: JSON.stringify(FAKE.opencode),
    ...env,
  };
}

/** Runs `brainyard …` from source and waits for it. */
export function cli(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  const done = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    cwd: root,
    input: options.input ?? '',
    encoding: 'utf8',
    env: cliEnv(options.env),
    timeout: 30_000,
  });
  return { code: done.status, stdout: done.stdout, stderr: done.stderr };
}

/** A machine of the test's own: its CLI stores are empty folders, and `claude agents` reports `agents`. */
export function machine(agents: unknown[] = []): Record<string, string> {
  const home = tempDir('brainyard-home-');
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    FAKE_AGENTS: JSON.stringify(agents),
  };
}
