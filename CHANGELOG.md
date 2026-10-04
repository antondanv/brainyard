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

### Changed

- `BrainId` and `BRAIN_IDS` include `'opencode'`. Code with an exhaustive
  `Record<BrainId, …>` needs an entry for it.
- `sessions()` leaves out headless runs that are working right now unless `headless: true`, as
  it already did with saved ones.
- A session id may contain `_` (OpenCode's ids are `ses_…`).

### Fixed

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
