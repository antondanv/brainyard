/**
 * The agent's last message in the last turn of a saved session, whole, read
 * from each CLI's own transcript store:
 *
 * - Claude Code: `~/.claude/projects/<project>/<id>.jsonl` — the last assistant text
 *   message after the last real user message (skipping sidechains and tool
 *   results), with entries sharing a `message.id` joined.
 * - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` — in the last
 *   turn, `event_msg` `task_complete.last_agent_message`, or else the last
 *   assistant message (`final_answer` ahead of `commentary`).
 * - OpenCode: `~/.local/share/opencode/opencode.db` — the last assistant
 *   message after the last user message, joining its `text` parts in `id` order.
 * - Antigravity: `undefined` until its protobuf step format is decoded.
 *
 * Never throws: missing stores, unknown sessions, corrupt lines and empty turns
 * all return `undefined`.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { resolveBrain } from './options.js';
import { claudeHome, codexHome, type Database, opencodeHome, openSqlite, rolloutFiles } from './sessions.js';
import type { BrainId } from './types.js';

export interface SessionMessage {
  /** The agent's last message in the last turn, whole, as written by the CLI, trimmed. */
  text: string;
  /** ISO timestamp of the message, if the store records one. */
  at?: string;
}

export interface LastMessageOptions {
  /** Read these stores instead of the defaults (tests, another account). */
  homes?: Partial<Record<BrainId, string>>;
  env?: NodeJS.ProcessEnv;
}

/**
 * The agent's last message in the last turn of a session, whole, or `undefined`
 * when the session does not exist, has no agent text after the last user prompt,
 * or its store cannot be read. Never throws.
 */
export async function lastMessage(
  brain: BrainId | string,
  id: string,
  options: LastMessageOptions = {},
): Promise<SessionMessage | undefined> {
  try {
    if (typeof id !== 'string') return undefined;
    const sessionId = id.trim();
    if (!sessionId) return undefined;
    const resolved = resolveBrain(String(brain));
    const env = options.env ?? process.env;
    const homes = options.homes ?? {};
    if (resolved === 'claude') return claudeLastMessage(homes.claude ?? claudeHome(env), sessionId);
    if (resolved === 'codex') return codexLastMessage(homes.codex ?? codexHome(env), sessionId);
    if (resolved === 'opencode') return await opencodeLastMessage(homes.opencode ?? opencodeHome(env), sessionId);
    // Antigravity's conversation steps are protobuf blobs not decoded yet.
    return undefined;
  } catch {
    return undefined;
  }
}

// ── Claude Code ─────────────────────────────────────────────────────────────

const INITIAL_TAIL_BYTES = 256 * 1024;
const CLAUDE_USER_WRAPPER =
  /^<(?:command-name|command-message|command-args|local-command-|system-reminder|task-notification|teammate-message|ide_)/;

function claudeLastMessage(home: string, id: string): SessionMessage | undefined {
  const path = findClaudeTranscript(home, id);
  if (!path) return undefined;
  const entries = readTailEntries(path, (list) => list.some(isClaudeUserTurn));
  if (entries.length === 0) return undefined;

  let lastUser = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isClaudeUserTurn(entries[i]!)) {
      lastUser = i;
      break;
    }
  }
  const turn = lastUser >= 0 ? entries.slice(lastUser + 1) : entries;

  interface Group {
    parts: string[];
    at?: string;
  }
  const groups: Group[] = [];
  const byId = new Map<string, Group>();
  for (const entry of turn) {
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
    const message = record(entry.message);
    const texts = claudeAssistantTexts(message.content);
    if (texts.length === 0) continue;
    const msgId = text(message.id);
    const at = isoString(entry.timestamp);
    let group = msgId ? byId.get(msgId) : undefined;
    if (!group) {
      group = { parts: [] };
      groups.push(group);
      if (msgId) byId.set(msgId, group);
    }
    group.parts.push(...texts);
    if (at) group.at = at;
  }

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    const joined = joinBlocks(group.parts);
    if (joined) return group.at ? { text: joined, at: group.at } : { text: joined };
  }
  return undefined;
}

/** Looks across every project folder: a worktree session lives under the worktree's path. */
function findClaudeTranscript(home: string, id: string): string | undefined {
  if (!safeId(id)) return undefined;
  const root = join(home, 'projects');
  const fileName = `${id}.jsonl`;
  let best: { path: string; mtime: number } | undefined;
  for (const dir of listDir(root)) {
    const candidate = join(root, dir, fileName);
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      if (!best || stat.mtimeMs > best.mtime) best = { path: candidate, mtime: stat.mtimeMs };
    } catch {
      // Not in this project folder.
    }
  }
  return best?.path;
}

function isClaudeUserTurn(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user' || entry.isSidechain === true || entry.isMeta === true) return false;
  const content = record(entry.message).content;
  if (typeof content === 'string') {
    const clean = content.trim();
    return Boolean(clean) && !CLAUDE_USER_WRAPPER.test(clean);
  }
  if (Array.isArray(content)) {
    if (content.some((part) => record(part).type === 'tool_result')) return false;
    return content.some((part) => {
      const block = record(part);
      if (block.type !== 'text' || typeof block.text !== 'string') return false;
      const clean = block.text.trim();
      return Boolean(clean) && !CLAUDE_USER_WRAPPER.test(clean);
    });
  }
  return false;
}

function claudeAssistantTexts(content: unknown): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    const block = record(part);
    if (block.type === 'text' && typeof block.text === 'string' && block.text) out.push(block.text);
  }
  return out;
}

// ── Codex ───────────────────────────────────────────────────────────────────

