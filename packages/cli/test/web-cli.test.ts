import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';

import { listPanes, panesAvailable } from '@antondanv/brainyard';
import { afterAll, describe, expect, it } from 'vitest';

import { cliEnv, machine, root, TEST_SOCKET } from './run-cli.js';

// Real tmux, on a server of the test's own; the browser is this test, talking HTTP as the page does.
const SOCKET = `${TEST_SOCKET}-web`;

describe('brainyard web', () => {
  it('ends with an error, not hanging, when its port is taken', async () => {
    const taken = createServer();
    await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done));
    const port = (taken.address() as AddressInfo).port;
    try {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/main.ts', 'web', '--port', String(port), '--no-open'],
        {
          cwd: root,
          env: cliEnv({ ...machine(), BRAINYARD_TMUX_SOCKET: SOCKET }),
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let errors = '';
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString('utf8');
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const [code] = await once(child, 'exit');
      clearTimeout(timer);
      expect(code).toBe(1);
      expect(errors).toMatch(/EADDRINUSE|in use/);
    } finally {
      taken.close();
    }
  });
});

describe.skipIf(!panesAvailable())('brainyard web (real tmux)', () => {
  afterAll(() => {
    spawnSync('tmux', ['-L', SOCKET, 'kill-server']);
  });

  it('shows the app in a browser: a new pane, typing into it, Ctrl+Q back, q quits and the pane stays', async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/main.ts', 'web', '--port', '0', '--json', '--no-open', '--token', 'web-e2e'],
      {
        cwd: root,
        env: cliEnv({ ...machine(), BRAINYARD_TMUX_SOCKET: SOCKET, FAKE_PANE: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString('utf8');
    });
    try {
      const [line] = await once(createInterface({ input: child.stdout }), 'line');
      const { url, token } = JSON.parse(line as string) as { url: string; token: string };
      expect(token).toBe('web-e2e');
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

      const page = await fetch(`${url}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('id="screen"');

      // The frames, kept as the page keeps them.
      const frames = await fetch(`${url}/api/app/frames`, { headers });
      expect(frames.status).toBe(200);
      const reader = frames.body!.pipeThrough(new TextDecoderStream()).getReader();
      let rows: string[] = [];
      let quit = false;
      let buffer = '';
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          buffer += value;
          for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
            const data = /^data: (.*)$/m.exec(buffer.slice(0, at))?.[1];
            buffer = buffer.slice(at + 2);
            if (!data) continue;
            const event = JSON.parse(data);
            if (event.kind === 'quit') quit = true;
            if (event.kind !== 'frame') continue;
            if (event.full) rows = [];
            rows.length = event.height;
            for (const [index, text] of Object.entries(event.rows)) rows[Number(index)] = text as string;
          }
        }
      })();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: frames carry colours.
      const screen = () => rows.map((text) => (text ?? '').replace(/\u001b\[[0-9;:]*m/g, '')).join('\n');
      const until = async (wanted: string | RegExp, ms = 10_000) => {
        const end = Date.now() + ms;
        const ok = () => (typeof wanted === 'string' ? screen().includes(wanted) : wanted.test(screen()));
        while (!ok() && Date.now() < end) await new Promise((done) => setTimeout(done, 50));
        expect(screen()).toMatch(wanted);
        return screen();
      };

      expect((await post('/api/app/resize', { width: 110, height: 32 })).status).toBe(200);
      // The frame of the old size may still be on its way: the page's size comes next.
      const sized = Date.now() + 10_000;
      while (rows.length !== 32 && Date.now() < sized) await new Promise((done) => setTimeout(done, 50));
      expect(rows).toHaveLength(32);
      await until(/╭─ Panes ─+ 0 panes ─╮/);
      await until(/╭─ Claude Code ─+ ready ─╮/);

      await post('/api/app/input', { data: 'n' });
      await until('New pane in');
      await post('/api/app/input', { data: '\r' });
      const inside = await until('fake-claude ready');
      expect(inside).toContain('Ctrl+Q — back to Brainyard');
      const [pane] = await listPanes({ socket: SOCKET });
      expect(pane?.pane).toMatch(/^claude-[0-9a-f]{8}$/);
      // The pane is the page's size, but for the bar below it.
      expect(pane).toMatchObject({ width: 110, height: 31 });
      await post('/api/app/input', { data: 'hi' });
      await until('got:hi');

      await post('/api/app/input', { data: '\u0011' });
      const back = await until(/╭─ Panes ─+ 1 pane/);
      expect(back).toContain(pane!.pane);

      await post('/api/app/input', { data: 'q' });
      const [code] = await exited;
      expect(code).toBe(0);
      await pump;
      expect(quit).toBe(true);
      // The panes outlive the app, in a terminal or in a browser.
      expect((await listPanes({ socket: SOCKET })).map((info) => info.pane)).toEqual([pane!.pane]);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n--- brainyard web said:\n${errors}`);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
