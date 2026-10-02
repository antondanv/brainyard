#!/usr/bin/env node
// A stand-in for `codex` that speaks the `codex exec --json` dialect.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lines, recorder } from './fake-common.mjs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const record = recorder(args);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (args[0] === '--version') {
  console.log('codex-cli 0.999.0');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_AUTH === 'out') {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(
    JSON.stringify({
      models: [
        { slug: 'gpt-test-hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: [{ effort: 'low' }] },
        {
          slug: 'gpt-test-big',
          display_name: 'GPT Test Big',
          visibility: 'list',
          priority: 2,
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
            { effort: 'ultra' },
          ],
        },
        {
          slug: 'gpt-test-mini',
          display_name: 'GPT Test Mini',
          visibility: 'list',
          priority: 1,
          default_reasoning_level: 'low',
          supported_reasoning_levels: ['low', 'medium'],
        },
      ],
    }),
  );
  process.exit(0);
}
if (args[0] === 'exec' && args.includes('--help')) {
  console.log('Run Codex non-interactively\n  --json  --sandbox <MODE>  --skip-git-repo-check  --ephemeral');
  process.exit(0);
}
// Anything but `exec` is the interactive TUI. The fake leaves the trace the
// real one leaves in CODEX_HOME — a rollout file and a thread name — and exits.
if (args[0] !== 'exec') {
  const home = process.env.FAKE_CODEX_HOME;
  if (home && args[0] !== 'resume') {
    const { mkdirSync, appendFileSync } = await import('node:fs');
    const id = process.env.FAKE_SESSION_ID ?? '019f0000-0000-7000-8000-000000000001';
    const now = new Date();
    const day = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), '01');
    mkdirSync(day, { recursive: true });
    const meta = { id, timestamp: now.toISOString(), cwd: process.cwd(), originator: 'codex_cli_rs', source: 'cli' };
    writeFileSync(
      join(day, `rollout-${now.toISOString().slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`),
      `${JSON.stringify({ timestamp: now.toISOString(), type: 'session_meta', payload: meta })}\n`,
    );
    const prompt = args.includes('--') ? args[args.indexOf('--') + 1] : '';
    if (prompt) {
      appendFileSync(
        join(home, 'session_index.jsonl'),
        `${JSON.stringify({ id, thread_name: prompt.slice(0, 30), updated_at: now.toISOString() })}\n`,
      );
    }
  }
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
}

const prompt = await lines(record).all();
const resuming = args[1] === 'resume';
const thread = resuming ? args[args.length - 2] : 'codex-thread-1';
out({ type: 'thread.started', thread_id: thread });
out({ type: 'turn.started' });

if (scenario === 'fail') {
  out({ type: 'error', message: 'stream disconnected, retrying' });
  out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 5:00 PM." } });
  process.exit(1);
}

out({
  type: 'item.started',
  item: { id: 'i0', type: 'command_execution', command: "/bin/zsh -lc 'echo hi'", status: 'in_progress' },
});
out({
  type: 'item.completed',
  item: {
    id: 'i0',
    type: 'command_execution',
    command: "/bin/zsh -lc 'echo hi'",
    aggregated_output: 'hi\n',
    exit_code: 0,
    status: 'completed',
  },
});
out({
  type: 'item.completed',
  item: {
    id: 'i1',
    type: 'command_execution',
    command: 'false',
    aggregated_output: 'boom',
    exit_code: 1,
    status: 'failed',
  },
});
writeFileSync(join(process.cwd(), 'a.txt'), 'a');
out({
  type: 'item.completed',
  item: {
    id: 'i2',
    type: 'file_change',
    changes: [{ path: join(process.cwd(), 'a.txt'), kind: 'add' }],
    status: 'completed',
  },
});
out({ type: 'item.completed', item: { id: 'i3', type: 'web_search', query: 'brainyard' } });
out({ type: 'item.completed', item: { id: 'i4', type: 'reasoning', text: 'thinking about it' } });
out({
  type: 'item.completed',
  item: { id: 'i5', type: 'agent_message', text: `Answer to: ${prompt.trim().slice(0, 60)}` },
});
out({
  type: 'turn.completed',
  usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 },
});
process.exit(0);
