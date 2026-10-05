# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- OpenCode as the fourth CLI, through `opencode run --format json`: `status()`, `models()`,
  `ask()`, `start()` / `run()`, `sessions()` and `liveSessions()`, `open()` and panes.
  Permissions, MCP servers and the one-shot answer agent go in through the environment;
  nothing is written to the project or the user's config.
- `parseOpencodeModels()` and `opencodeHome()`.
- `Catalog.complete`: the CLI runs no model outside its list (OpenCode), so an unknown name is
  refused before the start.
- `ask()` with OpenCode deletes its session afterwards: OpenCode cannot be told not to keep one.
- `hint()` reaches a working OpenCode agent: such a run goes through `opencode serve` instead of
  `opencode run`, which exits before it answers a message sent mid-turn.
- `usage()` and its public report types: saved session tokens and model-aware cost
  estimates for Claude Code, Codex and Antigravity, plus persisted tokens and reported
  or estimated cost for OpenCode.
- Codex subscription windows from rollout snapshots, with duration, reset time and
  separate limit buckets; opt-in live Claude subscription windows, including rejected
  calls. Unavailable data carries a reason and is never presented as zero usage.
- Claude Code's subscription windows without a call: the ones it fetched last (its `/usage`)
  from `~/.claude.json`, with the time they were fetched; `limitsSource: 'cache'`. A cache of
  another account than the one signed in is left out. `live: true` still asks with a real call.
- Antigravity grouped subscription quotas through its structured `/usage` command
  (CLI 1.1.11+), and OpenCode Go rolling, weekly and monthly quotas through its usage
  API. Both are metadata requests without inference, with timeouts and cancellation.
  `usage({ offline: true })` reads saved stores only. `LimitWindow` includes optional
  `group` and `label` for Antigravity's model pools. `usage({ limits: false })` reads the
  sessions alone, every CLI's windows `not_requested`. A Claude Code cache of another account is
  `limitsUnavailable: 'other_account'`.
- The `brainyard` command covers the whole API: `panes` and `pane start|attach|show|send|close`
  for CLI sessions in tmux panes, `sessions --live` (`--all` adds finished background sessions)
  for what runs on the machine right now, `stop` for a Claude Code background session, and
  `usage` for subscription limits and the tokens and cost of a folder's sessions. A pane is
  named by its name or the start of its name or session id; `pane send` presses Enter as a key
  of its own, so a CLI that reads a fast burst as a paste still sends the message.
- `brainyard` in a terminal opens the app: one full screen with the agents and their
  subscription limits, the panes (what each CLI does, its memory, how long it has been quiet),
  sessions running in other folders, and the folder's sessions with their tokens and cost. Enter
  goes into a pane and Ctrl+Q comes back; `n` starts a new pane, `x` closes one, `s` stops a
  Claude Code background session, `r` continues a saved session in a pane, `q` quits and the
  panes keep running. The screen is a pure function of the app's state, so a browser can draw
  the same frames. Its pages: the wall — several panes' live screens as tiles (a grid, main and
  stack, columns, zoom), each pane sized to its tile, with typing into the tile in focus; sessions
  with a filter and a card; usage with a bar for every subscription window; settings — a theme,
  an accent, the wall's layout, the bell, the first page and the language (English, or
  Russian), kept in
  `~/.config/brainyard/app.json` with your own colours. The header counts who waits for you, and
  the terminal rings when someone starts to.
- `brainyard web`: the app in a browser on `127.0.0.1`, the same screen as in a terminal. The
  server sends the frames as server-sent events (`GET /api/app/frames`, only the rows that
  changed); keys go back as the bytes a terminal sends, clicks and the wheel by cell, and the
  page's size (`POST /api/app/input`, `/mouse`, `/resize`), under the API's token, `Host` and
  `Origin` guard. A click opens a tab, selects a row, focuses a tile or picks a setting; a double
  click is Enter; the wheel moves the selection. Enter on a pane shows its CLI full screen with
  every key going to it and the wheel scrolling through its history, until Ctrl+Q; a paste
  reaches it as one paste. `q` quits the app and the command; the panes keep running. The
  dashboard and its playground are on the same server, at `/dashboard`.
