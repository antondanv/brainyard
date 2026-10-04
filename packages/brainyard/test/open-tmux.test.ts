import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import { panesAvailable } from '../src/panes.js';
import { FAKE, tempDir } from './helpers.js';

const run = promisify(execFile);
const socket = `brainyard-test-${process.pid}-open`;
const term = async (...args: string[]) => (await run('tmux', ['-L', socket, '-f', '/dev/null', ...args])).stdout;
const screen = () => term('capture-pane', '-p', '-t', '=open:');
async function until(text: string) {
  const end = Date.now() + 8000;
  while (!(await screen()).includes(text) && Date.now() < end) await new Promise((done) => setTimeout(done, 50));
  expect(await screen()).toContain(text);
}

describe.skipIf(!panesAvailable())('interactive terminal handoff', () => {
  afterAll(async () => {
    await term('kill-server').catch(() => undefined);
  });

  it('returns after the resumed CLI exits when the caller previously read the terminal', async () => {
    const cwd = tempDir('brainyard-open-terminal-');
    const script = join(cwd, 'parent.mjs');
    const source = new URL('../src/open.ts', import.meta.url).href;
    writeFileSync(
      script,
      `
      import { open } from ${JSON.stringify(source)};
      process.stdin.setRawMode(true);
      await new Promise((done) => {
        const read = () => {
          if (!process.stdin.read()) return;
          process.stdin.off('readable', read);
          done();
        };
        process.stdin.on('readable', read);
        console.log('parent ready');
      });
      process.stdin.setRawMode(false);
      process.stdin.pause();
      const result = await open({
        brain: 'claude', cwd: ${JSON.stringify(cwd)},
        resume: 'aaaaaaaa-0000-4000-8000-000000000001',
        command: ${JSON.stringify(FAKE.claude)}, env: { FAKE_PANE: '1' },
      });
      console.log('parent returned ' + result.ok);
      setInterval(() => undefined, 1000);
    `,
    );
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
    const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
    await term(
      'new-session',
      '-d',
      '-s',
      'open',
      '-x',
      '100',
      '-y',
      '30',
      '-c',
      cwd,
      '--',
      tsx,
      '--tsconfig',
      tsconfig,
      script,
    );
    try {
      await until('parent ready');
      await term('send-keys', '-t', '=open:', 'i');
      await until('fake-claude ready');
      await term('send-keys', '-t', '=open:', 'q');
      await until('parent returned true');
    } finally {
      await term('kill-session', '-t', '=open').catch(() => undefined);
    }
  });
});
