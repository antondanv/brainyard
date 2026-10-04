import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Launch } from '../src/brains/adapter.js';
import { antigravity, PRINT_TIMEOUT } from '../src/brains/antigravity.js';
import { ANSWER_SYSTEM, claude, WORKSPACE_SETTINGS } from '../src/brains/claude.js';
import { codex, toml, unwrap } from '../src/brains/codex.js';
import { ANSWER_AGENT, opencode, opencodeDefaultModel, parseJsonc } from '../src/brains/opencode.js';
import { tempDir } from './helpers.js';

const TRICKY = '--- front matter\nprompt that starts with a dash';

function launch(overrides: Partial<Launch> = {}): Launch {
  return {
    brain: 'claude',
    prompt: TRICKY,
    cwd: '/tmp/work',
    access: 'full',
    web: true,
    webAsked: false,
    shell: true,
    shellAsked: false,
    mcpServers: {},
    extraArgs: [],
    steerable: true,
    isolated: false,
    flags: new Set(),
    ...overrides,
  };
}

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('every adapter', () => {
  it.each([
    ['claude', claude],
    ['codex', codex],
    ['antigravity', antigravity],
    ['opencode', opencode],
  ] as const)('%s never puts the prompt on the command line', (_name, adapter) => {
    for (const steerable of [true, false]) {
      const plan = adapter.plan(launch({ steerable }));
      expect(plan.args.join('\n')).not.toContain('front matter');
      expect(plan.prompt).toContain('front matter');
    }
  });
});

