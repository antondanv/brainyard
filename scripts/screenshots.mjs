/**
 * The README's pictures, taken again from the demo (`npm run demo`) into
 * docs/assets: the app's pages in headless Chrome, in English and in Russian,
 * and the dashboard.
 *
 *   npm run screenshots
 *   npm run screenshots -- --windows   # on a Mac also the app in a Terminal and in a Chrome window
 *
 * Needs Google Chrome (CHROME=/path/to/chrome elsewhere). Keys go to the app
 * over its HTTP API, as the page sends them. --windows opens each window on
 * screen for a few seconds; screencapture needs the screen recording permission.
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = join(root, 'docs/assets');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 1200;
const HEIGHT = 600;
const inWindows = process.argv.includes('--windows');

/** Each picture: the keys that lead to it from the overview, and how long the screen takes to settle. */
const SHOTS = [
  { name: 'wall', keys: ['2'], settle: 1200 },
  { name: 'pane', keys: ['2', '\u001b[C', '\r'], settle: 1000 },
  { name: 'sessions', keys: ['3', '\u001b[B'] },
  { name: 'usage', keys: ['4'] },
  { name: 'settings', keys: ['5', '\u001b[B'] },
];

const file = (name, language) => join(assets, `${name}${language === 'ru' ? '.ru' : ''}.png`);

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

/** The demo in a browser on this port; resolves once it answers. */
async function demo(language, port) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/demo.ts', '--port', String(port), ...(language === 'ru' ? ['--ru'] : [])],
    { cwd: root, stdio: 'ignore' },
  );
  const origin = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(`${origin}/`)).ok);
  const type = (data) =>
    fetch(`${origin}/api/app/input`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo', 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
    });
  return { origin, type, stop: () => child.kill() };
}

/** Headless Chrome on a DevTools socket. */
async function headless(port) {
  const profile = mkdtempSync(join(tmpdir(), 'brainyard-shots-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const target = await until(async () =>
    (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((each) => each.type === 'page'),
  );
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const waiting = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const size = (width, height) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  const shoot = async (path) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(data, 'base64'));
    console.log(path);
  };
  const close = async () => {
    socket.close();
    const closed = once(chrome, 'exit');
    chrome.kill();
    await closed;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  return { send, size, shoot, close };
}

/** The app's pages, and in English the dashboard (it has no other language). */
async function pages(language, port) {
  const app = await demo(language, port);
  const chrome = await headless(port + 1000);
  try {
    await chrome.size(WIDTH, HEIGHT);
    for (const shot of SHOTS) {
      // Every picture starts from the overview, as the app opens.
      await app.type('\u0011');
      await app.type('1');
      await chrome.send('Page.navigate', { url: `${app.origin}/#token=demo` });
      await sleep(1500);
      for (const key of shot.keys) {
        await app.type(key);
        await sleep(250);
      }
      await sleep(shot.settle ?? 500);
      await chrome.shoot(file(`app-${shot.name}`, language));
    }
    if (language === 'en') {
      await chrome.size(1160, HEIGHT);
      await chrome.send('Page.navigate', { url: `${app.origin}/dashboard#token=demo` });
      await sleep(1500);
      await chrome.send('Runtime.evaluate', {
        expression: `document.getElementById('prompt').value = 'Add a unit test for src/math.ts and make it pass'`,
      });
      const { result } = await chrome.send('Runtime.evaluate', {
        expression: 'document.documentElement.scrollHeight',
      });
      await chrome.size(1160, result.value);
      await sleep(300);
      await chrome.shoot(file('dashboard', language));
    }
  } finally {
    await chrome.close();
    app.stop();
  }
}

/** On-screen windows that pass the test (JavaScript of `w`), as the window server lists them. */
function windowsWhere(test) {
  const script = `ObjC.import('CoreGraphics');
JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)))
  .filter((w) => w.kCGWindowLayer === 0 && ${test})
  .map((w) => ({ id: w.kCGWindowNumber, name: w.kCGWindowName, area: w.kCGWindowBounds.Width * w.kCGWindowBounds.Height })))`;
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }));
}

/** One window, without its shadow. Without the permission the window server hides other apps' titles. */
function capture(window, path) {
  if (!window.name) {
    throw new Error('screencapture cannot see the window: allow screen recording for this terminal in System Settings');
  }
  execFileSync('screencapture', ['-o', '-x', `-l${window.id}`, path]);
  console.log(path);
}

