import { describe, expect, it } from 'vitest';

import type { ParsedEvent, StreamParser } from '../src/brains/adapter.js';
import { antigravity } from '../src/brains/antigravity.js';
import { claude } from '../src/brains/claude.js';
import { codex } from '../src/brains/codex.js';
import { opencode } from '../src/brains/opencode.js';

const CWD = '/tmp/brainyard-work';

function feed(parser: StreamParser, events: Record<string, unknown>[]): ParsedEvent[] {
  return events.flatMap((event) => parser.push(event));
}

describe('claude parser', () => {
  it('reads a whole turn: init, actions, answer, cost and usage', () => {
    const parser = claude.parser(CWD);
    const events = feed(parser, [
      {
        type: 'system',
        subtype: 'init',
        session_id: 's-1',
        model: 'claude-haiku-4-5',
        tools: ['Bash'],
        mcp_servers: [],
      },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {} } },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'thinking', thinking: 'plan it' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ text: 'boom' }], is_error: true }] },
      },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Listed it.' }] } },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Listed it.',
        total_cost_usd: 0.02,
        queued_turn_count: 0,
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 30,
          output_tokens_details: { thinking_tokens: 3 },
        },
      },
    ]);
    expect(events.map((e) => [e.kind, e.summary, e.feed])).toEqual([
      ['init', 'Claude Code started · claude-haiku-4-5', true],
      ['thinking', 'plan it', false],
      ['command', 'ran: ls', true],
      ['tool_result', 'Bash → a.txt', false],
      ['tool_result', 'Bash failed: boom', true],
      ['message', 'Listed it.', true],
    ]);
    const outcome = parser.outcome();
    expect(outcome).toMatchObject({ text: 'Listed it.', sessionId: 's-1', costUsd: 0.02, results: 1 });
    expect(outcome.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 100,
      cacheWriteTokens: 30,
      reasoningTokens: 3,
    });
    expect(parser.queuedTurns).toBe(0);
  });

  it('treats a starting MCP server as fine and a failed one as a warning', () => {
    const parser = claude.parser(CWD);
    const events = parser.push({
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'slow', status: 'pending' },
        { name: 'docs', status: 'failed' },
      ],
    });
    const warnings = events.filter((e) => e.kind === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.summary).toContain('docs (failed)');
    expect(warnings[0]?.summary).not.toContain('slow');
  });

  it('reports an error result with its reason, and denials', () => {
    const parser = claude.parser(CWD);
    const events = parser.push({
      type: 'result',
      is_error: true,
      api_error_status: 429,
      result: "You've hit your session limit · resets 6:50pm",
      permission_denials: [{ tool_name: 'Bash' }],
    });
    expect(parser.outcome().error).toBe("API error 429: You've hit your session limit · resets 6:50pm");
    expect(parser.outcome().deniedTools).toEqual(['Bash']);
    expect(events.map((e) => e.kind)).toEqual(['denied']);
  });

  it('turns subscription window usage into limits and warns near the edge', () => {
    const parser = claude.parser(CWD);
    const events = parser.push({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        unifiedWindows: { five_hour: { utilization: 0.92, resetsAt: 1790719800 }, seven_day: { utilization: 0.3 } },
      },
    });
    expect(parser.outcome().limits).toEqual([
      { window: 'five_hour', utilization: 0.92, resetsAt: 1790719800 },
      { window: 'seven_day', utilization: 0.3 },
    ]);
    expect(events[0]?.kind).toBe('warning');
    expect(events[0]?.summary).toContain('five_hour window at 92%');
    expect(parser.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })).toEqual([]);
  });

  it('counts usage per message id, not per event', () => {
    const parser = claude.parser(CWD);
    const usage = { input_tokens: 10, output_tokens: 1 };
    feed(parser, [
      { type: 'assistant', message: { id: 'm1', usage, content: [] } },
      { type: 'assistant', message: { id: 'm1', usage, content: [] } },
      { type: 'assistant', message: { id: 'm2', usage, content: [] } },
    ]);
    expect(parser.outcome().usage.inputTokens).toBe(20);
  });

  it('knows when turns are still queued', () => {
    const parser = claude.parser(CWD);
    parser.push({ type: 'result', result: 'first', queued_turn_count: 1 });
    expect(parser.queuedTurns).toBe(1);
  });
});

