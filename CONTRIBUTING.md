# Contributing

Thanks for helping. Bug reports, fixes and support for more CLI versions are all welcome.

## Setup

```sh
git clone https://github.com/antondanv/brainyard.git
cd brainyard
npm ci
npm test
```

Node.js 22 or newer. The tests need no agent CLI: they run against fakes.

| Script | |
|---|---|
| `npm test` | Unit and integration tests (Vitest) |
| `npm run lint` / `npm run format` | Biome |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` | `dist/`, plus the dashboard page |
| `npm run dev -- status` | The CLI from source |
| `npm run live` | Checks against the real CLIs on your machine. **Spends real money**, a few cents |

## Layout

```text
src/
  brains/        one adapter per CLI: how to call it, how to read its stream
  run.ts         spawning, stdin, hints, stop, the result
  ask.ts         one-shot answers
  status.ts      installed / signed in / ready
  catalog.ts     models and efforts, and checking a choice
  cli/           the brainyard command
  ui/            the dashboard server and page
test/
  fixtures/      fake claude, codex and agy
scripts/
  live-check.ts  the matrix against the real CLIs
```

## Rules of the house

- **The prompt never goes on the command line.** Arguments get parsed as options, have length
  limits and show up in `ps`. A test sends a prompt starting with `---` to every adapter and
  checks that it stays out of `argv`.
- **Nothing is dropped silently.** If a CLI cannot honour an option, emit a `warning` event.
  If a line cannot be parsed, emit a warning and keep reading.
- **Fakes behave like the real thing.** If you learn something new about a CLI (an event
  shape, an exit behaviour), teach the fake too, so the test fails the way production would.
- **Claims are verified.** A capability goes into the README only after `npm run live` passes
  it against the real CLI. Please include the CLI version in the pull request.
- **No runtime dependencies.** Node's standard library covers what this package does.

## Adding a CLI

1. An adapter in `src/brains/` implementing `Adapter`: `plan()` builds the call, `parser()`
   reads the stream, `message()` encodes stdin messages when the CLI takes them.
2. Its entry in `src/brains/info.ts`: install and login hints, capabilities.
3. A fake in `test/fixtures/`, and tests next to the existing ones.
4. The checks in `scripts/live-check.ts` passing against the real CLI.

## Commits and pull requests

Small, focused pull requests are easiest to review. Describe what you changed and how you
checked it. For anything that touches a CLI's behaviour, paste the relevant `npm run live`
output.
