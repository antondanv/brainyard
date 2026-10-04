import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { describe, expect, it } from 'vitest';

import { cliEnv, root, TEST_SOCKET } from './run-cli.js';

describe('brainyard serve', () => {
  it('serves the API with no browser, says where on one line and stops on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'serve', '--port', '0', '--json'], {
      cwd: root,
      // A token in the environment stays out of the process list.
      env: cliEnv({ BRAINYARD_TOKEN: 'token-from-env', BRAINYARD_TMUX_SOCKET: `${TEST_SOCKET}-serve` }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const [line] = await once(createInterface({ input: child.stdout }), 'line');
      const where = JSON.parse(line as string);
      expect(where).toEqual({
        url: `http://127.0.0.1:${where.port}`,
        port: expect.any(Number),
        token: 'token-from-env',
      });

      const panes = await fetch(`${where.url}/api/panes`, { headers: { authorization: 'Bearer token-from-env' } });
      expect(panes.status).toBe(200);
      expect(await panes.json()).toEqual([]);
      expect((await fetch(`${where.url}/api/panes`)).status).toBe(401);

      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      expect((await exited)[0]).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