describe('claude', () => {
  it('streams in both directions when steerable', () => {
    const { args, input } = claude.plan(launch());
    expect(input).toBe('stream-json');
    expect(flagValue(args, '--input-format')).toBe('stream-json');
    expect(flagValue(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
  });

  it('sends plain text on stdin when not steerable', () => {
    const { args, input } = claude.plan(launch({ steerable: false }));
    expect(input).toBe('text');
    expect(args).not.toContain('--input-format');
  });

  it('maps access levels', () => {
    expect(claude.plan(launch({ access: 'full' })).args).toContain('--dangerously-skip-permissions');
    const workspace = claude.plan(launch({ access: 'workspace', flags: new Set(['--settings']) })).args;
    expect(flagValue(workspace, '--permission-mode')).toBe('acceptEdits');
    expect(JSON.parse(flagValue(workspace, '--settings') ?? '{}')).toEqual({
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    });
    expect(flagValue(workspace, '--settings')).toBe(WORKSPACE_SETTINGS);
    const readonly = claude.plan(launch({ access: 'readonly' })).args;
    expect(flagValue(readonly, '--permission-mode')).toBe('dontAsk');
    expect(flagValue(readonly, '--disallowedTools')).toContain('Bash');
    expect(flagValue(readonly, '--disallowedTools')).toContain('Write');
  });

  it('switches web and shell off by name', () => {
    const args = claude.plan(launch({ web: false, shell: false })).args;
    expect(flagValue(args, '--disallowedTools')?.split(',')).toEqual(['WebSearch', 'WebFetch', 'Bash']);
  });

  it('pre-approves web tools where permissions are not bypassed', () => {
    const args = claude.plan(launch({ access: 'workspace', web: true })).args;
    expect(flagValue(args, '--allowedTools')).toBe('WebSearch,WebFetch');
  });

  it('passes model, effort, resume and MCP servers', () => {
    const args = claude.plan(
      launch({
        model: 'opus',
        effort: 'high',
        resume: 'sess-1',
        mcpServers: { docs: { command: 'node', args: ['server.js'] } },
      }),
    ).args;
    expect(flagValue(args, '--model')).toBe('opus');
    expect(flagValue(args, '--effort')).toBe('high');
    expect(flagValue(args, '--resume')).toBe('sess-1');
    expect(JSON.parse(flagValue(args, '--mcp-config') ?? '')).toEqual({
      mcpServers: { docs: { command: 'node', args: ['server.js'] } },
    });
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('isolates one-shot answers from the project and the user setup', () => {
    const flags = new Set(['--safe-mode', '--tools', '--no-session-persistence']);
    const args = claude.plan(launch({ isolated: true, access: 'readonly', web: false, flags })).args;
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--no-session-persistence');
    expect(flagValue(args, '--system-prompt')).toBe(ANSWER_SYSTEM);
    expect(flagValue(args, '--tools')).toBe('');
  });

  it('uses new flags only when the installed CLI has them', () => {
    const args = claude.plan(launch({ isolated: true, access: 'readonly', flags: new Set() })).args;
    expect(args).not.toContain('--safe-mode');
    expect(args).not.toContain('--tools');
  });

  it('encodes a message the way stream-json input expects', () => {
    expect(JSON.parse(claude.message('hi'))).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
  });
});

describe('codex', () => {
  it('reads the prompt from stdin via "-" and never takes input mid-run', () => {
    const plan = codex.plan(launch({ brain: 'codex' }));
    expect(plan.input).toBe('text');
    expect(plan.args.at(-1)).toBe('-');
    expect(plan.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(plan.args).toContain('--skip-git-repo-check');
  });

  it('maps access levels to sandboxes', () => {
    expect(flagValue(codex.plan(launch({ access: 'full' })).args, '--sandbox')).toBe('danger-full-access');
    expect(flagValue(codex.plan(launch({ access: 'workspace' })).args, '--sandbox')).toBe('workspace-write');
    expect(flagValue(codex.plan(launch({ access: 'readonly' })).args, '--sandbox')).toBe('read-only');
  });

  it('cannot switch its shell off, so it sandboxes it and says so', () => {
    const plan = codex.plan(launch({ shell: false, shellAsked: true }));
    expect(flagValue(plan.args, '--sandbox')).toBe('workspace-write');
    expect(plan.warnings[0]).toMatch(/cannot switch its shell off/);
  });

  it('resumes through the subcommand, with the sandbox as config', () => {
    const args = codex.plan(launch({ resume: 'thread-9' })).args;
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('sandbox_mode="danger-full-access"');
    expect(args.slice(-2)).toEqual(['thread-9', '-']);
  });

  it('turns web search, model, effort and MCP into config', () => {
    const args = codex.plan(
      launch({
        web: false,
        model: 'gpt-5.5',
        effort: 'high',
        mcpServers: { docs: { command: 'node', args: ['s.js', 'a b'], env: { TOKEN: 'x' } } },
      }),
    ).args;
    expect(args).toContain('tools.web_search=false');
    expect(flagValue(args, '-m')).toBe('gpt-5.5');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('mcp_servers.docs.command="node"');
    expect(args).toContain('mcp_servers.docs.args=["s.js","a b"]');
    expect(args).toContain('mcp_servers.docs.env={TOKEN="x"}');
    expect(args).toContain('mcp_servers.docs.default_tools_approval_mode="approve"');
  });

  it('frames one-shot answers inside the prompt (Codex has no system prompt flag)', () => {
    const plan = codex.plan(launch({ isolated: true, system: 'Be brief.', flags: new Set(['--ephemeral']) }));
    expect(plan.prompt.startsWith('Be brief.\n\n')).toBe(true);
    expect(plan.args).toContain('--ephemeral');
  });

  it('writes TOML values', () => {
    expect(toml('a "quoted" value')).toBe('"a \\"quoted\\" value"');
    expect(toml(['x', 'y'])).toBe('["x","y"]');
    expect(toml({ SIMPLE: '1', 'needs quotes': '2' })).toBe('{SIMPLE="1","needs quotes"="2"}');
  });

  it('shows the command, not the shell wrapper around it', () => {
    expect(unwrap("/bin/zsh -lc 'cat hello.txt'")).toBe('cat hello.txt');
    expect(unwrap('bash -c "npm test"')).toBe('npm test');
    expect(unwrap('/bin/zsh -lc ls')).toBe('ls');
    expect(unwrap('git status')).toBe('git status');
  });
});

describe('antigravity', () => {
  it('prints without a positional prompt and without its own time limit', () => {
    const { args, input } = antigravity.plan(launch({ brain: 'antigravity' }));
    expect(input).toBe('stream-json');
    expect(args[0]).toBe('-p=');
    expect(args).toContain(`--print-timeout=${PRINT_TIMEOUT}`);
    expect(flagValue(args, '--input-format')).toBe('stream-json');
  });

  it('maps access levels, sandboxing the shell in the workspace', () => {
    expect(antigravity.plan(launch()).args).toContain('--dangerously-skip-permissions');
    const workspace = antigravity.plan(launch({ access: 'workspace', flags: new Set(['--sandbox']) })).args;
    expect(flagValue(workspace, '--mode')).toBe('accept-edits');
    expect(workspace).toContain('--sandbox');
    const old = antigravity.plan(launch({ access: 'workspace' }));
    expect(old.warnings[0]).toMatch(/no --sandbox/);
    expect(flagValue(antigravity.plan(launch({ access: 'readonly' })).args, '--mode')).toBe('plan');
  });

  it('warns about switches it does not have, but only when asked', () => {
    expect(antigravity.plan(launch({ web: false, webAsked: false })).warnings).toEqual([]);
    const plan = antigravity.plan(launch({ web: false, webAsked: true, shell: false, shellAsked: true }));
    expect(plan.warnings).toHaveLength(2);
  });

  it('installs MCP servers as plugins for one run and removes them afterwards', () => {
    const cwd = tempDir();
    const plan = antigravity.plan(
      launch({ cwd, mcpServers: { docs: { command: 'node', args: ['server.js'], env: { KEY: 'secret' } } } }),
    );
    const folder = join(cwd, '.agents', 'plugins', 'docs');
    expect(flagValue(plan.args, '--add-dir')).toBe(cwd);
    expect(JSON.parse(readFileSync(join(folder, 'mcp_config.json'), 'utf8'))).toEqual({
      mcpServers: { docs: { command: 'node', args: ['server.js'], env: { KEY: 'secret' } } },
    });
    plan.cleanup?.();
    expect(existsSync(join(cwd, '.agents'))).toBe(false);
  });

  it('never overwrites a plugin it did not create', () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, '.agents', 'plugins', 'docs'), { recursive: true });
    expect(() => antigravity.plan(launch({ cwd, mcpServers: { docs: { command: 'node' } } }))).toThrow(
      /will not overwrite/,
    );
    expect(existsSync(join(cwd, '.agents', 'plugins', 'docs'))).toBe(true);
  });

  it('encodes messages as objects: a plain string is refused by the CLI', () => {
    expect(JSON.parse(antigravity.message('hi')).message).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
  });
});

describe('opencode', () => {
  const env = (plan: { env: Record<string, string> }, name: string) => JSON.parse(plan.env[name] ?? '{}');
  // A provider of its own; OpenCode Zen's models get tools refused instead of taken away (below).
  const oc = (overrides: Partial<Launch> = {}) =>
    launch({ brain: 'opencode', model: 'sber/GigaChat-3-Pro', ...overrides });

  it('runs one prompt from stdin, titled after it instead of a generated title', () => {
    const plan = opencode.plan(oc());
    expect(plan.input).toBe('text');
    expect(plan.args.slice(0, 3)).toEqual(['run', '--format', 'json']);
    expect(plan.args).toContain('--title=');
    const resumed = opencode.plan(oc({ resume: 'ses_abc' })).args;
    expect(flagValue(resumed, '--session')).toBe('ses_abc');
    expect(resumed).not.toContain('--title=');
  });

  it('maps access levels to its permissions; the shell is off where it cannot be confined', () => {
    const full = opencode.plan(oc());
    expect(full.args).toContain('--auto');
    expect(full.env.OPENCODE_PERMISSION).toBeUndefined();
    const workspace = opencode.plan(oc({ access: 'workspace' }));
    expect(env(workspace, 'OPENCODE_PERMISSION')).toEqual({ external_directory: 'deny', bash: 'deny' });
    expect(workspace.args).not.toContain('--auto');
    expect(workspace.warnings[0]).toMatch(/cannot confine its shell/);
    const readonly = opencode.plan(oc({ access: 'readonly' }));
    expect(env(readonly, 'OPENCODE_PERMISSION')).toEqual({ edit: 'deny', bash: 'deny' });
    expect(readonly.warnings).toEqual([]);
  });

  it('uses the old name of --auto only where the CLI has nothing else', () => {
    const old = opencode.plan(oc({ flags: new Set(['--dangerously-skip-permissions']) }));
    expect(old.args).toContain('--dangerously-skip-permissions');
    expect(old.args).not.toContain('--auto');
  });

  it('switches web and shell off by name', () => {
    const plan = opencode.plan(oc({ web: false, shell: false }));
    expect(env(plan, 'OPENCODE_PERMISSION')).toEqual({
      webfetch: 'deny',
      websearch: 'deny',
      codesearch: 'deny',
      bash: 'deny',
    });
  });

  it('lets the agent answer after a refusal, and passes MCP servers as inline config', () => {
    const plan = opencode.plan(
      oc({
        mcpServers: { docs: { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } } },
      }),
    );
    expect(env(plan, 'OPENCODE_CONFIG_CONTENT')).toEqual({
      experimental: { continue_loop_on_deny: true },
      mcp: { docs: { type: 'local', command: ['node', 'server.js'], environment: { TOKEN: 'x' } } },
    });
  });

  it('passes model, effort and thinking where the CLI has them', () => {
    const args = opencode.plan(
      oc({ model: 'sber/GigaChat-3-Pro', effort: 'high', flags: new Set(['--thinking']) }),
    ).args;
    expect(flagValue(args, '--model')).toBe('sber/GigaChat-3-Pro');
    expect(flagValue(args, '--variant')).toBe('high');
    expect(args).toContain('--thinking');
  });

  it('answers as an agent of its own: no coding persona, no tools, no CLAUDE.md', () => {
    const plan = opencode.plan(oc({ isolated: true, access: 'readonly', web: false }));
    expect(flagValue(plan.args, '--agent')).toBe(ANSWER_AGENT);
    expect(plan.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
    const agent = env(plan, 'OPENCODE_CONFIG_CONTENT').agent[ANSWER_AGENT];
    expect(agent).toMatchObject({ mode: 'primary', prompt: ANSWER_SYSTEM, permission: { '*': 'deny' } });
    expect(plan.prompt).toBe(TRICKY);
    const framed = opencode.plan(oc({ isolated: true, access: 'readonly', web: true, system: 'Be brief.' }));
    expect(env(framed, 'OPENCODE_CONFIG_CONTENT').agent[ANSWER_AGENT]).toMatchObject({
      prompt: 'Be brief.',
      permission: { '*': 'deny', webfetch: 'allow', websearch: 'allow' },
    });
  });

  it('on OpenCode Zen keeps tools listed and refuses their calls: its free tier wants them', () => {
    for (const model of ['opencode/big-pickle', undefined]) {
      const readonly = opencode.plan(oc({ model, access: 'readonly', web: false }));
      expect(env(readonly, 'OPENCODE_PERMISSION')).toEqual({
        edit: 'ask',
        bash: 'ask',
        webfetch: 'ask',
        websearch: 'ask',
        codesearch: 'ask',
      });
      const answer = opencode.plan(oc({ model, isolated: true, access: 'readonly', web: false }));
      expect(env(answer, 'OPENCODE_CONFIG_CONTENT').agent[ANSWER_AGENT].permission).toEqual({ '*': 'ask' });
    }
    // `--auto` would approve a question: with full access a switch still takes the tool away.
    const full = opencode.plan(oc({ model: 'opencode/big-pickle', shell: false }));
    expect(env(full, 'OPENCODE_PERMISSION')).toEqual({ bash: 'deny' });
  });

  it("keeps what the caller's environment already sets, under its own settings", () => {
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ model: 'x/y', experimental: { other: 1 } }));
    vi.stubEnv('OPENCODE_PERMISSION', JSON.stringify({ read: 'allow', bash: 'allow' }));
    const plan = opencode.plan(oc({ access: 'readonly' }));
    expect(env(plan, 'OPENCODE_CONFIG_CONTENT')).toEqual({
      model: 'x/y',
      experimental: { other: 1, continue_loop_on_deny: true },
    });
    expect(env(plan, 'OPENCODE_PERMISSION')).toEqual({ read: 'allow', bash: 'deny', edit: 'deny' });
  });

  it('reads config the way OpenCode writes it: comments and trailing commas', () => {
    expect(
      parseJsonc('{\n  // the default\n  "model": "sber/GigaChat-3-Pro", /* note */\n  "url": "http://a//b,}",\n}'),
    ).toEqual({ model: 'sber/GigaChat-3-Pro', url: 'http://a//b,}' });
  });

  it('finds the default model in the config, the inline one first', () => {
    const home = tempDir();
    mkdirSync(join(home, 'opencode'));
    writeFileSync(join(home, 'opencode', 'opencode.jsonc'), '{\n  // mine\n  "model": "sber/GigaChat-3-Pro",\n}');
    expect(opencodeDefaultModel({ XDG_CONFIG_HOME: home })).toBe('sber/GigaChat-3-Pro');
    expect(opencodeDefaultModel({ XDG_CONFIG_HOME: home, OPENCODE_CONFIG_CONTENT: '{"model":"a/b"}' })).toBe('a/b');
    expect(opencodeDefaultModel({ XDG_CONFIG_HOME: tempDir() })).toBeUndefined();
  });
});
