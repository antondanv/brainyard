// One prompt, one answer — from whichever CLI is ready.
// Run: npx tsx examples/ask.ts
// In your project: import { ask, status } from '@antondanv/brainyard';
import { ask, status } from '../src/index.js';

const { ready } = await status();
if (ready.length === 0) throw new Error('no agent CLI is ready: run `npx @antondanv/brainyard status`');

const brain = ready[0] ?? 'claude';
const answer = await ask(brain, 'Explain what a race condition is in two sentences.', { effort: 'low' });

console.log(answer.text);
console.log(`— ${brain} · ${answer.model ?? 'default model'} · ${answer.durationMs} ms`);
