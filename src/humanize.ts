/**
 * A raw agent action → one human line. This is the difference between a feed
 * and a terminal dump: `Bash {"command":"npm test"}` becomes `ran: npm test`.
 *
 * Parsing each CLI's schema is the adapter's job; how an action is *called*
 * is shared, so fixing a phrase for one CLI fixes it for all three.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import type { EventKind } from './types.js';

const LIMIT = 100;

type Phrase = readonly [kind: EventKind, verb: string, key: string];

// Built-in tools of each CLI. Few, stable and not ours, so they live here.
const BUILTIN: Record<string, Phrase> = {
  // Claude Code
  Read: ['tool_call', 'read', 'file_path'],
  Write: ['file_write', 'wrote', 'file_path'],
  Edit: ['file_write', 'edited', 'file_path'],
  MultiEdit: ['file_write', 'edited', 'file_path'],
  NotebookEdit: ['file_write', 'edited notebook', 'notebook_path'],
  Bash: ['command', 'ran:', 'command'],
  BashOutput: ['tool_call', 'checked a background command', ''],
  KillShell: ['tool_call', 'stopped a background command', ''],
  Glob: ['tool_call', 'looked for files:', 'pattern'],
  Grep: ['tool_call', 'searched files for:', 'pattern'],
  LS: ['tool_call', 'listed', 'path'],
  WebSearch: ['tool_call', 'searched the web:', 'query'],
  WebFetch: ['tool_call', 'opened', 'url'],
  Skill: ['tool_call', 'loaded skill', 'skill'],
  Task: ['tool_call', 'delegated:', 'description'],
  Agent: ['tool_call', 'delegated:', 'description'],
  TodoWrite: ['tool_call', 'updated the plan', ''],
  ExitPlanMode: ['tool_call', 'finished planning', ''],
  // Antigravity
  view_file: ['tool_call', 'read', 'AbsolutePath'],
  write_to_file: ['file_write', 'wrote', 'TargetFile'],
  replace_file_content: ['file_write', 'edited', 'TargetFile'],
  multi_replace_file_content: ['file_write', 'edited', 'TargetFile'],
  run_command: ['command', 'ran:', 'CommandLine'],
  find_by_name: ['tool_call', 'looked for files:', 'Pattern'],
  grep_search: ['tool_call', 'searched files for:', 'Query'],
  list_dir: ['tool_call', 'listed', 'DirectoryPath'],
  search_web: ['tool_call', 'searched the web:', 'query'],
  read_url_content: ['tool_call', 'opened', 'Url'],
};

// Argument names differ between CLIs and versions. Losing the argument over a
// renamed field would be a pity, so these are tried when the expected one is missing.
const FALLBACK_KEYS = ['path', 'file_path', 'command', 'query', 'pattern', 'url', 'Url', 'CommandLine'];

/** Kind and human line for one tool call. */
export function describeTool(
  name: string,
  input: Record<string, unknown> = {},
  cwd?: string,
): { kind: EventKind; summary: string } {
  const tool = name || 'tool';

  const builtin = BUILTIN[tool];
  if (builtin) {
    const [kind, verb, key] = builtin;
    return { kind, summary: merge(verb, argument(input, key, cwd)) };
  }

  // Claude Code names MCP tools `mcp__<server>__<tool>`.
  if (tool.startsWith('mcp__')) {
    const [server = '', ...rest] = tool.slice('mcp__'.length).split('__');
    return { kind: 'tool_call', summary: `called ${server}: ${rest.join('__') || 'a tool'}` };
  }

  // Antigravity calls every MCP tool through one built-in.
  if (tool === 'call_mcp_tool') {
    const server = unDouble(String(input.ServerName ?? ''));
    return { kind: 'tool_call', summary: `called ${server || 'MCP'}: ${String(input.ToolName ?? '') || 'a tool'}` };
  }

  if (tool.startsWith('browser_')) {
    return { kind: 'tool_call', summary: `used the browser: ${tool.slice('browser_'.length).replaceAll('_', ' ')}` };
  }

  return { kind: 'tool_call', summary: `used ${tool}` };
}

/**
 * Antigravity loads an MCP server as a plugin and names it `<plugin>_<server>`;
 * Brainyard names the plugin after the server, so `docs_docs` means `docs`.
 */
export function unDouble(server: string): string {
  const half = Math.floor(server.length / 2);
  if (server.length % 2 === 1 && server[half] === '_' && server.slice(0, half) === server.slice(half + 1)) {
    return server.slice(0, half);
  }
  return server;
}

function argument(input: Record<string, unknown>, key: string, cwd?: string): string {
  if (!key) return '';
  let raw = input[key];
  if (raw === undefined || raw === null) {
    for (const fallback of FALLBACK_KEYS) {
      if (input[fallback] !== undefined && input[fallback] !== null) {
        raw = input[fallback];
        break;
      }
    }
  }
  const text = oneLine(stringify(raw));
  if (!text) return '';
  return clip(tidyPaths(text, cwd));
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function merge(verb: string, value: string): string {
  // "ran:" with nothing after it is a colon into the void.
  return value ? `${verb} ${value}` : verb.replace(/:$/, '');
}

/** Collapses whitespace so a multi-line value fits one feed line. */
export function oneLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/** One line, at most `limit` characters. */
export function clip(text: string, limit = LIMIT): string {
  const flat = oneLine(text);
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function variants(dir: string): string[] {
  const out = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.length > 1 ? value.replace(/[/\\]+$/, '') : value;
    if (trimmed) out.add(trimmed);
  };
  add(resolve(dir));
  try {
    add(realpathSync(dir));
  } catch {
    // The directory may be gone already; the unresolved form still helps.
  }
  // macOS hands out /tmp and /var as symlinks into /private.
  for (const value of [...out]) {
    if (value.startsWith('/private/')) add(value.slice('/private'.length));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Paths inside the working directory become relative, paths under your home
 * become `~/…`. An absolute path eats half a feed line and tells the reader
 * nothing: they know where the agent works.
 */
export function tidyPaths(text: string, cwd?: string): string {
  let out = text;
  if (cwd) {
    for (const dir of variants(cwd)) {
      const at = escapeRegExp(dir);
      // `/work/proj/a.txt` → `a.txt`, `/work/proj` → `.`, but `/work/proj2` stays.
      out = out.replace(new RegExp(`${at}[/\\\\]`, 'g'), '');
      out = out.replace(new RegExp(`${at}(?![\\w.-])`, 'g'), '.');
    }
  }
  const home = homedir();
  if (home && home.length > 1) {
    for (const dir of variants(home)) {
      out = out.replace(new RegExp(`${escapeRegExp(dir)}(?![\\w.-])`, 'g'), '~');
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A path relative to `cwd` when it lies inside it. */
export function shortPath(path: string, cwd?: string): string {
  if (!cwd || !isAbsolute(path)) return tidyPaths(path, cwd);
  for (const dir of variants(cwd)) {
    const rel = relative(dir, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return tidyPaths(path, cwd);
}
