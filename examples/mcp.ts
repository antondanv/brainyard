// Give an agent your own tools for one run, with no config files touched.
// Run: npx tsx examples/mcp.ts [claude|codex|antigravity]
import { fileURLToPath } from 'node:url';

import { run } from '@antondanv/brainyard';

const server = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
const result = await run({
  brain: process.argv[2] ?? 'claude',
  mcpServers: {
    demo: { command: process.execPath, args: [server], env: { SECRET_WORD: 'kumquat-7' } },
  },
  prompt: 'Call the secret_word tool of the demo MCP server and tell me the word.',
});

console.log(result.ok ? result.text : `failed: ${result.error?.message}`);