- `npm run demo`: the app on a made-up machine, in a browser or with `--terminal` in this
  terminal, and the dashboard with the same made-up CLIs; `npm run screenshots` takes the
  README's pictures of it again, page by page, in English and in Russian (with Google Chrome), and
  with `--windows` on a Mac the app in a Terminal window and in a Chrome window.
- `brainyard serve`: the HTTP API alone, with no browser. Its token can come from
  `$BRAINYARD_TOKEN`, and `--json` prints `{url, port, token}` for the program that starts it.
  The API adds `GET /api/sessions`, `GET /api/sessions/live`, `POST /api/sessions/:id/stop`,
  `POST /api/usage` and panes: list, start, screen, send, resize and close.

### Changed

- npm shows the English README, with its links and pictures pointing into the repository at the
  release's tag: the Russian one is no longer packed, as npm showed it in place of the English.

- `BrainId` and `BRAIN_IDS` include `'opencode'`. Code with an exhaustive
  `Record<BrainId, …>` needs an entry for it.
- `sessions()` leaves out headless runs that are working right now unless `headless: true`, as
  it already did with saved ones.
- A session id may contain `_` (OpenCode's ids are `ses_…`).
- `brainyard` without arguments prints the status table only without a terminal (piped, in a
  script); in a terminal it opens the app. `brainyard status` prints the table anywhere.
- A pane taken full screen from the wall gets its tile's size back afterwards; it kept the
  terminal's size.
- Keys typed into a tile just started from the wall go to it, not to the first tile, before a
  read lists the new pane; a read begun earlier no longer stops the typing.
- A paste where nothing takes text (the overview, a page) is left out instead of being read as
  shortcuts: pasting "fix query" no longer quits. In the browser, AltGr and a Mac's Option type
  their characters (`@` on a German keyboard), and one failed look at a pane does not end it.
- `brainyard web` with its port taken ends with the error instead of hanging.
- Resizing the terminal while a pane has it no longer clears tmux's screen; the app takes the
  new size on the way back.
- Claude Code's cache is read from `$CLAUDE_CONFIG_DIR/.claude.json` whenever that is set, and
  `~/.claude.json` follows `HOME` from the options' `env`. The app reads the folder's usage
  every minute without the windows, which it reads on their own.
- One accent everywhere: the app's is bright blue — Brainyard's indigo in most terminals, and in
  the browser exactly the dashboard's — no longer cyan, which also means "working".
- `brainyard serve` is no longer another name for `brainyard ui`: it opens no browser. Without
  `--port`, both take 4747 or the next free port, and both stop on `SIGTERM` as on Ctrl+C.

### Fixed

- Text selected with the mouse in a full-screen pane goes to the system clipboard (`pbcopy`,
  `wl-copy`, `xclip` or `xsel`; `BRAINYARD_COPY_COMMAND` names another), not only to tmux's own
  buffer, where nothing outside could paste it. A server started by an older version gets it on
  the next attach.
- Every CLI starts with `PWD` set to the folder it works in. A CLI that takes its folder from
  `PWD` (OpenCode) otherwise worked in the caller's folder.
- "Cannot connect to API" and "Unable to connect" are `network` failures.

## [0.1.0] - 2026-09-30

First public release.

### Added

- One API over Claude Code, Codex and Antigravity: `status()`, `ask()`, `askAll()`,
  `start()` / `run()`, `models()`, `ping()`.
- A closed list of events with human-readable summaries, secrets masked.
- Steering a working agent with `hint()` (Claude Code, Antigravity) and stopping it with
  `stop()`, an `AbortSignal` or a timeout.
- Session resume, model and effort checked against each CLI's own catalog, MCP servers per run.
- Access levels `full`, `workspace` and `readonly`, mapped to each CLI's permission and sandbox
  flags and verified with real runs.
- Typed failures: `usage_limit` with the reset time, `rate_limited`, `not_logged_in`,
  `network`, `timeout`, `stopped`, `empty_answer`, `failed`.
- The `brainyard` command: `status`, `models`, `ask`, `run`, `ui`.
- A local dashboard that looks like a terminal, with status cards and a playground, over a
  token-guarded HTTP API with server-sent events.
- Tests against fake CLIs, and `npm run live` for checks against the real ones.

[0.1.0]: https://github.com/antondanv/brainyard/releases/tag/v0.1.0
