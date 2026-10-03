/** Codex rollouts are append-only; keep turn state rather than forgetting it at a fixed tail boundary. */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

import { capturePane, listPanes, type PaneSettings } from './panes.js';
import type { SessionInfo } from './sessions.js';

interface TurnState {
  status: 'busy' | 'waiting';
  waitingFor?: string;
}

interface Rollout {
  dev: number;
  ino: number;
  mtime: number;
  offset: number;
  partial: string;
  skipping: boolean;
  decoder: StringDecoder;
  active: boolean;
  turnId: string;
  requests: Map<string, string>;
}

const rollouts = new Map<string, Rollout>();
const PROGRESS =
  /^(?:exec_command_(?:begin|end)|patch_apply_(?:begin|end)|mcp_tool_call_end|agent_(?:message|reasoning)(?:_delta)?|item_(?:started|completed))$/;
const REQUEST = /(?:^|_)(?:approval_request|request_user_input|elicitation_request)$/;
const RESOLVED = /(?:approval_response|user_input_response|elicitation_response|request_resolved|request_cancelled)$/;

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requestId(payload: Record<string, unknown>): string {
  const value = payload.call_id ?? payload.request_id ?? payload.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function clearAnonymous(state: Rollout) {
  for (const key of state.requests.keys()) if (key.startsWith('legacy:')) state.requests.delete(key);
}

function push(state: Rollout, entry: Record<string, unknown>) {
  const payload = obj(entry.payload);
  const type = str(payload.type);
  if (entry.type === 'event_msg') {
    const turnId = str(payload.turn_id);
    if (type === 'task_started') {
      state.active = true;
      state.turnId = turnId;
      state.requests.clear();
      return;
    }
    if (turnId && state.turnId && turnId !== state.turnId) return;
    if (type === 'task_complete' || type === 'turn_aborted') {
      state.active = false;
      state.requests.clear();
      return;
    }
    const id = requestId(payload);
    if (RESOLVED.test(type)) {
      if (id) state.requests.delete(id);
      else clearAnonymous(state);
    } else if (REQUEST.test(type)) {
      state.active = true;
      state.requests.set(
        id || `legacy:${type}`,
        type.includes('user_input') ? 'input' : type.includes('elicitation') ? 'elicitation' : 'approval',
      );
    } else if (PROGRESS.test(type)) {
      if (id) state.requests.delete(id);
      const itemId = requestId(obj(payload.item));
      if (itemId) state.requests.delete(itemId);
      clearAnonymous(state);
    }
  } else if (entry.type === 'response_item' && state.active) {
    const id = requestId(payload);
    if (type === 'function_call' && /^(?:functions\.)?request_user_input$/.test(str(payload.name))) {
      state.requests.set(id || 'legacy:request_user_input', 'input');
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      if (id) state.requests.delete(id);
      clearAnonymous(state);
    }
  }
}

/** Replays a file once, then only new complete lines. A rewrite gets a fresh state. */
export function codexRolloutState(path: string): TurnState | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    let state = rollouts.get(path);
    if (
      !state ||
      state.dev !== stat.dev ||
      state.ino !== stat.ino ||
      stat.size < state.offset ||
      (stat.size === state.offset && stat.mtimeMs !== state.mtime)
    ) {
      state = {
        dev: stat.dev,
        ino: stat.ino,
        mtime: stat.mtimeMs,
        offset: 0,
        partial: '',
        skipping: false,
        decoder: new StringDecoder('utf8'),
        active: false,
        turnId: '',
        requests: new Map(),
      };
    }
    const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - state.offset));
    while (state.offset < stat.size) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - state.offset), state.offset);
      if (!size) break;
      state.offset += size;
      let chunk = state.decoder.write(buffer.subarray(0, size));
      if (state.skipping) {
        const end = chunk.indexOf('\n');
        if (end < 0) continue;
        chunk = chunk.slice(end + 1);
        state.skipping = false;
      }
      const lines = (state.partial + chunk).split('\n');
      state.partial = lines.pop() ?? '';
      // Large prompts and tool output carry no lifecycle state; do not retain them between polls.
      if (state.partial.length > 64 * 1024) {
        state.partial = '';
        state.skipping = true;
      }
      for (const line of lines) {
        if (line.length > 64 * 1024) continue;
        try {
          push(state, obj(JSON.parse(line)));
        } catch {
          // A corrupt line does not discard the last known turn state.
        }
      }
    }
    state.mtime = stat.mtimeMs;
    rollouts.delete(path);
    rollouts.set(path, state);
    if (rollouts.size > 400) rollouts.delete(rollouts.keys().next().value!);
    if (!state.active) return undefined;
    const reason = state.requests.values().next().value;
    return reason ? { status: 'waiting', waitingFor: reason } : { status: 'busy' };
  } catch {
    rollouts.delete(path);
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Native approval requests are not persisted in recent Codex rollouts. Only a current dialog is evidence. */
function screenState(lines: readonly string[]): TurnState | undefined {
  const rows = lines.map((line) => stripVTControlCharacters(line).trim()).filter(Boolean);
  const footer = rows.at(-1) ?? '';
  if (
    /^Press enter to confirm or esc to cancel$/i.test(footer) &&
    rows.some((row) => /^›?\s*1\. Yes, proceed\b/.test(row))
  )
    return { status: 'waiting', waitingFor: 'approval' };
  if (/enter to submit answers?.*esc to interrupt/i.test(footer) && rows.some((row) => /^Question \d+\/\d+/.test(row)))
    return { status: 'waiting', waitingFor: 'input' };
  if (rows.slice(-8).some((row) => /(?:Working|Thinking|Reconnecting)\s*\(.*esc to interrupt/i.test(row)))
    return { status: 'busy' };
  return undefined;
}

/** Opt-in: use this server's Codex dialogs, without reading scrollback or changing a CLI's configuration. */
export async function codexPaneStates(list: SessionInfo[], settings: PaneSettings): Promise<SessionInfo[]> {
  const out = new Map(list.map((session) => [session.id, session]));
  const panes = (await listPanes(settings)).filter((pane) => pane.brain === 'codex' && pane.sessionId);
  await Promise.all(
    panes.map(async (pane) => {
      try {
        const screen = await capturePane(pane.pane, settings);
        const state = screen && screenState(screen.lines);
        if (!state) return;
        const session = out.get(pane.sessionId!) ?? {
          brain: 'codex' as const,
          id: pane.sessionId!,
          interactive: true,
          ...(pane.cwd ? { cwd: pane.cwd } : {}),
        };
        out.set(session.id, { ...session, live: { ...state, kind: 'interactive' } });
      } catch {
        // An unreadable pane leaves rollout evidence intact.
      }
    }),
  );
  return [...out.values()];
}