describe('codex parser', () => {
  it('announces actions once, reports failures, sums usage', () => {
    const parser = codex.parser(CWD, 'gpt-5.5');
    const events = feed(parser, [
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "/bin/zsh -lc 'npm test'" } },
      {
        type: 'item.completed',
        item: {
          id: 'c1',
          type: 'command_execution',
          command: "/bin/zsh -lc 'npm test'",
          exit_code: 1,
          aggregated_output: 'FAIL',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'f1',
          type: 'file_change',
          changes: [
            { path: `${CWD}/a.ts`, kind: 'add' },
            { path: `${CWD}/b.ts`, kind: 'update' },
          ],
        },
      },
      { type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'vitest mocks' } },
      {
        type: 'item.started',
        item: { id: 'x1', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: {} },
      },
      {
        type: 'item.completed',
        item: {
          id: 'x1',
          type: 'mcp_tool_call',
          server: 'docs',
          tool: 'search',
          status: 'failed',
          error: { message: 'nope' },
        },
      },
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'hmm' } },
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Fixed.' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 },
      },
    ]);
    expect(events.map((e) => [e.kind, e.summary])).toEqual([
      ['init', 'Codex started · gpt-5.5'],
      ['command', 'ran: npm test'],
      ['tool_result', 'command failed (exit 1): FAIL'],
      ['file_write', 'created a.ts; edited b.ts'],
      ['tool_call', 'searched the web: vitest mocks'],
      ['tool_call', 'called docs: search'],
      ['tool_result', 'docs: search failed: nope'],
      ['thinking', 'hmm'],
      ['message', 'Fixed.'],
    ]);
    expect(parser.outcome()).toMatchObject({ text: 'Fixed.', sessionId: 'th-1', model: 'gpt-5.5', results: 1 });
    expect(parser.outcome().usage).toEqual({
      inputTokens: 600,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      reasoningTokens: 10,
    });
  });

  it('takes the failure message of a failed turn', () => {
    const parser = codex.parser(CWD);
    feed(parser, [
      { type: 'error', message: 'reconnecting' },
      { type: 'turn.failed', error: { message: 'usage limit reached' } },
    ]);
    expect(parser.outcome()).toMatchObject({ error: 'usage limit reached', results: 1 });
  });
});

