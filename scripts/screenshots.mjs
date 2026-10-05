/**
 * The README's pictures of the app, taken again: the demo (`npm run demo`) in
 * headless Chrome, page by page, in English and in Russian, into docs/assets.
 *
 *   npm run screenshots
 *
 * Needs Google Chrome (CHROME=/path/to/chrome elsewhere). Keys go to the app
 * over its HTTP API, as the page sends them.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 1200;
const HEIGHT = 600;

/** Each picture: the keys that lead to it from the overview, and how long the screen takes to settle. */
const SHOTS = [
  { name: 'overview', keys: [] },
  { name: 'wall', keys: ['2'], settle: 1200 },
  { name: 'pane', keys: ['2', '\u001b[C', '\r'], settle: 1000 },
  { name: 'sessions', keys: ['3', '\u001b[B'] },
  { name: 'usage', keys: ['4'] },
  { name: 'settings', keys: ['5', '\u001b[B'] },
];

async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}

async function take(language, port) {
  const demo = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/demo.ts', '--port', String(port), ...(language === 'ru' ? ['--ru'] : [])],
    {
      cwd: root,
      stdio: 'ignore',
    },
  );
  const origin = `http://127.0.0.1:${port}`;
  const type = (data) =>
    fetch(`${origin}/api/app/input`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo', 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
    });
  const profile = mkdtempSync(join(tmpdir(), 'brainyard-shots-'));
  const debug = port + 1000;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--hide-scrollbars',
      `--remote-debugging-port=${debug}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    await until(async () => (await fetch(`${origin}/`)).ok);
    const target = await until(async () =>
      (await (await fetch(`http://127.0.0.1:${debug}/json`)).json()).find((each) => each.type === 'page'),
    );
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    let id = 0;
    const waiting = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      waiting.get(message.id)?.(message);
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        id += 1;
        waiting.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    for (const shot of SHOTS) {
      // Every picture starts from the overview, as the app opens.
      await type('\u0011');
      await type('1');
      await send('Page.navigate', { url: `${origin}/#token=demo` });
      await sleep(1500);
      for (const key of shot.keys) {
        await type(key);
        await sleep(250);
      }
      await sleep(shot.settle ?? 500);
      const { result } = await send('Page.captureScreenshot', { format: 'png' });
      const file = join(root, 'docs/assets', `app-${shot.name}${language === 'ru' ? '.ru' : ''}.png`);
      writeFileSync(file, Buffer.from(result.data, 'base64'));
      console.log(file);
    }
    socket.close();
  } finally {
    const closed = once(chrome, 'exit');
    chrome.kill();
    demo.kill();
    await closed;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

await take('en', 4848);
await take('ru', 4849);
