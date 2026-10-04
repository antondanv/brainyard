import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BrainyardError } from '../src/errors.js';
import { run, start } from '../src/run.js';
import type { AgentEvent } from '../src/types.js';
import { FAKE, recording, tempDir } from './helpers.js';

describe('run() with Claude Code', () => {
  it('runs to the end, closes stdin on the result, and accounts for the work', async () => {
    const cwd = tempDir();
    const calls = recording();
    // If stdin were left open the fake would wait forever, like the real CLI.
    const result = await run({
      brain: 'claude',
      prompt: '--- a prompt that starts with dashes',
      cwd,
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'ok', FAKE_RECORD: calls.path },
    });
    expect(result).toMatchObject({
      ok: true,
      brain: 'claude',
      text: 'DONE',
      sessionId: 'claude-session-1',
      model: 'claude-default-test',
      costUsd: 0.0123,
      costSource: 'cli',
      exitCode: 0,
      toolCalls: 1,
      stopped: false,
    });
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toBe('hi');
    const kinds = result.events.map((e) => e.kind);
    expect(kinds[0]).toBe('init');
    expect(kinds.at(-1)).toBe('done');
    expect(result.events.find((e) => e.kind === 'file_write')?.summary).toBe('wrote hello.txt');
    expect(result.events.map((e) => e.seq)).toEqual(result.events.map((_, i) => i + 1));

    const call = calls.read();
    expect(call.argv.join(' ')).not.toContain('a prompt that starts');
    expect(JSON.parse(call.stdin[0] ?? '{}').message.content[0].text).toBe('--- a prompt that starts with dashes');
    expect(call.cwd).toBe(realCwd(cwd));
  });

  it('delivers a hint to the working agent', async () => {
    const agent = start({
      brain: 'claude',
      prompt: 'do the thing',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'hint' },
    });
    expect(agent.steerable).toBe(true);
    for await (const event of agent) {
      if (event.kind === 'command') expect(agent.hint('also say BANANA')).toBe(true);
    }
    const result = await agent.result;
    expect(result.text).toBe('heard: also say BANANA');
    expect(result.hints).toEqual(['also say BANANA']);
    expect(result.events.some((e) => e.kind === 'hint' && e.summary === 'you: also say BANANA')).toBe(true);
  });

  it('refuses a hint once the turn is over', async () => {
    const agent = start({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'ok' },
    });
    await agent.result;
    expect(agent.hint('too late')).toBe(false);
  });

  it('nudges a silent turn once, in the same conversation', async () => {
    const result = await run({
      brain: 'claude',
      prompt: 'answer me',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'silent' },
    });
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/^LATE ANSWER \(Your last turn ended/);
    expect(result.warnings.some((w) => w.includes('without an answer'))).toBe(true);
  });

  it('can be told not to nudge', async () => {
    const result = await run({
      brain: 'claude',
      prompt: 'answer me',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'silent' },
      nudge: false,
      timeoutMs: 5_000,
    });
    // The fake waits for the nudge that never comes: stdin was closed, so it exits.
    expect(result.text).toBe('');
  });

  it('classifies a subscription limit and keeps the reset time', async () => {
    const result = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'limit' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'usage_limit', retryable: false, resetsAt: '6:50pm' });
    expect(result.events.at(-2)?.kind).toBe('error');
  });

  it('reads the complaint from the start of stderr when the CLI crashes', async () => {
    const result = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'crash' },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("Claude Code exited with code 1: error: unknown option '--bogus'");
  });

  it('treats exit code 0 without a result as a cut-off turn, not success', async () => {
    const result = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'cutoff' },
      steerable: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/without a final result/);
  });

  it('survives lines it cannot read', async () => {
    const result = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'broken' },
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('still here');
    expect(result.events.some((e) => e.kind === 'warning' && !e.feed)).toBe(true);
  });

  it('warns about MCP servers that did not start', async () => {
    const result = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'mcp-fail' },
    });
    expect(result.warnings.some((w) => w.includes('docs (failed)'))).toBe(true);
  });

  it('reports denied tools and subscription windows', async () => {
    const denied = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'denied' },
    });
    expect(denied.deniedTools).toEqual(['Bash']);
    const limits = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'limits-warning' },
    });
    expect(limits.limits.map((w) => w.window)).toEqual(['five_hour', 'seven_day']);
  });

  it('stops a hanging agent and everything it started', async () => {
    const agent = start({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'hang' },
    });
    for await (const event of agent) if (event.kind === 'message') agent.stop('enough');
    const result = await agent.result;
    expect(result).toMatchObject({ ok: false, stopped: true, error: { kind: 'stopped', message: 'stopped: enough' } });
    expect(result.events.some((e) => e.kind === 'stopped')).toBe(true);
  });

  it('honours a timeout and an abort signal', async () => {
    const timed = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'hang' },
      timeoutMs: 800,
    });
    expect(timed.error?.kind).toBe('timeout');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user left')), 500);
    const aborted = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'hang' },
      signal: controller.signal,
    });
    expect(aborted.error).toMatchObject({ kind: 'stopped', message: 'stopped: user left' });
  });

  it('does not start a process when the signal is already aborted', async () => {
    const calls = recording();
    const controller = new AbortController();
    controller.abort(new Error('never mind'));
    const result = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_RECORD: calls.path },
      signal: controller.signal,
    });
    expect(result.error).toMatchObject({ kind: 'stopped', message: 'stopped: never mind' });
    expect(result.exitCode).toBeNull();
    expect(() => calls.read()).toThrow(/did not record/);
  });

  it('keeps going when an event listener throws', async () => {
    const seen: AgentEvent[] = [];
    const result = await run({
      brain: 'claude',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'ok' },
      onEvent: (event) => {
        seen.push(event);
        throw new Error('listener bug');
      },
    });
    expect(result.ok).toBe(true);
    expect(seen.length).toBe(result.events.length);
  });

  it('sends plain text on stdin when not steerable', async () => {
    const calls = recording();
    const agent = start({
      brain: 'claude',
      prompt: 'line one\nline two',
      cwd: tempDir(),
      command: FAKE.claude,
      steerable: false,
      env: { FAKE_SCENARIO: 'ok', FAKE_RECORD: calls.path },
    });
    expect(agent.steerable).toBe(false);
    expect((await agent.result).ok).toBe(true);
    expect(calls.read().stdin).toEqual(['line one', 'line two']);
    expect(calls.read().argv).not.toContain('--input-format');
  });
});

