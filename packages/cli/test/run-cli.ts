import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FAKE } from '../../brainyard/test/helpers.js';

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