const osascript = (script) => execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();

/**
 * The app in a Terminal window: the demo bundled into one file and run as
 * `node brainyard`, so the title names what `brainyard` would.
 */
async function terminalWindow(language) {
  const dir = mkdtempSync(join(tmpdir(), 'brainyard-terminal-'));
  try {
    mkdirSync(join(dir, 'app'));
    const { version } = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
    // The bundle reads its version from ../package.json, as the CLI does.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', version }));
    const args = JSON.stringify(['--terminal', ...(language === 'ru' ? ['--ru'] : [])]);
    execFileSync(
      join(root, 'node_modules/.bin/esbuild'),
      [
        '--bundle',
        '--platform=node',
        '--format=esm',
        `--tsconfig=${join(root, 'tsconfig.json')}`,
        `--outfile=${join(dir, 'app/brainyard')}`,
        '--log-level=warning',
      ],
      { cwd: root, input: `process.argv.push(...${args});\nawait import('./scripts/demo.ts');\n` },
    );
    // The shell titles the window with the command it runs; this one is `brainyard`.
    const command = `cd '${join(dir, 'app')}' && printf '\\\\033]0;brainyard\\\\007' && clear && exec node brainyard`;
    const id = osascript(`tell application "Terminal"
  set t to do script "${command}"
  delay 0.5
  set w to first window whose selected tab is t
  set number of columns of t to 132
  set number of rows of t to 36
  set index of w to 1
  activate
  return id of w
end tell`);
    try {
      await sleep(3500);
      // Whatever had the focus before may have taken it back: the window is in front, as in use.
      osascript(`tell application "Terminal"
  activate
  set index of (first window whose id is ${id}) to 1
end tell`);
      await sleep(700);
      const [window] = windowsWhere(`w.kCGWindowNumber === ${id}`);
      if (!window) throw new Error('the Terminal window is not on screen');
      capture(window, file('app-terminal', language));
    } finally {
      osascript(`tell application "Terminal" to do script "q" in (selected tab of (first window whose id is ${id}))`);
      await sleep(1500);
      osascript(`tell application "Terminal" to close (first window whose id is ${id})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The app in a Chrome window of its own profile, at the address `brainyard web` opens. */
async function browserWindow(language) {
  const app = await demo(language, 4747);
  const profile = mkdtempSync(join(tmpdir(), 'brainyard-window-'));
  mkdirSync(join(profile, 'Default'));
  writeFileSync(
    join(profile, 'Default/Preferences'),
    JSON.stringify({ browser: { has_seen_welcome_page: true }, translate: { enabled: false } }),
  );
  const debug = 5747;
  const chrome = spawn(
    CHROME,
    [
      // Chrome on a Mac takes its language from Cocoa's argument, not from --lang.
      '-AppleLanguages',
      `(${language === 'ru' ? 'ru' : 'en-US'})`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debug}`,
      '--no-first-run',
      '--no-default-browser-check',
      // No offer to translate and no "Sign in to Chrome?" pill: only the page.
      '--disable-features=Translate,SigninPromoOnAvatarPill',
      '--window-size=1400,820',
      '--window-position=30,40',
      '--new-window',
      `${app.origin}/#token=demo`,
    ],
    { stdio: 'ignore' },
  );
  try {
    // Chrome also opens the Cocoa argument as an address: every tab but the app's goes.
    const tabs = await until(async () => {
      const list = (await (await fetch(`http://127.0.0.1:${debug}/json`)).json()).filter(
        (each) => each.type === 'page',
      );
      return list.some((each) => each.url.startsWith(app.origin)) && list;
    });
    for (const tab of tabs) {
      if (!tab.url.startsWith(app.origin)) await fetch(`http://127.0.0.1:${debug}/json/close/${tab.id}`);
    }
    await sleep(4000);
    const [window] = windowsWhere(`w.kCGWindowOwnerPID === ${chrome.pid}`).sort((a, b) => b.area - a.area);
    if (!window) throw new Error('the Chrome window is not on screen');
    capture(window, file('app-browser', language));
  } finally {
    const closed = once(chrome, 'exit');
    chrome.kill();
    await closed;
    app.stop();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

await pages('en', 4848);
await pages('ru', 4849);
if (inWindows) {
  if (process.platform !== 'darwin') throw new Error('--windows takes the pictures with macOS screencapture');
  for (const language of ['en', 'ru']) {
    await terminalWindow(language);
    await browserWindow(language);
  }
}
