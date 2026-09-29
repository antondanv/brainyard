// Change an agent's course while it works. Claude Code and Antigravity take
// messages mid-run; for Codex `agent.steerable` is false and `hint()` says so.
// Run: npx tsx examples/steer.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '../src/index.js';

const agent = start({
  brain: 'antigravity',
  cwd: mkdtempSync(join(tmpdir(), 'brainyard-example-')),
  prompt: 'Create notes.md with three facts about octopuses, then reply with a one-line summary.',
});

let steered = false;
for await (const event of agent) {
  if (event.feed) console.log(`${event.kind.padEnd(11)} ${event.summary}`);
  if (!steered && event.kind === 'file_write') {
    steered = agent.hint('Also add a fourth fact about their blood colour, and mention it in the summary.');
  }
}
console.log((await agent.result).text);
