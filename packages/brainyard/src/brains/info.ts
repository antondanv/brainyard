import { BrainyardError } from '../errors.js';
import type { BrainId } from '../types.js';
import { BRAIN_IDS } from '../types.js';

/** What a CLI can do through Brainyard. Each `true` is verified against the real CLI. */
export interface Capabilities {
  /** Takes your messages while it works (`hint()`). */
  steering: boolean;
  /** Continues a previous conversation by session id. */
  resume: boolean;
  /** Loads MCP servers given per run. */
  mcp: boolean;
  /** Reports the dollar cost itself; otherwise only tokens. */
  reportsCost: boolean;
  /** Web access can be switched off. */
  webSwitch: boolean;
  /** The shell can be switched off. */
  shellSwitch: boolean;
  /** Lists its models on request. */
  modelList: boolean;
  /** Reports subscription window usage. */
  limits: boolean;
}

export interface BrainInfo {
  id: BrainId;
  label: string;
  vendor: string;
  /** Default executable. */
  binary: string;
  /** Environment variable that overrides the executable. */
  envVar: string;
  install: string;
  login: string;
  homepage: string;
  capabilities: Capabilities;
}

export const BRAINS: Record<BrainId, BrainInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    binary: 'claude',
    envVar: 'BRAINYARD_CLAUDE_BIN',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'run `claude` once and sign in (or set ANTHROPIC_API_KEY)',
    homepage: 'https://github.com/anthropics/claude-code',
    capabilities: {
      steering: true,
      resume: true,
      mcp: true,
      reportsCost: true,
      webSwitch: true,
      shellSwitch: true,
      modelList: false,
      limits: true,
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    binary: 'codex',
    envVar: 'BRAINYARD_CODEX_BIN',
    install: 'npm install -g @openai/codex',
    login: 'run `codex login` (or set OPENAI_API_KEY)',
    homepage: 'https://github.com/openai/codex',
    capabilities: {
      steering: false,
      resume: true,
      mcp: true,
      reportsCost: false,
      webSwitch: true,
      shellSwitch: false,
      modelList: true,
      limits: false,
    },
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    vendor: 'Google',
    binary: 'agy',
    envVar: 'BRAINYARD_AGY_BIN',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    login: 'run `agy` once and sign in',
    homepage: 'https://antigravity.google',
    capabilities: {
      steering: true,
      resume: true,
      mcp: true,
      reportsCost: false,
      webSwitch: false,
      shellSwitch: false,
      modelList: true,
      limits: false,
    },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'Anomaly',
    binary: 'opencode',
    envVar: 'BRAINYARD_OPENCODE_BIN',
    install: 'npm install -g opencode-ai',
    login: 'run `opencode auth login` and connect a provider (or set its API key)',
    homepage: 'https://opencode.ai',
    capabilities: {
      steering: true,
      resume: true,
      mcp: true,
      reportsCost: true,
      webSwitch: true,
      shellSwitch: true,
      modelList: true,
      limits: false,
    },
  },
};

const ALIASES: Record<string, BrainId> = {
  'claude-code': 'claude',
  claude_code: 'claude',
  claudecode: 'claude',
  cc: 'claude',
  'openai-codex': 'codex',
  agy: 'antigravity',
  'antigravity-cli': 'antigravity',
  'open-code': 'opencode',
  'opencode-ai': 'opencode',
};

/** `claude-code` → `claude`, `agy` → `antigravity`. Throws on an unknown name. */
export function brainId(value: string): BrainId {
  const name = value.trim().toLowerCase();
  if ((BRAIN_IDS as readonly string[]).includes(name)) return name as BrainId;
  const alias = ALIASES[name];
  if (alias) return alias;
  throw new BrainyardError('invalid_option', `unknown brain "${value}"; use one of: ${BRAIN_IDS.join(', ')}`);
}
