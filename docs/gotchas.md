# Battle-tested quirks

Everything here was found by running the real CLIs, and most of it in production, where a
failure cost a paid run. Each entry is **symptom → cause → what Brainyard does**. Versions
checked: Claude Code 2.1.280, Codex 0.153.4, Antigravity 1.2.13, OpenCode 1.18.34.

If you drive these CLIs yourself, this page is the useful part of the library.

## Starting a run

### A prompt starting with a dash kills the call

**Symptom.** Claude Code exits with code 1 in 0.1 seconds: `error: unknown option '---…'`.

**Cause.** `-p` is a boolean flag (`--print`), and the prompt is a *positional* argument. Any
argument starting with a dash is parsed as an option. A markdown document with front matter
starts with `---`. Command-line arguments are a bad place for arbitrary text anyway: length
limits, and they show up in `ps`.

**Brainyard.** The prompt always goes to stdin:
- Claude Code reads it as text on stdin, or as the first stream-json message;
- Codex gets `-` as the prompt ("read from stdin"), for `exec` and for `exec resume`;
- Antigravity gets `-p=` (print mode without a positional prompt) plus stream-json input;
- OpenCode gets no message argument, and `run` then reads the prompt from stdin.

A test sends `--- front matter` to every adapter and asserts it never reaches `argv`.

### OpenCode works in PWD, not in its process's folder

**Symptom.** A run started in `./sandbox` wrote its files into the folder the caller was
started from, and `ask()` picked up that folder's `AGENTS.md`.

**Cause.** OpenCode takes its working folder from the `PWD` variable. A shell sets it on every
`cd`; a process spawned with another working directory inherits its parent's.

**Brainyard.** Starts every CLI with `PWD` set to the folder it works in. The fake OpenCode
works in `PWD` too, so a test fails when it is wrong.

### Every OpenCode run paid for a second model call

**Symptom.** A one-word answer took two model calls; the log says `agent=title`.

**Cause.** OpenCode titles a new session with a call of its own (to the provider's small model,
or the same one when there is none).

**Brainyard.** Passes `--title=` without a value: the session is named after the prompt, and
the prompt still never appears in `argv`.

### Codex writes nothing without an explicit sandbox

**Symptom.** `codex exec` runs, and the file the agent created is not there.

**Cause.** `codex exec` defaults to a read-only sandbox.

**Brainyard.** Always passes `--sandbox`: `danger-full-access`, `workspace-write` or
`read-only`, by `access`. `codex exec resume` has no `--sandbox` flag, so there it goes as
`-c sandbox_mode="…"`.

### Claude Code under root refuses to skip permissions

**Symptom.** In a Docker container: `--dangerously-skip-permissions cannot be used with
root/sudo privileges`.

**Cause.** Claude Code allows it as root only when `IS_SANDBOX=1`.

**Brainyard.** Sets `IS_SANDBOX=1` for `access: 'full'` when running as root, and only then.

### New flags break old versions

**Symptom.** `error: unknown option '--safe-mode'` on a machine with an older CLI.

**Brainyard.** Optional flags (`--safe-mode`, `--tools`, `--no-session-persistence`,
`--settings`, `--ephemeral`, `--sandbox`) are used only after reading the installed CLI's
`--help`. The result is cached per executable.

## Talking to a running agent

### A finished agent never exits

**Symptom.** The agent wrote its answer and reported its cost, then hung until killed. The
finished work got reported as a failure.

**Cause.** With `--input-format stream-json`, Claude Code and Antigravity treat stdin as a
conversation: after each turn's `result` they wait for the next message until EOF.

**Brainyard.** Closes stdin as soon as the turn has ended and nothing is pending. The fake
CLIs in the tests behave the same way, so forgetting to close stdin hangs the test instead of
passing it.

### A hint gets lost or answered twice

**Cause.** The two CLIs treat a message sent mid-turn differently:
- **Claude Code** folds it into the running turn. There is one `result`, and it reflects the
  hint. `result.queued_turn_count` says when something is still queued.
- **Antigravity** runs a separate turn for every stdin line, each with its own `result`.

**Brainyard.** Counts unanswered messages per CLI (`messageIsTurn`) and closes stdin only
after the last one is answered. Close after the first result on Antigravity and the hint
never runs.

### Antigravity wants a message object, not a string

**Symptom.** `cannot unmarshal string`.

**Brainyard.** Sends `{"event":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}`.
Claude Code gets `{"type":"user","message":{…}}`.

### Codex takes no input while it works

