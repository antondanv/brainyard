# Security

## What Brainyard can do on your machine

Brainyard starts the agent CLIs you installed, as you. What an agent may do is set by
`access`:

- `full`: any command, any file. The equivalent of `--dangerously-skip-permissions`. The
  default for `run()` and `brainyard run`, because a headless agent cannot ask for approval.
- `workspace`: edits and (where the CLI can sandbox them) commands confined to the working
  directory.
- `readonly`: reads and searches only.

Prompts that include untrusted content (web pages, issues, emails) can try to steer an agent.
For those, use `workspace` or `readonly`, or run inside a container.

## The dashboard and its API

`brainyard ui` serves an HTTP API that can start agents. It listens on `127.0.0.1` by default,
requires a bearer token on every API call, rejects unexpected `Host` headers (DNS rebinding)
and accepts writes only as same-origin JSON. Binding it to another interface with `--host`
exposes it to anyone who can reach the port and learn the token. Do that only on a network
you trust.

## Secrets

Event summaries (the one-line feed) are redacted: API keys, tokens, JWTs, private keys and
passwords in connection strings are masked. Full texts, tool inputs and raw events are not
redacted, because they are the data you asked for. Redact them yourself with `redact()` before
storing them anywhere shared.

For Antigravity, MCP servers passed to a run are written into the working directory as
plugin files for the duration of the run, including their `env`, and removed afterwards.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
the repository page, rather than a public issue. Include the version, your OS, and steps to
reproduce.
