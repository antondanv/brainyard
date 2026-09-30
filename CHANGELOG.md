# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
