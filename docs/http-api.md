# Local HTTP API

`brainyard ui` serves the dashboard and the API it uses. Any language can call the API to get
the same status checks, one-shot answers and streamed agent runs.

```sh
brainyard ui --no-open --port 4747 --token "$BRAINYARD_TOKEN"
```

Without `--token`, a random token is generated each start and printed as part of the URL
(`http://127.0.0.1:4747/#token=…`).

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

Runs started over the API default to `access: "workspace"`, and to a fresh temporary folder
when `cwd` is not given. The folder is kept afterwards so you can look at what the agent made.

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
| 404 | Unknown endpoint or run |
| 415 | A write that is not JSON |
| 421 | Unexpected `Host` header |
| 424 | The CLI is not installed (`fix` says how to install it) |
| 502 | The agent failed (`kind` says how: `usage_limit`, `not_logged_in`, `rate_limited`…) |

## Examples

```sh
TOKEN=secret-for-scripts
brainyard ui --no-open --token "$TOKEN" &

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4747/api/status | jq '.ready'

curl -s -X POST http://127.0.0.1:4747/api/ask \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"brain":"codex","prompt":"Name three HTTP methods","effort":"low"}' | jq -r .text
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
