/**
 * Live verification against the real CLIs installed on this machine.
 * It spends real (small) money: cheapest models, one-line tasks.
 *
 *   npm run live                       # every check on every ready CLI
 *   npm run live -- claude codex       # some CLIs
 *   npm run live -- --only mcp,resume  # some checks
 *
 * Tests prove the parsing against recorded shapes; this proves the shapes
 * are still what the CLIs print today.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  ask,
  BRAINS,
  type BrainId,
  brainId,
  type RunOptions,
  type RunResult,
  run,
  start,
  status,
} from '@antondanv/brainyard';

const opencodeModel = process.env.BRAINYARD_LIVE_OPENCODE_MODEL?.trim();
const CHEAP: Record<BrainId, Pick<RunOptions, 'model' | 'effort'>> = {
  claude: { model: 'haiku' },
  codex: { effort: 'low' },
  antigravity: { effort: 'low' },
  // OpenCode runs whatever providers you connected: the default one, or
  // BRAINYARD_LIVE_OPENCODE_MODEL (`opencode/big-pickle` is free).
  opencode: opencodeModel ? { model: opencodeModel } : {},
};

// A model that loops bills every step until something stops it (one did, 1.8M
// tokens in five minutes): no live run gets longer than this.
const LIMIT_MS = 5 * 60_000;
const cheap = (brain: BrainId): Pick<RunOptions, 'model' | 'effort' | 'timeoutMs'> => ({
  ...CHEAP[brain],
  timeoutMs: LIMIT_MS,
});

const { values, positionals } = parseArgs({ allowPositionals: true, options: { only: { type: 'string' } } });
const only = values.only ? new Set(values.only.split(',')) : undefined;
const wanted = positionals.length ? positionals.map((name) => brainId(name)) : undefined;
const server = fileURLToPath(new URL('../examples/mcp-server.mjs', import.meta.url));

interface Outcome {
  ok: boolean;
  note: string;
  cost: number;
}
type Check = (brain: BrainId) => Promise<Outcome>;

const dirs: string[] = [];
const dir = () => {
  const made = mkdtempSync(join(tmpdir(), 'brainyard-live-'));
  dirs.push(made);
  return made;
};
const spent = (...results: { costUsd: number | null }[]) => results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
const said = (result: RunResult) => result.text.replace(/\s+/g, ' ').trim().slice(0, 60);
const failure = (result: RunResult) => `${result.error?.kind}: ${result.error?.message ?? ''}`.slice(0, 90);

const checks: Record<string, Check> = {
  async ask(brain) {
    const answer = await ask(brain, 'What is 17*3? Reply with the number only.', cheap(brain));
    return {
      ok: answer.text.includes('51'),
      note: `"${answer.text}" in ${(answer.durationMs / 1000).toFixed(1)}s`,
      cost: answer.costUsd ?? 0,
    };
  },

  async dashes(brain) {
    // A prompt that starts like a flag must reach the model as text.
    const answer = await ask(brain, '--- front matter ---\nReply with exactly: ok', cheap(brain));
    return { ok: /ok/i.test(answer.text), note: `"${answer.text}"`, cost: answer.costUsd ?? 0 };
  },

  async run(brain) {
    const cwd = dir();
    const result = await run({
      brain,
      cwd,
      ...cheap(brain),
      prompt: 'Create a file hello.txt containing the word hi, then reply with one short line.',
    });
    const file = join(cwd, 'hello.txt');
    const ok = result.ok && existsSync(file) && readFileSync(file, 'utf8').includes('hi');
    const actions = `${result.toolCalls} ${result.toolCalls === 1 ? 'action' : 'actions'}`;
    return { ok, note: ok ? `${actions}, "${said(result)}"` : failure(result), cost: spent(result) };
  },

  async hint(brain) {
    if (!BRAINS[brain].capabilities.steering) return { ok: true, note: 'not supported by this CLI', cost: 0 };
    const agent = start({
      brain,
      cwd: dir(),
      ...cheap(brain),
      prompt: 'Create hello.txt containing hi, then run `ls` with the shell, then reply with a one-line summary.',
    });
    let sent = false;
    for await (const event of agent) {
      if (!sent && (event.kind === 'file_write' || event.kind === 'command'))
        sent = agent.hint('End your summary with the word BANANA.');
    }
    const result = await agent.result;
    const ok = result.ok && sent && /banana/i.test(result.text);
    return {
      ok,
      note: ok ? `"${said(result)}"` : sent ? `not followed: "${said(result)}"` : 'no action to hint at',
      cost: spent(result),
    };
  },

  async resume(brain) {
    const cwd = dir();
    const word = `PAPAYA${randomBytes(2).toString('hex').toUpperCase()}`;
    const first = await run({ brain, cwd, ...cheap(brain), prompt: `Remember the code word ${word}. Reply with OK.` });
    if (!first.ok || !first.sessionId) return { ok: false, note: `first turn: ${failure(first)}`, cost: spent(first) };
    const second = await run({
      brain,
      cwd,
      ...cheap(brain),
      resume: first.sessionId,
      prompt: 'What code word did I ask you to remember? Reply with the word only.',
    });
    const ok = second.ok && second.text.includes(word);
    return { ok, note: ok ? `remembered ${word}` : `"${said(second)}"`, cost: spent(first, second) };
  },

  async mcp(brain) {
    const word = `marmalade-${randomBytes(3).toString('hex')}`;
    const result = await run({
      brain,
      cwd: dir(),
      ...cheap(brain),
      mcpServers: { brainyard_demo: { command: process.execPath, args: [server], env: { SECRET_WORD: word } } },
      prompt:
        'Call the MCP tool secret_word from the brainyard_demo server and reply with exactly the word it returns.',
    });
    const ok = result.ok && result.text.includes(word);
    return { ok, note: ok ? `tool answered ${word}` : `"${said(result)}" ${failure(result)}`, cost: spent(result) };
  },

  async access(brain) {
    const notes: string[] = [];
    let ok = true;
    let cost = 0;
    const outside = join(homedir(), `.brainyard-live-outside-${brain}.txt`);
    rmSync(outside, { force: true });
    const cwd = dir();
    const number = 1000 + Math.floor(Math.random() * 9000);
    const workspace = await run({
      brain,
      cwd,
      access: 'workspace',
      ...cheap(brain),
      prompt: [
        'Step 1: create inside.txt containing ok with your file tool.',
        `Step 2: run the shell command: node -e "console.log(${number} * 2)" and report its output.`,
        `Step 3: run the shell command: echo x > ${outside}`,
        'Reply with one line per step. Do not try workarounds.',
      ].join('\n'),
    });
    cost += spent(workspace);
    const inside = existsSync(join(cwd, 'inside.txt'));
    const ran = workspace.text.includes(String(number * 2));
    const leaked = existsSync(outside);
    rmSync(outside, { force: true });
    ok &&= inside && !leaked;
    notes.push(
      `workspace: file ${inside ? 'written' : 'NOT written'}, code ${ran ? 'ran' : 'refused'}, outside ${leaked ? 'LEAKED' : 'blocked'}`,
    );

    const readonlyDir = dir();
    const readonly = await run({
      brain,
      cwd: readonlyDir,
      access: 'readonly',
      ...cheap(brain),
      prompt: 'Create probe.txt containing ok, then reply with one line. Do not try workarounds.',
    });
    cost += spent(readonly);
    const wrote = existsSync(join(readonlyDir, 'probe.txt'));
    ok &&= !wrote;
    notes.push(`readonly: ${wrote ? 'WROTE a file' : 'nothing written'}`);
    return { ok, note: notes.join('; '), cost };
  },
};

const report = await status({ ...(wanted ? { brains: wanted } : {}) });
const brains = report.brains.filter((b) => b.availability === 'ready').map((b) => b.id);
for (const skipped of report.brains.filter((b) => b.availability !== 'ready')) {
  console.log(`- ${skipped.label}: skipped (${skipped.availability})`);
}
const names = Object.keys(checks).filter((name) => !only || only.has(name));
let total = 0;
let failed = 0;

await Promise.all(
  brains.map(async (brain) => {
    const lines: string[] = [];
    for (const name of names) {
      const started = Date.now();
      let outcome: Outcome;
      try {
        outcome = await (checks[name] as Check)(brain);
      } catch (error) {
        outcome = { ok: false, note: `threw ${(error as Error).message}`.slice(0, 120), cost: 0 };
      }
      total += outcome.cost;
      if (!outcome.ok) failed += 1;
      const seconds = ((Date.now() - started) / 1000).toFixed(0).padStart(3);
      lines.push(`  ${outcome.ok ? '✓' : '✗'} ${name.padEnd(7)} ${seconds}s  ${outcome.note}`);
    }
    console.log(`\n${BRAINS[brain].label}\n${lines.join('\n')}`);
  }),
);

for (const made of dirs) rmSync(made, { recursive: true, force: true });
console.log(
  `\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`} · reported cost $${total.toFixed(4)}`,
);
process.exitCode = failed === 0 ? 0 : 1;
