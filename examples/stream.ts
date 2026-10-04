// Run an agent in a folder and print what it does as it does it.
// Run: npx tsx examples/stream.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '@antondanv/brainyard';

const cwd = mkdtempSync(join(tmpdir(), 'brainyard-example-'));
const agent = start({
  brain: 'claude',
  cwd,
  access: 'workspace', // edits and commands inside `cwd` only
  prompt: 'Write fizzbuzz.py for 1..15, run it with python3 and summarise the output in one line.',
});

for await (const event of agent) {
  if (event.feed) console.log(`${event.kind.padEnd(11)} ${event.summary}`);
}

const result = await agent.result;
console.log(result.ok ? `\n${result.text}` : `\nfailed: ${result.error?.kind} — ${result.error?.message}`);
console.log(`files are in ${cwd}; continue with resume: '${result.sessionId}'`);