`codex exec` reads one prompt and runs. `agent.steerable` is `false`, and `hint()` returns
`false` with a warning event instead of pretending the message arrived. `stop()` still works:
a process can always be killed.

### OpenCode takes hints only through its server

**Symptom.** `opencode run` reads one prompt. Attached to a server (`run --attach`), a message
sent mid-turn does reach the agent, but `run` exits as soon as its own prompt is answered, and
the answer to the message never shows up in its stream.

**Cause.** `run` waits for the prompt it sent, not for the session.

**Brainyard.** A run that takes hints goes through a bridge of its own (`opencode-bridge.ts`):
it starts `opencode serve` on 127.0.0.1 with a one-off password, creates the session with the
same rules `run` uses, sends the prompt and every hint with `prompt_async`, answers permission
questions (`once` with full access, `reject` otherwise), reads the server's event stream and
prints it the way `opencode run --format json` does. It exits once the session is idle and
nothing more is coming. A hint joins the running turn, as with Claude Code. One-shot answers,
runs with `steerable: false` and runs with `extraArgs` keep using `opencode run`.

## Knowing how it ended

### Exit code 0 in the middle of work

**Symptom.** A research run "succeeded" after exactly five minutes, halfway through reading.

**Cause.** Antigravity's print mode had its own time limit (`--print-timeout`, five minutes by
default in earlier versions) and ended the turn with exit code 0.

**Brainyard.** Passes `--print-timeout=720h`. A run that exits without a final result event
counts as `failed: … the turn was cut off`, whatever the exit code.

### A turn ends without a word

**Symptom.** Status `SUCCESS`, tokens spent, and no text.

**Cause.** Antigravity ends the turn silently after a refused tool call (`denied_actions` in
the result says which), and sometimes after one of its own built-in tools crashes. Guessing
"it spent the tokens thinking" was wrong every time: the CLI reports the refusal itself.

**Brainyard.** When a turn ends without text, it sends exactly one follow-up in the same
conversation: "your last turn ended without a text answer (the CLI refused X); reply with the
final answer". A new process would not remember what the old one tripped over. One follow-up
and no more: that is a retry, not a loop. Turn it off with `nudge: false`.

### OpenCode has no final event

**Symptom.** The stream stops and the process exits; nothing says whether the turn finished.

**Cause.** `opencode run` exits once its session is idle. Every step ends with `step_finish`
and a reason; `tool-calls` means another step follows.

**Brainyard.** A step that finishes for any other reason ends the turn. A process that exits
after `tool-calls` was cut off, whatever its exit code.

### A refused tool ends OpenCode's turn without a word

**Symptom.** A run that tried to write outside its folder ended with exit code 0, no text, and
the rest of the task undone.

**Cause.** `opencode run` answers every permission question with "reject", and a rejection
stops the agent loop.

**Brainyard.** Turns on `experimental.continue_loop_on_deny`: the agent gets the refusal as a
tool error and goes on to answer. The refused tools are in `deniedTools`.

### An unknown OpenCode model is an "Unexpected server error"

**Symptom.** `--model sber/No-Such` ends with `UnknownError: Unexpected server error. Check
server logs for details.` and exit code 1.

**Brainyard.** OpenCode runs only the models `opencode models` lists, so its catalog is
complete: an unknown name is refused before the start, with the list to pick from. Other errors
keep the reference into OpenCode's log: `(OpenCode log: err_…)`.

### A looping model is not stopped

**Symptom.** A model called the same failing tool 243 times in five minutes, 1.8M input tokens,
until the process was killed.

**Cause.** `opencode run` has no step limit, and its doom-loop guard did not fire for calls
that kept failing.

**Brainyard.** No default limit, as with every CLI: a run killed halfway is paid for in full.
Set `timeoutMs`. A step limit goes in through `OPENCODE_CONFIG_CONTENT`
(`{"agent":{"build":{"steps":12}}}`), which Brainyard merges with its own settings.
`npm run live` gives every run five minutes.

### A usage limit looks like a rate limit

**Symptom.** Both say `429`.