function codexLastMessage(home: string, id: string): SessionMessage | undefined {
  const path = findCodexRollout(home, id);
  if (!path) return undefined;
  const entries = readTailEntries(path, (list) => list.some(isCodexTurnStart));
  if (entries.length === 0) return undefined;

  let lastStart = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isCodexTurnStart(entries[i]!)) {
      lastStart = i;
      break;
    }
  }
  const turn = lastStart >= 0 ? entries.slice(lastStart + 1) : entries;

  let completed: SessionMessage | undefined;
  let finalAnswer: SessionMessage | undefined;
  let plain: SessionMessage | undefined;
  let commentary: SessionMessage | undefined;

  for (const entry of turn) {
    const payload = record(entry.payload);
    const at = isoString(entry.timestamp);
    if (entry.type === 'event_msg') {
      if (payload.type === 'task_complete') {
        const value = text(payload.last_agent_message).trim();
        if (value) completed = at ? { text: value, at } : { text: value };
      } else if (payload.type === 'agent_message') {
        const value = text(payload.message).trim();
        if (!value) continue;
        const item: SessionMessage = at ? { text: value, at } : { text: value };
        if (payload.phase === 'final_answer') finalAnswer = item;
        else if (payload.phase === 'commentary') commentary = item;
        else plain = item;
      }
    } else if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const value = codexAssistantText(payload.content);
      if (!value) continue;
      const item: SessionMessage = at ? { text: value, at } : { text: value };
      if (payload.phase === 'final_answer') finalAnswer = item;
      else if (payload.phase === 'commentary') commentary = item;
      else plain = item;
    }
  }

  return completed ?? finalAnswer ?? plain ?? commentary;
}

function findCodexRollout(home: string, id: string): string | undefined {
  if (!safeId(id)) return undefined;
  const suffix = `-${id}.jsonl`;
  for (const path of rolloutFiles(join(home, 'sessions'))) {
    if (basename(path).endsWith(suffix)) return path;
  }
  return undefined;
}

function isCodexTurnStart(entry: Record<string, unknown>): boolean {
  const payload = record(entry.payload);
  if (entry.type === 'event_msg') {
    return payload.type === 'task_started' || payload.type === 'user_message';
  }
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    const content = payload.content;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      const block = record(part);
      if (block.type !== 'input_text' && block.type !== 'text') return false;
      const clean = text(block.text).trim();
      return Boolean(clean) && !clean.startsWith('<') && !clean.startsWith('# AGENTS.md');
    });
  }
  return false;
}

function codexAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    const block = record(part);
    if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string' && block.text) {
      parts.push(block.text);
    }
  }
  return joinBlocks(parts);
}

// ── OpenCode ────────────────────────────────────────────────────────────────

async function opencodeLastMessage(home: string, id: string): Promise<SessionMessage | undefined> {
  const path = join(home, 'opencode.db');
  try {
    statSync(path);
  } catch {
    return undefined;
  }
  const open = await openSqlite();
  if (!open) return undefined;
  let db: Database | undefined;
  try {
    db = open(path);
    const messages = db
      .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC')
      .all(id);
    const partsQuery = db.prepare('SELECT data FROM part WHERE message_id = ? AND session_id = ? ORDER BY id ASC');
    for (const row of messages) {
      const r = record(row);
      const data = record(parseJson(text(r.data)));
      const role = text(data.role);
      // No assistant text after the last user prompt: do not return an earlier turn's answer.
      if (role === 'user') return undefined;
      if (role !== 'assistant') continue;
      const messageId = text(r.id);
      if (!messageId) continue;
      const parts = partsQuery.all(messageId, id);
      const texts: string[] = [];
      for (const partRow of parts) {
        const part = record(parseJson(text(record(partRow).data)));
        if (part.type === 'text' && typeof part.text === 'string' && part.text) texts.push(part.text);
      }
      const joined = joinBlocks(texts);
      if (!joined) continue;
      const time = record(data.time);
      const at = isoFromMs(time.completed) ?? isoFromMs(r.time_created);
      return at ? { text: joined, at } : { text: joined };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

// ── Plumbing ────────────────────────────────────────────────────────────────

/**
 * Reads from the end of a JSONL transcript, widening the window until a turn
 * boundary is inside it or the start of the file is reached. Keeps megabyte
 * transcripts fast without truncating a long last turn.
 */
function readTailEntries(
  path: string,
  hasBoundary: (entries: Record<string, unknown>[]) => boolean,
): Record<string, unknown>[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size <= 0) return [];
  let window = INITIAL_TAIL_BYTES;
  for (;;) {
    const start = Math.max(0, size - window);
    const chunk = readRange(path, start, size - start);
    const entries = jsonLines(chunk, start > 0);
    if (start === 0 || hasBoundary(entries) || window >= size) return entries;
    window = Math.min(size, window * 4);
  }
}

function safeId(id: string): boolean {
  return Boolean(id) && !id.includes('/') && !id.includes('\\') && id !== '.' && id !== '..';
}

function joinBlocks(parts: readonly string[]): string {
  const nonEmpty = parts.filter((part) => part.trim().length > 0);
  if (nonEmpty.length === 0) return '';
  return nonEmpty.join('\n\n').trim();
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readRange(path: string, start: number, length: number): string {
  if (length <= 0) return '';
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function jsonLines(chunk: string, fromMiddle: boolean): Record<string, unknown>[] {
  const lines = chunk.split('\n');
  if (fromMiddle) lines.shift();
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // Skip corrupt or partial lines.
    }
  }
  return out;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isoString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isoFromMs(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}