describe('antigravity parser', () => {
  const step = (update: Record<string, unknown>) => ({ event: 'step_update', step_update: update });

  it('glues streamed replies per step and keeps only the last reply as the answer', () => {
    const parser = antigravity.parser(CWD);
    const events = feed(parser, [
      { event: 'init', conversation_id: 'c-1', init: { model: 'gemini-3.8-flash', tools: [] } },
      step({ step_index: 0, step_type: 'user_input', state: 'DONE' }),
      step({ step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Let me ' }),
      step({ step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'check.' }),
      step({
        step_index: 2,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } },
      }),
      step({
        step_index: 2,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } },
      }),
      step({ step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Two files.' }),
      step({ step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: '\n' }),
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'Two files.\n',
          usage: { input_tokens: 120, output_tokens: 9, cache_read_tokens: 20, thinking_tokens: 4 },
        },
      },
    ]);
    expect(events.map((e) => [e.kind, e.summary])).toEqual([
      ['init', 'Antigravity started · gemini-3.8-flash'],
      ['message', 'Let me check.'],
      ['command', 'ran: ls'],
      ['message', 'Two files.'],
    ]);
    expect(parser.outcome()).toMatchObject({ text: 'Two files.', sessionId: 'c-1', results: 1 });
    expect(parser.outcome().usage).toEqual({
      inputTokens: 100,
      outputTokens: 9,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: 4,
    });
  });

  it('says the answer when it arrives only in the result', () => {
    const parser = antigravity.parser(CWD);
    const events = parser.push({ event: 'result', result: { status: 'SUCCESS', response: 'PONG\n' } });
    expect(events.map((e) => [e.kind, e.summary])).toEqual([['message', 'PONG']]);
  });

  it('reports a failed tool step, keeps its own bookkeeping out of the feed', () => {
    const parser = antigravity.parser(CWD);
    const events = feed(parser, [
      step({
        step_index: 4,
        step_type: 'tool',
        state: 'ERROR',
        tool_name: 'grep_search',
        tool_info: { name: 'grep_search', error: { message: 'missing properties' } },
      }),
      step({
        step_index: 5,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { AbsolutePath: '/u/.gemini/antigravity-cli/mcp/x/tool.json' } },
      }),
    ]);
    expect(events[0]).toMatchObject({
      kind: 'tool_result',
      summary: 'grep_search failed: missing properties',
      feed: true,
    });
    expect(events[1]).toMatchObject({ summary: 'read its own tool notes', feed: false });
  });

  it('takes the last result as the total: usage is cumulative across turns', () => {
    const parser = antigravity.parser(CWD);
    feed(parser, [
      {
        event: 'result',
        result: { status: 'SUCCESS', response: 'one', usage: { input_tokens: 100, output_tokens: 10 } },
      },
      {
        event: 'result',
        result: { status: 'SUCCESS', response: 'two', usage: { input_tokens: 250, output_tokens: 30 } },
      },
    ]);
    expect(parser.outcome()).toMatchObject({ text: 'two', results: 2 });
    expect(parser.outcome().usage.inputTokens).toBe(250);
  });

  it('records denied actions and a non-success status', () => {
    const parser = antigravity.parser(CWD);
    const events = parser.push({
      event: 'result',
      result: { status: 'ERROR', error: 'boom', denied_actions: [{ display_name: 'RunCommand' }] },
    });
    expect(parser.outcome()).toMatchObject({ error: 'boom', deniedTools: ['RunCommand'] });
    expect(events.map((e) => e.kind)).toEqual(['denied']);
  });
});