**Cause.** A per-second throttle clears in seconds. A subscription window ("You've hit your
session limit · resets 6:50pm") clears in hours.

**Brainyard.** `rate_limited` (retryable) and `usage_limit` (not retryable, with `resetsAt`
taken from the CLI's own words) are different error kinds. Status codes match only as whole
numbers, so "processed 4291 files" is not a 429.

### The error is on the first line of stderr

**Symptom.** An error message that is a random slice of your own prompt.

**Cause.** CLIs print the error first and then echo what they received. The tail of stderr is
the echo.

**Brainyard.** Error messages quote the first non-empty line of stderr; `result.stderr` keeps
the beginning, not the end.

## Models, effort, cost

### Claude Code silently ignores an unknown effort

**Symptom.** You asked for `--effort ultra` and paid for the default. The only trace is a
warning on stderr.

**Brainyard.** Checks model and effort against the CLI's catalog before starting and refuses
with the list of what exists. Claude Code's catalog is its aliases (`fable`, `opus`, `sonnet`,
`haiku`), which it expands to the latest model. Haiku has no effort setting: the CLI would
accept the flag and ignore it, so Brainyard refuses it.

### Antigravity: effort is part of the model

**Symptom.** `--model gemini-3.8-flash` fails with "requires --effort", and
`--model gemini-3.8-flash-low --effort high` "conflicts".

**Cause.** `agy models` lists variants (`gemini-3.8-flash-high`) and the CLI wants the family
plus `--effort`.

**Brainyard.** Folds variants into families, fills in the default effort when a family needs
one, and turns a variant name into family + effort.

### OpenCode: effort is a variant

`opencode models --verbose` prints every model as JSON; its `variants` are the reasoning
levels, passed as `--variant`. A model without variants takes no effort, and Brainyard refuses
one instead of letting it be ignored.

### Model lists change under you

Codex fetches its catalog from the server: between two calls a model disappeared and a hidden
one appeared. Lists are asked from the CLI (`codex debug models`, `agy models`) and cached for
an hour. When a CLI does not answer, a built-in list is used and marked `source: 'builtin'`.

### Cost

- Claude Code reports dollars (`total_cost_usd`), computed by the CLI. Brainyard reports that.
- Codex and Antigravity report tokens only. Pass `prices` to get an estimate
  (`costSource: 'estimate'`). An unknown price is `null`, not zero.
- Codex's `input_tokens` includes cached input. Antigravity's `usage` is cumulative across
  the turns of one process, so the last result is the total. Adding them up would count the
  first turn twice.
- OpenCode reports dollars per step (`step_finish.cost`), priced from its model catalog. A
  provider without prices (a custom one, a local proxy) reports 0: Brainyard takes that as
  unknown (`costUsd: null`), not free. Every step reports only its own tokens, so they add up;
  reasoning is counted apart from output there, and Brainyard adds it to `outputTokens`.

## Permissions and sandboxes

### `workspace` means four different mechanisms

| | How `workspace` is enforced | Checked |
|---|---|---|
| Claude Code | `--permission-mode acceptEdits` plus its own sandbox (`sandbox.enabled`, `autoAllowBashIfSandboxed`) | code runs; a write to `~` fails with "operation not permitted" |
| Codex | `--sandbox workspace-write` | code runs; the write outside fails |
| Antigravity | `--mode accept-edits --sandbox` | edits work; its sandbox refuses most commands; the write outside fails |
| OpenCode | `external_directory: deny`, and the shell off | edits inside work; a write outside is refused |

Two findings behind this table:
- `acceptEdits` alone in Claude Code approves file edits and file-writing commands, but
  refuses anything that runs code (`python3 fib.py`: "This command requires approval"). The
  sandbox is what makes `workspace` useful.
- Antigravity's `accept-edits` alone let a command write to the home directory. Its
  `--sandbox` stops that, at the cost of refusing many commands.
- OpenCode has no sandbox. With its shell on, `echo x > ~/file` and the same with an absolute
  path went through: its folder check covers the paths of file tools, not where a command
  writes. So `workspace` turns the OpenCode shell off, and says so in a warning.

### OpenCode Zen's free tier wants OpenCode's own tools

**Symptom.** With a free `opencode/…` model, `ask()` and every `readonly` or `workspace` run
fail at once: `403 Error from provider (Console): OpenCode's free tier can only be used from
within OpenCode`. Full-access runs work.

**Cause.** Zen refuses a request that lacks OpenCode's tools. Taking away `edit` and `bash`
(or all of them, for an answer) is enough to trip it.

**Brainyard.** For an `opencode/` model, or when the default model is unknown, a tool that is
off stays listed with an `ask` rule, and `run` answers every such question with no. Other
providers have the tool taken away (`deny`), which is cheaper: an answer without tool
definitions costs 0.2k tokens instead of 6k. With full access `--auto` would approve the
question, so there a switch always takes the tool away.

### Codex asks for approval of every MCP call

**Symptom.** `user cancelled MCP tool call`.

**Cause.** `codex exec` asks before each MCP tool call, and in a non-interactive run nobody
answers.

**Brainyard.** Sets `default_tools_approval_mode = "approve"` on each server it passes. That
lifts approval for those servers only, not for the sandbox.

### Web and shell switches differ

- Claude Code: `--disallowedTools WebSearch,WebFetch` and `Bash`.
- Codex: web is a setting (`-c tools.web_search=true|false`; `--search` exists only for the
  interactive CLI). The shell cannot be switched off, only sandboxed, so `shell: false`
  downgrades full access to `workspace-write` and says so.
- Antigravity: no switch for either. When you ask for one, you get a warning, not silence.
- OpenCode: permissions by tool name in `OPENCODE_PERMISSION` (`webfetch`, `websearch`,
  `codesearch`, `bash`: `deny`). A denied tool is taken out of the agent's tool list.

## MCP servers

- **Claude Code:** `--mcp-config '{"mcpServers":{…}}'` for one run. Without
  `--strict-mcp-config` the user's own servers stay available, which is what an agent run
  wants. One-shot answers add it.
- **Codex:** `-c mcp_servers.<name>.command="…"`, `args` as a TOML list, `env` as a TOML table.
- **Antigravity:** a plugin folder (`.agents/plugins/<name>/`) in the working directory plus
  `--add-dir <cwd>`. Without `--add-dir` print mode loads no plugins. Brainyard removes the
  folder afterwards (the server's `env` may hold secrets), never overwrites a plugin it did not
  create, and does not touch `~/.gemini`.
- **OpenCode:** `OPENCODE_CONFIG_CONTENT` with `mcp.<name> = {type: "local", command: [cmd,
  …args], environment}`: nothing on disk. Its tools are named `<server>_<tool>` and need no
  approval.
- **Claude Code reports `pending` for a server that is still starting.** That is not a
  failure. Only `failed`, `error`, `disconnected` and `needs-auth` produce a warning. A failed
  server does deserve one: the agent will not say its tools are gone, it will just do worse.

## One-shot answers

Run inside a project, Claude Code picks up that project's `CLAUDE.md`, settings, hooks and MCP
servers, and they silently become part of the prompt. `ask()` runs in a fresh empty directory,
with `--safe-mode`, `--strict-mcp-config`, its own `--system-prompt` instead of the agent
persona, and `--tools ""` unless you allow web or more access. Tool definitions are the bulk of
the prompt, so a no-tools ask with Haiku costs a fraction of a cent ($0.0009–0.0018 in our runs).

OpenCode answers as an agent of its own (`--agent brainyard-answer`, defined in
`OPENCODE_CONFIG_CONTENT`): its prompt replaces the coding persona, `readonly` denies every
tool, and `OPENCODE_DISABLE_CLAUDE_CODE=1` keeps `~/.claude/CLAUDE.md` and Claude Code's skills
out (OpenCode reads them too). A one-word answer went from 8.7k tokens to 0.2k. OpenCode keeps
every session and has no flag against it, so `ask()` deletes its own afterwards
(`opencode session delete`, 0.4 s); the answers would otherwise pile up in the session list of
its desktop app.

## Reading the stream

- **Claude Code** sends one message as several events with the same `usage`. Count usage per
  message id, or take the total from `result`.
- **Antigravity** reports each tool step twice (`ACTIVE`, then `DONE`). Brainyard shows one
  line per action, plus a second line only when the step failed.
- **Antigravity** streams replies per step ("let me check" before a tool, the answer after it).
  The answer is the last reply, not all of them glued together. It sometimes arrives only in
  `result.response`.
- **Antigravity** reads its own notes (`~/.gemini/antigravity-cli/…`) mid-run. Those reads
  stay in the stream with `feed: false`.
- **Codex** wraps commands in `/bin/zsh -lc '…'`, and the feed shows the command inside.
- **OpenCode** sends a tool call once, when it has finished, with its result. Subagents work in
  sessions of their own: the stream carries the `task` call, not their parts or their tokens,
  which stay in their sessions in `opencode.db`.
- **One unreadable line must not cost the run.** A line that is not JSON, or an event the
  parser trips over, becomes a `warning` with `feed: false`, and reading goes on.

## Sessions

- **OpenCode** keeps its sessions in `~/.local/share/opencode/opencode.db`, shared with its
  desktop app. `opencode run` gives a session rules that keep questions out
  (`plan_exit: deny`), the TUI none: that is how headless runs are told apart. Until a title is
  generated a session is called `New session - <time>`, and the first prompt says more.
