import type { AgentEvent } from '@antondanv/brainyard';
import { describe, expect, it } from 'vitest';

import { feedLine, paint, width } from '../src/term.js';

describe('terminal feed', () => {
  const event = (over: Partial<AgentEvent>): AgentEvent => ({
    seq: 1,
    at: new Date(Date.parse('2026-01-01T00:01:05Z')).toISOString(),
    brain: 'claude',
    kind: 'command',
    summary: 'ran: npm test',
    feed: true,
    ...over,
  });
  const plain = paint(process.stdout, false);
  const started = Date.parse('2026-01-01T00:00:00Z');

  it('prints a clock, a mark and the summary', () => {
    expect(feedLine(event({}), plain, started)).toBe('01:05 $ ran: npm test');
    expect(feedLine(event({ kind: 'done', summary: 'done', data: { ok: true } }), plain, started)).toBe('01:05 ✓ done');
    expect(feedLine(event({ kind: 'done', summary: 'failed', data: { ok: false } }), plain, started)).toBe(
      '01:05 ✗ failed',
    );
  });

  it('colours only when asked and measures without colour codes', () => {
    const coloured = paint(process.stdout, true).green('ok');
    expect(coloured).not.toBe('ok');
    expect(width(coloured)).toBe(2);
  });
});