describe('opencode parser', () => {
  const S = 'ses_main';
  const part = (type: string, fields: Record<string, unknown>, session = S) => ({
    type,
    timestamp: 1,
    sessionID: S,
    part: { id: `prt_${type}`, messageID: 'msg_1', sessionID: session, ...fields },
  });
  const step = () => part('step_start', { type: 'step-start' });
  const finish = (
    reason: string,
    tokens = { input: 100, output: 10, reasoning: 2, cache: { read: 50, write: 5 } },
    cost = 0,
  ) => part('step_finish', { type: 'step-finish', reason, tokens: { total: 0, ...tokens }, cost });
  const text = (value: string, session = S) => part('text', { type: 'text', text: value }, session);
  const tool = (name: string, input: Record<string, unknown>, state: Record<string, unknown> = {}) =>
    part('tool_use', { type: 'tool', tool: name, state: { status: 'completed', input, ...state } });

  it('reads a whole run: actions, the last step as the answer, usage summed over steps', () => {
    const parser = opencode.parser(CWD, 'sber/GigaChat-3-Pro');
    const events = feed(parser, [
      step(),
      text('Let me write it.'),
      tool('write', { filePath: `${CWD}/hello.txt`, content: 'hi' }, { output: 'Wrote file successfully.' }),
      finish('tool-calls'),
      step(),
      tool('bash', { command: 'false' }, { output: 'boom', metadata: { output: 'boom', exit: 1 } }),
      finish('tool-calls'),
      step(),
      part('reasoning', { type: 'reasoning', text: 'done now' }),
      text('Done.'),
      text('Both files are there.'),
      finish('stop'),
    ]);
    expect(events[0]).toMatchObject({ kind: 'init', summary: 'OpenCode started · sber/GigaChat-3-Pro' });
    const shown = events.filter((e) => e.feed).map((e) => e.summary);
    expect(shown).toEqual([
      'OpenCode started · sber/GigaChat-3-Pro',
      'Let me write it.',
      'wrote hello.txt',
      'ran: false',
      'command failed (exit 1): boom',
      'Done.',
      'Both files are there.',
    ]);
    expect(events.find((e) => e.kind === 'thinking')?.feed).toBe(false);
    const outcome = parser.outcome();
    expect(outcome).toMatchObject({ text: 'Done.\n\nBoth files are there.', sessionId: S, results: 1 });
    // OpenCode counts reasoning apart from output; Brainyard counts it as a part of it.
    expect(outcome.usage).toEqual({
      inputTokens: 300,
      outputTokens: 36,
      reasoningTokens: 6,
      cacheReadTokens: 150,
      cacheWriteTokens: 15,
    });
    expect(outcome.costUsd).toBeUndefined();
  });

  it('reports a price when the provider has one, and never treats 0 as free', () => {
    const priced = opencode.parser(CWD);
    feed(priced, [step(), text('a'), finish('stop', undefined, 0.0042)]);
    expect(priced.outcome().costUsd).toBe(0.0042);
  });

  it('a step that calls tools does not end the turn: exiting after one is a cut-off', () => {
    const parser = opencode.parser(CWD);
    feed(parser, [step(), tool('read', { filePath: 'a.txt' }), finish('tool-calls')]);
    expect(parser.outcome().results).toBe(0);
  });

  it('records a refused tool as denied and a plain failure as a failed result', () => {
    const parser = opencode.parser(CWD);
    const events = feed(parser, [
      step(),
      tool(
        'write',
        { filePath: '/elsewhere/x' },
        { status: 'error', error: 'The user rejected permission to use this specific tool call.' },
      ),
      tool(
        'bash',
        { command: 'rm x' },
        {
          status: 'error',
          error: 'The user has specified a rule which prevents you from using this specific tool call.',
        },
      ),
      tool('edit', { filePath: 'a.txt' }, { status: 'error', error: 'Could not find oldString in the file.' }),
      finish('tool-calls'),
    ]);
    expect(events.filter((e) => e.kind === 'denied').map((e) => e.summary)).toEqual([
      'the CLI refused write',
      'the CLI refused bash',
    ]);
    expect(events.find((e) => e.kind === 'tool_result')?.summary).toBe(
      'edit failed: Could not find oldString in the file.',
    );
    expect(parser.outcome().deniedTools).toEqual(['write', 'bash']);
  });

  it("takes the error, with the reference to OpenCode's log when it gives no reason", () => {
    const parser = opencode.parser(CWD);
    const events = feed(parser, [
      {
        type: 'error',
        sessionID: S,
        error: {
          name: 'UnknownError',
          data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_1' },
        },
      },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['init', 'error']);
    expect(parser.outcome()).toMatchObject({
      error: 'Unexpected server error. Check server logs for details. (OpenCode log: err_1)',
      results: 1,
    });
  });

  it('names MCP tools by their server and patches by their files', () => {
    const parser = opencode.parser(CWD, undefined, ['brainyard_demo', 'docs']);
    const events = feed(parser, [
      step(),
      tool('brainyard_demo_secret_word', {}),
      tool('apply_patch', {
        patchText: `*** Begin Patch\n*** Update File: ${CWD}/a.ts\n@@\n*** Add File: b.ts\n*** End Patch`,
      }),
    ]);
    expect(events.filter((e) => e.feed && e.kind !== 'init').map((e) => e.summary)).toEqual([
      'called brainyard_demo: secret_word',
      'edited a.ts, b.ts',
    ]);
  });

  it('leaves the parts of a subagent session out of the answer and the turn count', () => {
    const parser = opencode.parser(CWD);
    feed(parser, [
      step(),
      text('child says hi', 'ses_child'),
      part('step_finish', { type: 'step-finish', reason: 'stop', tokens: { input: 7 } }, 'ses_child'),
      text('main answer'),
      finish('stop'),
    ]);
    expect(parser.outcome()).toMatchObject({ text: 'main answer', results: 1 });
    expect(parser.outcome().usage.inputTokens).toBe(107);
  });

  it('warns when the answer stopped at the output limit', () => {
    const parser = opencode.parser(CWD);
    const events = feed(parser, [step(), text('half an answer'), finish('length')]);
    expect(events.at(-1)).toMatchObject({ kind: 'warning', feed: true });
    expect(parser.outcome().results).toBe(1);
  });
});