describe('run() with Codex', () => {
  it('reads the prompt from stdin and translates its items', async () => {
    const cwd = tempDir();
    const calls = recording();
    const result = await run({
      brain: 'codex',
      prompt: 'fix it',
      cwd,
      command: FAKE.codex,
      env: { FAKE_RECORD: calls.path },
      prices: { 'gpt-test': { input: 1, output: 10 } },
      model: 'gpt-test',
      validate: false,
    });
    expect(result).toMatchObject({
      ok: true,
      text: 'Answer to: fix it',
      sessionId: 'codex-thread-1',
      model: 'gpt-test',
    });
    expect(result.costSource).toBe('estimate');
    expect(result.costUsd).toBeCloseTo((600 * 1 + 50 * 10 + 400 * 0.1) / 1_000_000, 10);
    expect(existsSync(join(cwd, 'a.txt'))).toBe(true);
    const summaries = result.events.filter((e) => e.feed).map((e) => e.summary);
    expect(summaries).toContain('ran: echo hi');
    expect(summaries).toContain('command failed (exit 1): boom');
    expect(summaries).toContain('created a.txt');
    expect(calls.read().stdin).toEqual(['fix it']);
    expect(calls.read().argv.at(-1)).toBe('-');
  });

  it('is not steerable, and says so instead of pretending', async () => {
    const agent = start({ brain: 'codex', prompt: 'x', cwd: tempDir(), command: FAKE.codex });
    expect(agent.steerable).toBe(false);
    expect(agent.hint('hello?')).toBe(false);
    const result = await agent.result;
    expect(result.warnings.some((w) => w.includes('takes no messages'))).toBe(true);
  });

  it('resumes a thread', async () => {
    const calls = recording();
    const result = await run({
      brain: 'codex',
      prompt: 'and now?',
      resume: 'thread-42',
      cwd: tempDir(),
      command: FAKE.codex,
      env: { FAKE_RECORD: calls.path },
    });
    expect(result.sessionId).toBe('thread-42');
    expect(calls.read().argv.slice(0, 2)).toEqual(['exec', 'resume']);
  });

  it('classifies a failed turn', async () => {
    const result = await run({
      brain: 'codex',
      prompt: 'x',
      cwd: tempDir(),
      command: FAKE.codex,
      env: { FAKE_SCENARIO: 'fail' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'usage_limit', resetsAt: '5:00 PM' });
  });
});

describe('run() with Antigravity', () => {
  it('turns each hint into its own turn and closes stdin after the last answer', async () => {
    const agent = start({ brain: 'antigravity', prompt: 'first', cwd: tempDir(), command: FAKE.antigravity });
    for await (const event of agent) {
      if (event.kind === 'file_write') agent.hint('second');
    }
    const result = await agent.result;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Reply 2: second');
    const messages = result.events.filter((e) => e.kind === 'message').map((e) => e.summary);
    expect(messages).toEqual(['Reply 1: first', 'Reply 2: second']);
    expect(result.usage.inputTokens).toBe(200 - 40);
    // Its own bookkeeping is recorded, but kept out of the feed.
    expect(result.events.find((e) => e.summary === 'read its own tool notes')?.feed).toBe(false);
  });

  it('nudges a turn that ended without text after a refusal', async () => {
    const result = await run({
      brain: 'antigravity',
      prompt: 'answer',
      cwd: tempDir(),
      command: FAKE.antigravity,
      env: { FAKE_SCENARIO: 'silent' },
    });
    expect(result.ok).toBe(true);
    expect(result.deniedTools).toEqual(['RunCommand']);
    expect(result.text).toMatch(/^Reply 2: Your last turn ended/);
  });
});

describe('run() with OpenCode, no hints: `opencode run`', () => {
  const base = { brain: 'opencode', prompt: 'x', command: FAKE.opencode, steerable: false } as const;

  it('reads the prompt from stdin and translates the parts of its session', async () => {
    const cwd = tempDir();
    const calls = recording();
    const result = await run({ ...base, prompt: 'fix it', cwd, env: { FAKE_RECORD: calls.path } });
    expect(result).toMatchObject({
      ok: true,
      text: 'All done: fix it',
      sessionId: 'ses_fakeRun0000000000000001',
      toolCalls: 3,
      costUsd: null,
      costSource: null,
    });
    expect(result.usage).toEqual({
      inputTokens: 3000,
      outputTokens: 75,
      reasoningTokens: 15,
      cacheReadTokens: 900,
      cacheWriteTokens: 30,
    });
    expect(existsSync(join(cwd, 'hello.txt'))).toBe(true);
    const shown = result.events.filter((e) => e.feed).map((e) => e.summary);
    expect(shown).toEqual(
      expect.arrayContaining(['wrote hello.txt', 'ran: echo hi', 'command failed (exit 1): boom', 'All done: fix it']),
    );
    expect(result.events.some((e) => e.kind === 'thinking' && !e.feed)).toBe(true);
    const call = calls.read();
    // OpenCode works in PWD, not in the process's cwd: an inherited PWD would put it in our folder.
    expect(call.env.PWD).toBe(cwd);
    expect(call.stdin).toEqual(['fix it']);
    expect(call.argv).toEqual(expect.arrayContaining(['run', '--title=', '--auto', '--thinking']));
    expect(JSON.parse(call.env.OPENCODE_CONFIG_CONTENT ?? '{}').experimental).toEqual({ continue_loop_on_deny: true });
  });

  it('takes the price OpenCode reports, and estimates where it reports none', async () => {
    const priced = await run({ ...base, cwd: tempDir(), env: { FAKE_COST: '0.01' } });
    expect(priced.costSource).toBe('cli');
    expect(priced.costUsd).toBeCloseTo(0.03, 10);
    const estimated = await run({
      ...base,
      cwd: tempDir(),
      model: 'sber/GigaChat-3-Pro',
      prices: { 'sber/GigaChat-3-Pro': { input: 1, output: 10 } },
    });
    expect(estimated.costSource).toBe('estimate');
    expect(estimated.costUsd).toBeCloseTo((3000 * 1 + 75 * 10 + 900 * 0.1 + 30 * 1.25) / 1_000_000, 10);
  });

  it('continues a session', async () => {
    const calls = recording();
    const result = await run({ ...base, resume: 'ses_abc123', cwd: tempDir(), env: { FAKE_RECORD: calls.path } });
    expect(result.sessionId).toBe('ses_abc123');
    const argv = calls.read().argv;
    expect(argv[argv.indexOf('--session') + 1]).toBe('ses_abc123');
  });

  it('classifies failures; a turn that stops among its tool calls is cut off', async () => {
    const down = await run({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'fail' } });
    expect(down).toMatchObject({ ok: false, exitCode: 1, error: { kind: 'network', retryable: true } });
    const unknown = await run({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'unknown' } });
    expect(unknown.error?.message).toMatch(/\(OpenCode log: err_8a21f8a7\)$/);
    const cut = await run({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'cutoff' } });
    expect(cut).toMatchObject({ ok: false, exitCode: 0, error: { kind: 'failed' } });
    expect(cut.error?.message).toMatch(/cut off/);
  });

  it('lets the agent answer after a refused tool, and reports the refusal', async () => {
    const result = await run({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'denied' } });
    expect(result).toMatchObject({ ok: true, text: 'I could not write outside the folder.', deniedTools: ['write'] });
  });

  it('loads MCP servers for the run and names their tools by server', async () => {
    const result = await run({
      ...base,
      cwd: tempDir(),
      mcpServers: { docs: { command: 'node', args: ['server.js'] } },
      env: { FAKE_SCENARIO: 'mcp' },
    });
    expect(result.text).toBe('marmalade');
    expect(result.events.map((e) => e.summary)).toContain('called docs: secret_word');
  });

  it('shows a delegated task and answers with the main session', async () => {
    const result = await run({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'subagent' } });
    expect(result.text).toBe('kiwi');
    expect(result.events.map((e) => e.summary)).toContain('delegated: say kiwi');
  });

  it('checks model and variant against the models OpenCode runs, before anything starts', async () => {
    await expect(run({ ...base, cwd: tempDir(), model: 'sber/No-Such' })).rejects.toThrow(
      /OpenCode has no model "sber\/No-Such"/,
    );
    await expect(run({ ...base, cwd: tempDir(), model: 'opencode/big-pickle', effort: 'high' })).rejects.toThrow(
      /no configurable effort/,
    );
    const calls = recording();
    const result = await run({
      ...base,
      cwd: tempDir(),
      model: 'opencode/muse-free',
      effort: 'high',
      env: { FAKE_RECORD: calls.path },
    });
    expect(result.ok).toBe(true);
    const argv = calls.read().argv;
    expect(argv[argv.indexOf('--variant') + 1]).toBe('high');
  });
});

