// The same question to every installed CLI, side by side.
// Run: npx tsx examples/compare.ts "your question"
import { askAll, BRAINS } from '../src/index.js';

const question = process.argv.slice(2).join(' ') || 'What is the single most common cause of flaky tests?';
const entries = await askAll(question);

for (const { brain, result, error } of entries) {
  const label = BRAINS[brain].label;
  if (result) console.log(`\n## ${label} (${(result.durationMs / 1000).toFixed(1)}s)\n${result.text}`);
  else console.log(`\n## ${label}\n(${error?.kind}: ${error?.message})`);
}
