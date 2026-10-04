/**
 * From what the caller asked to what an adapter can build a call from:
 * defaults, validation, the executable, and model/effort checked against the
 * CLI's catalog. Everything here happens before a process exists, so every
 * failure is a thrown `BrainyardError` and nothing has been spent.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Launch } from './brains/adapter.js';
import { BRAINS, brainId } from './brains/info.js';
import { models, resolvePick } from './catalog.js';
import { BrainyardError } from './errors.js';
import { cliFlags } from './flags.js';
import { type Command, resolveCommand } from './process.js';
import type { Access, BrainId, McpServer, RunOptions } from './types.js';
import { BRAIN_IDS } from './types.js';

const ACCESS: readonly Access[] = ['full', 'workspace', 'readonly'];
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// OpenCode's ids have an underscore (`ses_…`); a leading dash would still read as a flag.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface Mode {
  /** `ask`: a one-shot answer — isolated from the project and the user's setup. */
  kind: 'run' | 'ask';
  system?: string;
}

export interface Resolved {
  brain: BrainId;
  command: Command;
  launch: Launch;
  warnings: string[];
}

/** Brain id from user input; throws on an unknown name. */
export function resolveBrain(value: string): BrainId {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BrainyardError('invalid_option', `choose a brain: ${BRAIN_IDS.join(', ')}`);
  }
  return brainId(value);
}

/** The executable of a brain, or a `not_installed` error that says how to get it. */
export function commandFor(brain: BrainId, command?: string | readonly string[]): Command {
  const info = BRAINS[brain];
  const found = resolveCommand(command, info.binary, info.envVar);
  if (found) return found;
  const wanted = Array.isArray(command) ? command[0] : command || process.env[info.envVar] || info.binary;
  throw new BrainyardError('not_installed', `${info.label} is not installed: no \`${wanted}\` found on PATH`, {
    brain,
    fix: `${info.install}, then ${info.login}`,
  });
}

export async function resolveLaunch(options: RunOptions, mode: Mode): Promise<Resolved> {
  const brain = resolveBrain(options.brain);
  const info = BRAINS[brain];
  const invalid = (message: string) => new BrainyardError('invalid_option', message, { brain });

  if (typeof options.prompt !== 'string' || !options.prompt.trim()) throw invalid('the prompt is empty');

  const cwd = resolve(options.cwd ?? process.cwd());
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw invalid(`working directory does not exist: ${cwd}`);

  const access = options.access ?? (mode.kind === 'ask' ? 'readonly' : 'full');
  if (!ACCESS.includes(access)) throw invalid(`access must be one of ${ACCESS.join(', ')}, not "${access}"`);

  const mcpServers = checkServers(options.mcpServers ?? {}, invalid);

  const warnings: string[] = [];
  let steerable = options.steerable ?? info.capabilities.steering;
  if (steerable && !info.capabilities.steering) {
    warnings.push(`${info.label} takes no messages while it works; hints are off for this run`);
    steerable = false;
  }
  // A one-shot answer keeps the input open where it can: a turn that ends
  // without text gets exactly one follow-up in the same conversation.
  if (mode.kind === 'ask') steerable = info.capabilities.steering;

  const command = commandFor(brain, options.command);

  let model = options.model?.trim() || undefined;
  let effort = options.effort?.trim().toLowerCase() || undefined;
  if ((model || effort) && options.validate !== false) {
    const catalog = await models(brain, options.command === undefined ? {} : { command: options.command });
    const pick = resolvePick(catalog, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    model = pick.model;
    effort = pick.effort;
  } else if (model?.startsWith('-')) {
    throw invalid(`"${model}" does not look like a model name`);
  }

  const flags = await cliFlags(brain, command);
  const launch: Launch = {
    brain,
    prompt: options.prompt,
    cwd,
    access,
    web: options.web ?? mode.kind !== 'ask',
    webAsked: options.web !== undefined,
    shell: options.shell ?? true,
    shellAsked: options.shell !== undefined,
    mcpServers,
    extraArgs: [...(options.extraArgs ?? [])],
    steerable,
    isolated: mode.kind === 'ask',
    flags,
  };
  if (model) launch.model = model;
  if (effort) launch.effort = effort;
  const resume = options.resume?.trim();
  if (resume) {
    // A session id goes on the command line: one that starts with a dash would be read as a flag.
    if (!SESSION_ID.test(resume)) throw invalid(`"${resume}" does not look like a session id`);
    launch.resume = resume;
  }
  if (mode.system?.trim()) launch.system = mode.system;
  return { brain, command, launch, warnings };
}

function checkServers(
  servers: Record<string, McpServer>,
  invalid: (message: string) => BrainyardError,
): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(servers)) {
    // The name becomes a TOML key for Codex and a folder name for Antigravity.
    if (!SERVER_NAME.test(name)) throw invalid(`MCP server name "${name}" must match ${SERVER_NAME}`);
    if (!server || typeof server.command !== 'string' || !server.command.trim()) {
      throw invalid(`MCP server "${name}" needs a command`);
    }
    const clean: McpServer = { command: server.command };
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === 'string')) {
        throw invalid(`MCP server "${name}": args must be a list of strings`);
      }
      clean.args = [...server.args];
    }
    if (server.env !== undefined) {
      if (typeof server.env !== 'object' || Object.values(server.env).some((value) => typeof value !== 'string')) {
        throw invalid(`MCP server "${name}": env must map names to strings`);
      }
      clean.env = { ...server.env };
    }
    out[name] = clean;
  }
  return out;
}