describe('run() with OpenCode through its server: hints reach it', () => {
  const base = { brain: 'opencode', prompt: 'x', command: FAKE.opencode } as const;
  type Http = { method: string; path: string; body?: Record<string, unknown> };
  const served = (calls: ReturnType<typeof recording>) =>
    calls.read() as ReturnType<typeof calls.read> & { http: Http[] };

  it('runs the turn through opencode serve and reads it as `run` prints it', async () => {
    const cwd = tempDir();
    const calls = recording();
    const result = await run({
      ...base,
      prompt: 'fix it',
      cwd,
      model: 'opencode/muse-free',
      effort: 'high',
      env: { FAKE_RECORD: calls.path },
    });
    expect(result).toMatchObject({ ok: true, text: 'All done: fix it', sessionId: 'ses_fakeServe00000000000001' });
    expect(result.toolCalls).toBe(3);
    expect(result.usage.inputTokens).toBe(3000);
    expect(existsSync(join(cwd, 'hello.txt'))).toBe(true);
    const shown = result.events.filter((e) => e.feed).map((e) => e.summary);
    // A tool reported running and then done is one line; the prompt itself is not an answer.
    expect(shown.filter((line) => line === 'ran: echo hi')).toHaveLength(1);
    expect(shown).not.toContain('fix it');
    const call = served(calls);
    expect(call.argv).toEqual(['serve', '--port', '0', '--hostname', '127.0.0.1']);
    expect(call.env.PWD).toBe(cwd);
    expect(JSON.parse(call.env.OPENCODE_CONFIG_CONTENT ?? '{}').experimental).toEqual({ continue_loop_on_deny: true });
    expect(call.http.find((h) => h.path === '/session')?.body).toMatchObject({
      title: 'fix it',
      permission: expect.arrayContaining([{ permission: 'plan_exit', pattern: '*', action: 'deny' }]),
    });
    expect(call.http.find((h) => h.path.endsWith('/prompt_async'))?.body).toEqual({
      parts: [{ type: 'text', text: 'fix it' }],
      model: { providerID: 'opencode', modelID: 'muse-free' },
      variant: 'high',
    });
  });

  it('delivers a hint into the running turn', async () => {
    const agent = start({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'hint' } });
    expect(agent.steerable).toBe(true);
    for await (const event of agent) if (event.kind === 'command') agent.hint('use vitest');
    expect(await agent.result).toMatchObject({ ok: true, text: 'heard: use vitest', hints: ['use vitest'] });
  });

  it("answers OpenCode's questions: yes with full access, no otherwise", async () => {
    const full = await run({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'permission' } });
    expect(full).toMatchObject({ ok: true, text: 'written', deniedTools: [] });
    const workspace = await run({ ...base, cwd: tempDir(), access: 'workspace', env: { FAKE_SCENARIO: 'permission' } });
    expect(workspace).toMatchObject({ ok: true, text: 'refused', deniedTools: ['write'] });
  });

  it('reports a failed turn; a turn that stops among its tool calls is cut off', async () => {
    const down = await run({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'fail' } });
    expect(down).toMatchObject({ ok: false, exitCode: 1, error: { kind: 'network', retryable: true } });
    const cut = await run({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'cutoff' } });
    expect(cut).toMatchObject({ ok: false, error: { kind: 'failed' } });
    expect(cut.error?.message).toMatch(/cut off/);
  });

  it('continues a session instead of creating one', async () => {
    const calls = recording();
    const result = await run({ ...base, resume: 'ses_abc123', cwd: tempDir(), env: { FAKE_RECORD: calls.path } });
    expect(result.sessionId).toBe('ses_abc123');
    const http = served(calls).http;
    expect(http.some((h) => h.path === '/session')).toBe(false);
    expect(http.some((h) => h.path === '/session/ses_abc123/prompt_async')).toBe(true);
  });

  it('loads MCP servers given per run', async () => {
    const result = await run({
      ...base,
      cwd: tempDir(),
      mcpServers: { docs: { command: 'node', args: ['server.js'] } },
      env: { FAKE_SCENARIO: 'mcp' },
    });
    expect(result.text).toBe('marmalade');
    expect(result.events.map((e) => e.summary)).toContain('called docs: secret_word');
  });

  it('stops the agent together with its server', async () => {
    const agent = start({ ...base, cwd: tempDir(), env: { FAKE_SCENARIO: 'hang' } });
    for await (const event of agent) if (event.kind === 'message') agent.stop('enough');
    expect(await agent.result).toMatchObject({ stopped: true, error: { kind: 'stopped' } });
  });
});

