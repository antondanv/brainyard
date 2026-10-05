<div align="center">

<img src="docs/assets/logo.svg" width="72" height="72" alt="">

# Brainyard

**One interface to the coding agents you already have: Claude Code, Codex, Antigravity and OpenCode.**

See which are installed and signed in, ask them one-shot questions, or run an agent in a folder
and watch a live, human-readable feed of what it does. From the terminal, from TypeScript, or
from a local dashboard.

[![CI](https://github.com/antondanv/brainyard/actions/workflows/ci.yml/badge.svg)](https://github.com/antondanv/brainyard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@antondanv/brainyard?color=6d7dfc)](https://www.npmjs.com/package/@antondanv/brainyard)
![node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-3c873a)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [Русский](README.ru.md)

<img src="docs/assets/dashboard.png" width="860" alt="The Brainyard dashboard: three status cards, and a Claude Code run that wrote fib.py, ran it and reported the output">

</div>

## Why

Claude Code, Codex, Antigravity and OpenCode are all excellent headless agents, and each speaks a
different dialect: different flags, different stream formats, different ways to resume a
session, pass an MCP server, pick an effort level or report a usage limit. Each also has quirks
that only show up in real runs: a prompt starting with `---` read as a command-line option, a
CLI that never exits because its stdin is still open, a turn that ends silently after a refused
tool.

Brainyard gives them one API. The same options, the same events and the same errors for all
of them, with the workarounds built in. It drives the CLIs you installed with your own accounts.
It runs no service, calls no model API and holds no keys.

It was extracted from a production system that runs all three CLIs every day. Most of the
behaviour below exists because a real run failed without it ([battle-tested quirks](docs/gotchas.md)).

## Features

- **Status in one command.** Installed? Which version? Signed in, and how? Which models and
  reasoning efforts? All of it free where the CLI allows. `--live` proves each CLI with a
  one-word call; for Claude Code it also shows how much of your 5-hour and 7-day windows is used.
- **`ask()`.** One prompt, one answer, isolated from your project: no `CLAUDE.md`, hooks or
  MCP servers leaking into the prompt.
- **`start()` / `run()`.** An agent in a folder, streaming one closed list of events
  (`message`, `command`, `file_write`, `tool_call`…) with a human-readable line for each.
- **Steering.** `hint()` sends a message to an agent while it works (Claude Code,
  Antigravity, OpenCode). `stop()` stops it and everything it started.
- **Sessions.** Every run returns a `sessionId`; pass it as `resume` to continue.
- **Models and effort.** Asked from each CLI itself and checked before a run: Claude Code
  silently ignores an effort it does not know, so you would pay for something you did not pick.
- **Access levels.** `full`, `workspace` and `readonly`, mapped to each CLI's own permission and
  sandbox flags. Verified live, including "nothing outside the folder gets written".
- **MCP servers per run.** One config shape, delivered the way each CLI needs it, with no
  global config touched.
- **Typed failures.** `usage_limit` (with the reset time), `rate_limited`, `not_logged_in`,
  `network`… so you know whether to wait a minute, wait until 6:50pm or sign in.
- **One app.** `brainyard` opens a full-screen app in the terminal: agents and their limits,
  panes, sessions and usage. Enter takes you into a pane, Ctrl+Q brings you back. `brainyard web`
  shows the same app in a browser.
- **Dashboard.** `brainyard ui` opens status cards and a playground over a local, token-guarded
  HTTP API that other languages can use too.
- **No runtime dependencies.**

## Install

```sh
npm install -g @antondanv/brainyard-cli    # the `brainyard` command and the dashboard
npm install @antondanv/brainyard           # the library alone
```

You need Node.js 22+ and at least one agent CLI:

| CLI | Install | Sign in |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | run `claude` once |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | run `agy` once |
| OpenCode | `npm install -g opencode-ai` | `opencode auth login` for a provider (its free models need none) |

## Command line

**The app.** `brainyard` in a terminal is one full-screen app: a card for each agent with its
subscription limits as bars (Claude Code's are the ones its own `/usage` fetched last); the
panes with what each CLI does, its memory and how long it has been quiet; sessions running in
other folders; and this folder's sessions with their tokens and cost. It keeps reading them
while it is open and makes no paid call of its own. It speaks English or Russian (Settings).

```console
$ brainyard
Brainyard 0.2.0  [1 Overview]  2 Wall   3 Sessions   4 Usage   5 Settings      ⚠ 1 waiting · 2 panes
╭─ Claude Code ────────────────────────── ready ─╮╭─ Codex ──────────────────────────────── ready ─╮
│ 2.1.280  claude.ai · max                       ││ 0.153.4  ChatGPT                               │
│ 5h       ███████████████████▊░░░░░░░░░░░░  62% ││ 5h       ██████████▉░░░░░░░░░░░░░░░░░░░░░  34% │
│ weekly   ████████████████████████████████ 100% ││ weekly   █████████████████████████████▍░░  92% │
╰────────────────────────────────── seen 7h ago ─╯╰────────────────────────────────── seen 3h ago ─╯
╭─ Antigravity ────────────────────────── ready ─╮╭─ OpenCode ───────────────────── not installed ─╮
│ 1.2.13  signed in                              ││ —  npm install -g opencode-ai                  │
│ Gemini   ▎░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   1% ││                                                │
│ Claude   ████████████▊░░░░░░░░░░░░░░░░░░░  40% ││                                                │
╰────────────────────────────────────────────────╯╰────────────────────────────────────────────────╯
╭─ Panes ─────────────────────────────────────────────────────────────────────── 2 panes · 405 MB ─╮
│ ▌ ● auth refactor                      Claude Code  working                      active   285 MB │
│   ● (no label) · ~/code/other          Codex        waiting: approval         quiet 12m   120 MB │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ Running in other folders ─────────────────────────────────────────────────────────────────── 1 ─╮
│   ● Nightly cleanup bg · ~/code/other                  Claude Code      3m  working              │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ Sessions · ~/code/app ──────────────────────────────────────── 3 sessions · $4.23 · 31M tokens ─╮
│   ● Auth refactor                   Claude Code     now  ▣ claude-1a2b3c4d        31M      $4.21 │
│   ○ Fix the flaky test              Claude Code      3h                          1.1k      $0.02 │
│   ○ Explain CRDTs                   Codex            2d                           15k   no price │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
 Enter go in (Ctrl+Q back) · x close · n new · ? help · q quit
```

Enter goes into the selected pane, full screen, and Ctrl+Q comes back; on an agent Enter starts
a new pane of it, on a saved session it continues the session in a pane. `n` starts a new pane
in this folder (choose the CLI), `x` closes a pane (what was said in it stays), `s` stops a
Claude Code background session, `r` continues a saved session, Tab jumps between sections, `?`
lists the keys and `q` quits; the panes keep running. Russian keyboard letters work by their
place on the keyboard.

Digits 1–5 (or `[` `]`) open its pages:

- **Wall** — the live screens of several panes side by side, the way a tiling compositor shows
  windows: a grid, one main tile and a stack, or columns (`l`). Arrows move the focus, `z` zooms
  the tile, `i` types into it (every key, Ctrl+C included, goes to its CLI until Ctrl+Q), Enter
  takes it full screen and `n` starts a new tile to type into. Each pane is made the size of its
  tile. A tile turns yellow while its agent waits for you; the header counts who waits, and the
  terminal rings when someone starts to.
- **Sessions** — what runs elsewhere and this folder's sessions; `/` filters; a card with the
  tokens by model and the command that continues the session in its own CLI.
- **Usage** — every subscription window as a bar, the folder's tokens and cost by CLI, and the
  sessions that used the most.
- **Settings** — the language (English, the default, or Russian), the theme (terminal, ocean,
  ember, forest, contrast, mono), the accent, the wall's layout, the bell and the page to open
  on, kept in `~/.config/brainyard/app.json`; `"colors"` there takes your own
  (`"accent": "#ff8700"`, or a number of the 256).

```console
Brainyard 0.2.0   1 Overview  [2 Wall]  3 Sessions   4 Usage   5 Settings      ⚠ 1 waiting · 2 panes
╭─ Codex ─────────── waiting: approval · 120 MB ─╮╭─ Claude Code · auth refac… ─ working · 285 MB ─╮
│Allow command? [y/n]                            ││Editing src/auth.ts…                            │
│                                                ││                                                │
╰─ i type · Enter full screen ─── codex-5e6f7a8b ─╯╰─ active ───────────────────── claude-1a2b3c4d ─╯
 ←→↑↓ focus · i type · Enter full screen · z zoom · l grid · x close · n new · ? help · q quit
```

The app leaves the mouse to the terminal, so selecting and copying text works anywhere on it.

**In a browser.** `brainyard web` shows the same app in a browser on this machine: the server
draws the frames a terminal would show and the page paints them cell for cell — the pages, the
wall, the dialogs, the theme and the language are the same. Keys work as in the terminal. A
click opens a tab, selects a row, focuses a tile or picks a setting; a double click is Enter; the
wheel moves the selection; dragging selects text to copy. Enter on a pane shows its CLI full
screen, with every key going to it and the wheel scrolling back through what it printed, until
Ctrl+Q or a click on the bar below. `q` quits the app and the command with it; the panes keep
running. The page listens on `127.0.0.1` behind the same token, `Host` and `Origin` guard as the
[HTTP API](docs/http-api.md), which stays under `/api/`.

<img src="docs/assets/web-wall.png" width="860" alt="brainyard web: the wall in a browser — a Codex pane waiting for an approval and a Claude Code pane at work, side by side">

**Status.** Piped or in a script, `brainyard` prints this table, as `brainyard status` does:

```console
$ brainyard status
Brainyard 0.1.0

  ● Claude Code  2.1.280   ready         signed in with claude.ai, pro
  ● Codex        0.153.4   ready         signed in with ChatGPT · default model gpt-6-astra
  ● Antigravity  1.2.13    ready         signed in · model list fetched with your account
  ● OpenCode     1.18.34   ready         signed in with opencode, sber · default model sber/GigaChat-3-Pro

  4 of 4 ready · 3.6s · prove each with a real call: brainyard status --live
```

**Ask.** The answer goes to stdout and the details to stderr, so pipes work as they look:

```console
$ git diff | brainyard ask claude --model haiku "Review this diff in three bullets"
$ brainyard ask codex --effort high "Explain CRDTs in two sentences" > crdt.md
$ brainyard ask all "In one short sentence: what is a monad?"
── Claude Code claude-opus-5-5 · 4.8s · $0.0079
A monad is a type that wraps values in a context, like optionality, lists, I/O, or state, …

── Codex gpt-6-astra · 9.1s
A monad is a programming abstraction that chains computations while managing context, …

── Antigravity 13.9s
A monad is a design pattern that wraps values in a computational context and enables …
```

**Run an agent.** The feed streams to stderr. While it works, type a message and press Enter
to steer it; Ctrl+C stops it and keeps whatever it already wrote.

```console
$ brainyard run claude --model haiku --cwd ./sandbox "Write fib.py, run it, tell me the output"
Claude Code is working · type a message + Enter to steer, Ctrl+C to stop
00:01 ◆ Claude Code started · claude-haiku-4-5-20251001
00:05 › I'll create a Fibonacci script and run it for you.
00:06 ✎ wrote fib.py
00:09 $ ran: python3 fib.py
00:11 › Done! The output is: 0 1 1 2 3 5 8 13 21 34
00:11 ✓ done in 11.6s · 2 actions · $0.0306

session 32a4caae-… · continue: brainyard run claude --resume 32a4caae-… "…"
```

`--json` prints every event as a JSON line; `--quiet` prints only the answer. Like `codex exec`,
`ask` and `run` read piped stdin and append it to the prompt; that waits for end of input, so a
script that leaves stdin open should pass `--no-stdin`.

**Sessions and panes.** `sessions --live` shows what runs on the machine right now, in every
CLI, and what it waits for. A pane is a CLI session in tmux that outlives the terminal: start
it, read its screen, type into it, take it full screen and close it; the conversation stays
resumable. A pane is named by its name or the start of its name or session id. Text selected
with the mouse in a full-screen pane goes to the system clipboard (`pbcopy`, `wl-copy`, `xclip`
or `xsel`; `BRAINYARD_COPY_COMMAND` names another).

```console
$ brainyard sessions --live
Claude Code  2dcf2506  24m      ~/Projects/Brainyard  CLI for the whole API ● working ▣ claude-a6d7c603
Claude Code  381a87e4  21h      ~/Projects/Treeyard   GitHub issues in the tree bg ● blocked

$ pane=$(brainyard pane start claude --name "release notes" "Draft the 0.2 release notes")
$ brainyard pane send $pane "Shorter, please"   # the text, then Enter as a key of its own
$ brainyard pane show $pane                     # its screen as text
$ brainyard pane attach $pane                   # full screen; Ctrl+Q — back, it keeps running
$ brainyard pane close $pane
closed claude-1a2b3c4d · resume: brainyard pane start claude --resume 7c919bf9-…
```

**Usage.** What each subscription has left, and what the folder's sessions used. No model is
called unless you pass `--live`; `--prices` turns tokens into dollars.

```console
$ brainyard usage
Subscription limits
  Claude Code  5h reset since seen   weekly 100% · resets in 1d 12h   seen 7h ago
  Codex        5h 52% · resets in 2h 36m   weekly 32% · resets in 5d 11h   seen 35m ago
  Antigravity  Gemini Models: weekly 1% · resets in 3d 21h   5h 0% · resets in 1h 27m
               Claude and GPT models: weekly 4% · resets in 3d 21h   5h 2% · resets in 2h 50m
  OpenCode     Connect OpenCode Go in OpenCode or provide OPENCODE_API_KEY to read subscription usage.

Sessions of ~/Projects/Brainyard
                                                     input  output  cache  reasoning      cost
  Claude Code  2dcf2506  now  CLI for the whole API    226    207k    31M       117k  no price
  Codex        01a10742  35m  Usage in the API        825k    122k    17M        58k  no price
  total                       2 sessions              825k    329k    48M       175k            + 2 without a price
```

| Command | What it does |
|---|---|
| `brainyard` | The app, full screen: agents and their limits, panes, sessions, usage; piped — the status |
| `brainyard status` | Which CLIs are installed, signed in and ready (`--live`, `--models`, `--json`) |
| `brainyard models [brain…]` | Models and efforts each CLI offers |
| `brainyard ask <brain\|all> <prompt>` | One prompt, one answer (`--model`, `--effort`, `--system`, `--web`) |
| `brainyard run <brain> <prompt>` | An agent with a live feed (`--cwd`, `--resume`, `--access`, `--mcp`, `--no-web`, `--json`) |
| `brainyard sessions [brain…]` | Sessions of this folder, running ones marked; `--live` — what runs on the machine now (`--all`, `--cwd`, `--json`) |
| `brainyard stop <session>` | Stops a Claude Code background session; its conversation stays |
| `brainyard open <brain> [prompt]` | A CLI here, as a session you come back to (`--resume`, `--name`, `--bg`) |
| `brainyard panes` | Live panes: CLI, session, memory, quiet time, folder (`--json`) |
| `brainyard pane start\|attach\|show\|send\|close` | A CLI session in a tmux pane that outlives the terminal |
| `brainyard usage [brain…]` | Subscription limits; tokens and cost of this folder's sessions (`--limits`, `--prices`, `--offline`, `--live`) |
| `brainyard web` | The app in a browser, on `http://127.0.0.1:4747` (`--port`, `--no-open`) |
| `brainyard ui` | The dashboard on `http://127.0.0.1:4747` |
| `brainyard serve` | The HTTP API alone, for scripts in any language (`--json`, `$BRAINYARD_TOKEN`) |

Brains are `claude`, `codex`, `antigravity` (alias `agy`) and `opencode`. `brainyard help` lists every flag.

## Library

```ts
import { ask, run, start, status } from '@antondanv/brainyard';

// Who is ready? Free checks; `live: true` adds a one-word call to each.
const { ready } = await status(); // ['claude', 'codex', 'antigravity', 'opencode']

// One prompt, one answer.
const { text, costUsd } = await ask('codex', 'One-line summary of RFC 9110?', { effort: 'low' });

// An agent in a folder, event by event.
const agent = start({
  brain: 'claude',
  cwd: './app',
  prompt: 'Add a unit test for src/math.ts and make it pass',
  access: 'workspace', // edits and commands inside ./app only
});

for await (const event of agent) {
  if (event.feed) console.log(event.summary); // "wrote test/math.test.ts", "ran: npm test", …
  if (event.kind === 'command' && event.summary.includes('npm test')) {
    agent.hint('Use vitest, not jest.'); // reaches the agent while it works
  }
}

const result = await agent.result;
if (!result.ok) console.error(result.error); // { kind: 'usage_limit', resetsAt: '6:50pm', … }

// Continue the same conversation later.
await run({ brain: 'claude', cwd: './app', resume: result.sessionId, prompt: 'Now add a benchmark' });
```

MCP servers for one run:

```ts
await run({
  brain: 'codex',
  prompt: 'Which markdown file in the docs is the longest? Summarise it.',
  mcpServers: {
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'] },
  },
});
```

`result` rejects only when the run never started (bad options, CLI not installed). Once the CLI
has started, it resolves: check `result.ok`. `ask()` throws a `BrainyardError` with a `kind` on
any failure. More in [`examples/`](examples).

### Saved background sessions

`stopSession({ brain: 'claude', sessionId, cwd })` stops a saved Claude Code
background session with `claude stop`. It refreshes the session's short id and
checks its folder first. The conversation stays in Claude Code's history and can
be opened again with `open({ brain: 'claude', resume: sessionId, cwd })`.
It returns `stopped` or `not-running`; a CLI failure throws `BrainyardError`.
Sessions in tmux panes use `closePane()` instead.

### Live session status

`liveSessions()` reads the current turn from each CLI. Codex rollouts are replayed
once and then read incrementally, so long turns retain their state. Pending
questions and approvals stop waiting when their matching response arrives.
Completed or interrupted Codex turns leave the live list.

Recent Codex versions omit native command approvals from their rollout. Pass
`liveSessions({ panes: {} })` to check current Codex dialogs on Brainyard's tmux
server as well, or supply `panes: { socket }` for a separate server. Only the
current viewport is read. Outside these panes, approval visibility depends on
what the CLI persists in its rollout.

### Subscription limits and saved session usage

```ts
import { usage } from '@antondanv/brainyard';

const report = await usage({ cwd: './app', prices }); // your dollars-per-million model prices
for (const session of report.sessions) {
  console.log(session.brain, session.id, session.usage, session.costUsd, session.costSource);
}
for (const brain of report.brains) {
  console.log(brain.brain, brain.limits, brain.limitsObservedAt, brain.detail);
}

const one = await usage({ cwd: './app', brains: ['codex'], sessionId, prices });
const subscriptions = await usage({ brains: ['antigravity', 'opencode'], limit: 0 });
const saved = await usage({ cwd: './app', offline: true, prices }); // stores only
const limits = await usage({ brains: ['claude'], live: true, limit: 0 });
```

`usage()` reads saved sessions of `cwd` (the current folder by default), across
Claude Code, Codex, Antigravity and OpenCode. Like `sessions()`, it excludes headless
runs unless `headless: true`, returns at most 200 per CLI, and accepts store overrides
in `homes`. `sessionId` selects a specific session in that folder; `limit: 0` reads only
account limits. OpenCode's store is `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`.

| CLI | Saved session tokens and cost | Subscription limits |
|---|---|---|
| Claude Code | Whole transcript, counted once per message id; estimate from `prices` | What Claude Code itself fetched last (its `/usage`), kept in `~/.claude.json`; `rate_limit_event` with `live: true` |
| Codex | Last cumulative rollout total; cost by each turn's model | Freshest rollout snapshots across the account's store |
| Antigravity | Generation metadata in `conversations/<id>.db`; estimate from `prices` | `agy -p /usage --output-format json`: weekly and five-hour quotas by model group |
| OpenCode | Assistant messages in `opencode.db`, or retained session totals; reported positive cost or estimate from `prices` | OpenCode Go API: rolling, weekly and monthly subscription windows |

Limits use fractional `utilization` (`0.95` means 95%), optional `windowMinutes`,
Unix-second `resetsAt`, and `limitId` for separate quota buckets. Antigravity also
provides `group` and `label`, and so do Claude Code's per-model weekly windows. Their
source (`rollout`, `live`, `cli`, `api` or `cache`) and
observation time accompany the snapshot; an old snapshot is not a live check.
Limits apply to the account and are independent of the requested folder or session.

By default, Antigravity and OpenCode Go fetch subscription metadata without a model
turn. Antigravity needs a signed-in CLI version 1.1.11 or later and runs `/usage` in
a private empty directory. `homes.antigravity` selects saved conversations; quotas
belong to the active CLI login. OpenCode Go uses `OPENCODE_GO_API_KEY` or
`OPENCODE_API_KEY`, then API keys for `opencode-go`/`opencode` in its `auth.json`
(or `OPENCODE_AUTH_CONTENT`). Provider `options.apiKey` from global, explicit,
project or inline OpenCode config can override the stored key; `{env:NAME}` is
supported. A missing key or Go subscription returns an explanation. `offline: true`
skips both metadata requests and reads saved stores only; it cannot be combined with
`live: true`.

Claude Code keeps the windows it fetched last (when its `/usage` shows them) in its
global file, `~/.claude.json`, or `.claude.json` inside `CLAUDE_CONFIG_DIR`: `usage()`
reads them there for free, with the time they were fetched, and leaves a cache of
another account out. A window whose reset time has passed since then says nothing
about now.

`live: true` makes one isolated, minimal Claude call with a 30-second timeout by
default and can incur a charge. It keeps stored conversations intact. An unsuccessful
call can still return windows alongside `error`. `commands`, `env`, `timeoutMs` and
`signal` control CLI quota checks; `env`, `timeoutMs` and `signal` also control the Go
request. Default timeouts are 30 seconds for Claude and Antigravity, 10 seconds for
Go. Without `live`, no inference call is made.

`usage` and `limits` are `null` when unavailable, with `unavailableReason` or
`limitsUnavailable`/`detail` explaining why. Older Antigravity conversations without
readable generator metadata remain unknown. `byModel` splits each session's counters
and costs. Pass `prices` as in `run()`; OpenCode model keys are `provider/model`.
If any part cannot be priced, the total cost is `null`. OpenCode providers without
catalog prices can record a zero cost, so a zero alongside nonzero tokens also needs
`prices`. Estimates describe model usage; they do not measure subscription payments.

### Options

| Option | Default | |
|---|---|---|
| `brain` | | `claude`, `codex`, `antigravity` or `opencode` |
| `prompt` | | Sent on stdin, never as an argument |
| `cwd` | `process.cwd()` | Where the agent works (`ask()`: a fresh temporary folder) |
| `model`, `effort` | the CLI's | Checked against the CLI's catalog before the run |
| `resume` | | A `sessionId` from an earlier result |
| `access` | `full` (`ask()`: `readonly`) | See below |
| `web`, `shell` | `true` (`ask()`: no web) | Switches, where the CLI has them |
| `mcpServers` | | `{ name: { command, args?, env? } }` |
| `steerable` | where supported | Keep stdin open for `hint()` |
| `nudge` | `true` | A turn that ends without text gets one follow-up in the same conversation |
| `timeoutMs` | none | A run killed halfway is paid for in full, so there is no default limit |
| `signal`, `onEvent`, `env`, `extraArgs`, `command`, `prices`, `includeRaw` | | |

### Access levels

A headless agent has nobody to ask for permission, so a tool that needs approval is simply
refused. Pick the level up front:

| `access` | Claude Code | Codex | Antigravity | OpenCode |
|---|---|---|---|---|
| `full` | every tool, no prompts | every tool, no sandbox | every tool, no prompts | every tool; `--auto` approves paths outside `cwd` |
| `workspace` | edits and commands in its sandbox, confined to `cwd` | `workspace-write` sandbox | edits; its sandbox refuses most commands | edits inside `cwd`; no shell, since it has no sandbox |
| `readonly` | reads and searches only | `read-only` sandbox | plan mode: writes refused | edits and shell refused |

Checked with real runs on every CLI: in `workspace`, a file inside `cwd` gets written and a
write to the home directory fails. In `readonly`, nothing gets written. See
[`scripts/live-check.ts`](scripts/live-check.ts).

### Events

Every CLI's stream becomes the same closed list. Each event has a `summary`: one line for
humans, with paths shortened and secrets masked. `feed: false` marks ceremony that is true but
not news (a reasoning block, a successful tool result).

| kind | |
|---|---|
| `init` | The CLI started: model, session id |
| `message` / `thinking` | The agent said something / reasoned |
| `tool_call` / `command` / `file_write` | The agent did something |
| `tool_result` | What a tool returned (in the feed only when it failed) |
| `hint` | Your message reached the agent |
| `denied` | The CLI refused a tool |
| `warning` | An option this CLI cannot enforce, a failed MCP server, a usage window near its limit |
| `error` / `stopped` | Something broke / the run was stopped |
| `done` | Always last |

### What each CLI can do

| | Claude Code | Codex | Antigravity | OpenCode |
|---|:-:|:-:|:-:|:-:|
| Messages while it works (`hint`) | ✓ | — | ✓ | ✓ through its server |
| Resume a session | ✓ | ✓ | ✓ | ✓ |
| MCP servers per run | ✓ | ✓ | ✓ | ✓ |
| Reports dollar cost | ✓ | tokens only | tokens only | ✓ where the provider has prices |
| Lists its models | aliases | ✓ | ✓ | ✓ |
| Web can be switched off | ✓ | ✓ | — (warns) | ✓ |
| Shell can be switched off | ✓ | sandboxed instead | — (warns) | ✓ |
| Subscription windows (`usage`) | live call | rollout snapshots | `/usage` command | Go API |

An option a CLI cannot honour is never dropped silently: it comes back as a `warning` event and
in `result.warnings`.

## Dashboard and HTTP API

`brainyard ui` serves the dashboard shown at the top: status cards and a playground to ask
questions or run agents with a live feed, hints, stop and "continue this session". **Live
check** sends each CLI a one-word prompt and shows how much of Claude Code's subscription
windows is used, or why a CLI did not answer:

<img src="docs/assets/live-check.png" width="860" alt="Live check: Claude Code and Antigravity answered pong, Codex shows the error for a model its ChatGPT account cannot use; Claude Code also shows its 5-hour and 7-day subscription windows">

The dashboard uses a small HTTP API you can call from any language; `brainyard serve` runs it
alone, with no browser. Besides asks and runs, it lists sessions, stops background ones, reports
usage and drives panes: [`docs/http-api.md`](docs/http-api.md).

The API can start agents on your machine, so it is guarded like it: it listens on `127.0.0.1`,
every call needs the token printed at start, the `Host` header must name the server (against
DNS rebinding), and writes are accepted only as same-origin JSON.

## Battle-tested quirks

A few of the things Brainyard handles so you don't have to. The full list, with symptoms and
fixes, is in [`docs/gotchas.md`](docs/gotchas.md).

- **Prompts never go on the command line.** Claude Code's `-p` is a boolean flag, so a prompt
  starting with `---` becomes `error: unknown option`. Every CLI gets the prompt on stdin.
- **stdin is closed exactly when the turn ends.** With stream-json input the CLI treats stdin
  as a conversation and waits for the next message forever. The finished work would hang until
  killed.
- **Claude Code folds a mid-turn message into the running turn; Antigravity queues it as a new
  turn with its own result.** Closing stdin at the wrong result loses the hint.
- **Exit code 0 is not success.** Antigravity used to end print mode after five minutes with
  exit code 0 in the middle of work. No final result means a cut-off turn.
- **A silent turn gets one follow-up, in the same conversation.** Antigravity ends a turn
  without a word after a refused tool. A new process would not remember what it tripped over.
- **A usage limit is not a 429.** One is retried in seconds, the other resets in hours, and
  the CLI says when. Brainyard keeps that time for you.
- **OpenCode has no final event, and a refused tool ends its turn without a word.** The reason
  the last step finished tells a finished turn from a cut-off one, and Brainyard has the agent
  hear a refusal out and answer.

## How it is tested

- **237 tests** run the real code against fake `claude`, `codex`, `agy` and `opencode`
  executables that speak each dialect. Like the real CLIs, the fakes never exit while stdin is open, so a runner
  that forgets to close it hangs the test instead of passing it.
- **`npm run live`** runs every check against the real CLIs with the cheapest models: ask, a
  prompt starting with dashes, an agent run, a hint, resume, MCP, and the access matrix. Last
  run: Claude Code 2.1.280, Codex 0.153.4, Antigravity 1.2.13, all 21 checks passed for about $0.20.
  OpenCode 1.18.34 passed all 7 on GigaChat 3 Pro and on the free `opencode/big-pickle`
  (`BRAINYARD_LIVE_OPENCODE_MODEL` picks the model).

## FAQ

**Does it call model APIs or need API keys?** No. It runs the CLIs you installed, signed in with
your own subscriptions or keys. Nothing leaves your machine that the CLI would not send anyway.

**Is `full` access dangerous?** It is what `--dangerously-skip-permissions` is in Claude Code:
the agent can run any command. Use `workspace` or `readonly` for untrusted prompts, or run
inside a container.

**Why no default timeout?** A run killed halfway is paid for in full and returns nothing. Set
`timeoutMs` when you want a limit; `stop()` and an `AbortSignal` always work.

**Windows?** Not tested yet. Batch shims (`claude.cmd`) are handled, but the CI runs on Linux
and macOS.

**What about Gemini CLI or Cursor?** Not yet. Adding a CLI means an adapter plus a live check,
and a CLI goes in once it passes one. OpenCode went in that way.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports that include `brainyard status --json` and
the CLI version help most.

## License

[MIT](LICENSE)
