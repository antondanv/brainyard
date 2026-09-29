import { describe, expect, it } from 'vitest';

import type { ParsedEvent, StreamParser } from '../src/brains/adapter.js';
import { antigravity } from '../src/brains/antigravity.js';
import { claude } from '../src/brains/claude.js';
import { codex } from '../src/brains/codex.js';

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