describe('run() refusals before anything starts', () => {
  it('throws for an unknown brain right away', () => {
    expect(() => start({ brain: 'gpt-cli', prompt: 'x' })).toThrow(/unknown brain/);
  });

  it('rejects an empty prompt and a missing directory', async () => {
    await expect(run({ brain: 'claude', prompt: '  ', command: FAKE.claude })).rejects.toThrow(/prompt is empty/);
    await expect(
      run({ brain: 'claude', prompt: 'x', cwd: '/definitely/not/here', command: FAKE.claude }),
    ).rejects.toThrow(/does not exist/);
  });

  it('says how to install a missing CLI', async () => {
    const attempt = run({ brain: 'codex', prompt: 'x', command: 'no-such-binary-brainyard' });
    await expect(attempt).rejects.toBeInstanceOf(BrainyardError);
    await expect(attempt).rejects.toMatchObject({
      kind: 'not_installed',
      fix: expect.stringContaining('npm install -g @openai/codex'),
    });
  });

  it('refuses a session id that would be read as a flag', async () => {
    await expect(run({ brain: 'codex', prompt: 'x', resume: '--help', command: FAKE.codex })).rejects.toThrow(
      /session id/,
    );
  });

  it('rejects a bad effort before spending anything', async () => {
    const calls = recording();
    await expect(
      run({
        brain: 'claude',
        prompt: 'x',
        cwd: tempDir(),
        effort: 'turbo',
        command: FAKE.claude,
        env: { FAKE_RECORD: calls.path },
      }),
    ).rejects.toMatchObject({ kind: 'invalid_option' });
    expect(() => calls.read()).toThrow(/did not record/);
  });

  it('makes the events iterator throw the same refusal', async () => {
    const agent = start({ brain: 'claude', prompt: '', command: FAKE.claude });
    await expect(async () => {
      for await (const _event of agent) {
        // nothing arrives
      }
    }).rejects.toThrow(/prompt is empty/);
  });
});

function realCwd(dir: string): string {
  // macOS hands out /var/... as a symlink into /private/var/...
  return process.platform === 'darwin' && dir.startsWith('/var/') ? `/private${dir}` : dir;
}
