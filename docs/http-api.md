# Local HTTP API

`brainyard serve` runs the API alone, for scripts in any language: status checks, one-shot
answers, streamed agent runs, saved and running sessions, usage and subscription limits, and
CLI sessions in tmux panes. `brainyard ui` serves the same API with the dashboard and opens it
in a browser; `brainyard web` serves it with the app's screen (see [The app's screen](#the-apps-screen)).

```sh
BRAINYARD_TOKEN=secret-for-scripts brainyard serve --json
{"url":"http://127.0.0.1:4747","port":4747,"token":"secret-for-scripts"}
```

The token comes from `--token`, then `$BRAINYARD_TOKEN` (`serve` only), else a random one per
start, printed to stderr. `--json` prints one line on stdout, which a program that started the
server reads to know where to call. Without `--port` the server takes 4747 or the next free
port; `--port 0` picks any. `SIGINT` and `SIGTERM` stop it; tmux panes keep running.

## Access rules

This API starts agents on your machine, so it is guarded like it:

- It listens on `127.0.0.1` unless you pass `--host`. Binding to another address prints a
  warning, because anyone who can reach the port and knows the token can run agents as you.
- Every `/api/*` call needs `Authorization: Bearer <token>`. The token is never accepted in the
  query string: URLs end up in browser history and logs. The dashboard gets it from the `#`
  fragment, which browsers do not send to servers.
- The `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`. This
  defeats DNS rebinding, where a web page makes your browser talk to your localhost under the
  page's own domain.
- `POST` bodies must be `application/json`, and a request with an `Origin` header must come
  from the dashboard's own origin. A cross-site form or a simple cross-origin request cannot
  produce that.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/status?live=1` | | Status report with model catalogs. `live=1` adds a one-word real call per CLI |
| GET | `/api/models/:brain?refresh=1` | | The model catalog of one CLI |
| POST | `/api/ask` | `{brain, prompt, model?, effort?, system?, web?}` | An answer: `{text, model, usage, costUsd, durationMs, …}` |
| POST | `/api/runs` | `{brain, prompt, cwd?, model?, effort?, access?, web?, resume?}` | `201` and the run: `{id, cwd, steerable, state, …}` |
| GET | `/api/runs` | | Runs of this server, newest first |
| GET | `/api/runs/:id` | | The run and its result (without events) once it is done |
| GET | `/api/runs/:id/events` | | Server-sent events, replayed from the start |
| POST | `/api/runs/:id/hint` | `{text}` | `{delivered: boolean}` |
| POST | `/api/runs/:id/stop` | `{}` | `{stopping: true}` |
| GET | `/api/sessions?cwd=&brain=&headless=1&limit=` | | Saved sessions of a folder, newest first, running ones with `live` |
| GET | `/api/sessions/live?cwd=&brain=&all=1` | | Sessions running now on the machine, or in `cwd`; `all=1` adds finished background ones |
| POST | `/api/sessions/:id/stop` | `{cwd?}` | `{result: "stopped" \| "not-running"}` for a Claude Code background session |
| POST | `/api/usage` | `{cwd?, brains?, sessionId?, limit?, headless?, offline?, live?, prices?, timeoutMs?}` | Subscription limits and the tokens and cost of saved sessions |
| GET | `/api/panes` | | Live panes, newest first, with `memory` in bytes |
| POST | `/api/panes` | `{brain, cwd, prompt?, resume?, name?, label?, system?, model?, effort?, mode?, worktree?, width?, height?}` | `201` and the pane: `{pane, brain, sessionId?, warnings, …}` |
| GET | `/api/panes/:pane/screen?scroll=` | | The screen: `{lines, width, height, cursor, …}`, lines with ANSI colours |
| POST | `/api/panes/:pane/send` | `{data?, enter?}` | `{sent: true}` |
| POST | `/api/panes/:pane/resize` | `{width, height}` | `{resized: boolean}` |
| POST | `/api/panes/:pane/close` | `{}` | `{closed: true}`; the conversation stays resumable |

Runs started over the API default to `access: "workspace"`, and to a fresh temporary folder
when `cwd` is not given. The folder is kept afterwards so you can look at what the agent made.

### Sessions, usage and panes

These endpoints are the library's `sessions()`, `liveSessions()`, `stopSession()`, `usage()`
and pane functions; the README describes their fields.

- `cwd` defaults to the server's folder for sessions and usage. A pane needs it: it is where
  the CLI works.
- `brain` in a query repeats: `?brain=claude&brain=codex`. Without it, every CLI.
- `stop` without `cwd` stops the session in its own folder; a session that is not running
  answers `not-running`. Only Claude Code has background sessions.
- `usage` makes no model call unless `live: true` (one tiny Claude Code call, which may cost);
  `offline: true` reads saved stores only. `prices` is
  `{"model": {"input": 3, "output": 15}}` in dollars per million tokens.
- A pane is named exactly, as `/api/panes` lists it: tmux itself would take the start of a
  name and act on another pane. `send` types `data` as is (keys, escape sequences, text in any
  language); `enter: true` then presses Enter on its own after a short pause, so a CLI that
  reads a fast burst as a paste still sends the message. Attaching takes a terminal, so it is
  `brainyard pane attach`, not an endpoint.

### The app's screen

`brainyard web` adds four endpoints for the page that shows the app; scripts can use them too.
They exist only on a server started by `brainyard web`, which serves the app at `/` and the
dashboard at `/dashboard`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/app/frames` | | Server-sent events: the app's frames, the bell, the end |
| POST | `/api/app/input` | `{data, paste?}` | `{ok: true}`; `data` is what a terminal would send for the keys |
| POST | `/api/app/mouse` | `{action, x, y}` | `{ok: true}`; `action` is `click`, `double`, `wheel-up` or `wheel-down`, `x` and `y` a cell from the top left, from 0 |
| POST | `/api/app/resize` | `{width, height}` | `{ok: true}`; the page's size in cells |

```text
event: frame
data: {"kind":"frame","width":120,"height":36,"rows":{"0":"\u001b[1mBrainyard\u001b[22m …","1":"…"},"full":true}

event: frame
data: {"kind":"frame","width":120,"height":36,"rows":{"17":"…"},"full":false}

event: bell
data: {"kind":"bell"}
```

- A `frame` has the rows that changed, by number, each exactly `width` cells with ANSI SGR
  colours. `full: true` (the first frame, after a resize or Ctrl+L) means: forget the old rows.
- `bell` — someone started waiting for you. `quit` — the person quit (`q`); the server stops.
- Keys are bytes, as from a terminal in raw mode: `\r` is Enter, `\u001b[A` the up arrow,
  `\u0011` Ctrl+Q. `paste: true` sends text as one bracketed paste, lines ending in `\r`.
- Every page sees the same app: one screen, the last size sent wins.

### The event stream

`GET /api/runs/:id/events` is a `text/event-stream` with three event names:

```text
event: agent
data: {"seq":1,"kind":"init","summary":"Claude Code started · claude-haiku-4-5-20251001","feed":true,…}

event: agent
data: {"seq":2,"kind":"file_write","summary":"wrote fib.py","tool":"Write","feed":true,…}

event: result
data: {"ok":true,"text":"0 1 1 2 3 5 8 13 21 34","sessionId":"…","costUsd":0.0346,…}
```

- `agent` carries an event (see the README for the list of kinds).
- `result` carries the run result without its `events` array, and ends the stream.
- `failure` carries `{error}` when the run could not start at all.

The stream replays from the first event, so you can connect late or twice.

### Errors

Every error is JSON: `{"error": {"kind": "...", "message": "...", "fix": "...", "resetsAt": "..."}}`.

| Status | When |
|---|---|
| 400 | Invalid options (`kind: invalid_option`) |
| 401 | Missing or wrong token |
| 403 | Cross-origin write |
| 404 | Unknown endpoint, run or pane |
| 415 | A write that is not JSON |
| 421 | Unexpected `Host` header |
| 424 | The CLI is not installed (`fix` says how to install it) |
| 502 | The agent failed (`kind` says how: `usage_limit`, `not_logged_in`, `rate_limited`…) |

## Examples

```sh
export BRAINYARD_TOKEN=secret-for-scripts
brainyard serve &
AUTH="Authorization: Bearer $BRAINYARD_TOKEN"; JSON='Content-Type: application/json'

curl -s -H "$AUTH" http://127.0.0.1:4747/api/status | jq '.ready'

curl -s -X POST http://127.0.0.1:4747/api/ask -H "$AUTH" -H "$JSON" \
  -d '{"brain":"codex","prompt":"Name three HTTP methods","effort":"low"}' | jq -r .text

# A Claude Code session in a pane: start it, read its screen, type into it, end it.
PANE=$(curl -s -X POST http://127.0.0.1:4747/api/panes -H "$AUTH" -H "$JSON" \
  -d "{\"brain\":\"claude\",\"cwd\":\"$PWD\",\"prompt\":\"Plan the release\"}" | jq -r .pane)
curl -s -H "$AUTH" "http://127.0.0.1:4747/api/panes/$PANE/screen" | jq -r '.lines[]'
curl -s -X POST "http://127.0.0.1:4747/api/panes/$PANE/send" -H "$AUTH" -H "$JSON" \
  -d '{"data":"Now write it down","enter":true}'
curl -s -X POST "http://127.0.0.1:4747/api/panes/$PANE/close" -H "$AUTH" -H "$JSON" -d '{}'
```

Python, standard library only:

```python
import json
import urllib.request

BASE, TOKEN = "http://127.0.0.1:4747", "secret-for-scripts"

def call(path, body=None):
    request = urllib.request.Request(
        BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    return urllib.request.urlopen(request)

run = json.load(call("/api/runs", {"brain": "claude", "prompt": "Write hello.py and run it"}))
event = None
for raw in call(f"/api/runs/{run['id']}/events"):
    line = raw.decode().rstrip("\n")
    if line.startswith("event: "):
        event = line[7:]
    elif line.startswith("data: "):
        data = json.loads(line[6:])
        if event == "agent" and data["feed"]:
            print(data["summary"])
        elif event == "result":
            print("answer:", data["text"])
```
