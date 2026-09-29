#!/usr/bin/env node
// A minimal MCP server over stdio, with no dependencies: newline-delimited
// JSON-RPC, one tool. Enough to see an agent call your own tool:
//
//   brainyard run claude --mcp examples/mcp.json "Call secret_word and tell me the word"
//
// The word is only known to this process, so an agent that answers it
// really called the tool.
import { createInterface } from 'node:readline';

const WORD = process.env.SECRET_WORD ?? 'marmalade-42';

const tools = [
  {
    name: 'secret_word',
    description: 'Returns the secret word of the day. Call it when asked for the secret word.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function call(name, args) {
  if (name === 'secret_word') return { content: [{ type: 'text', text: WORD }] };
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(args?.a) + Number(args?.b)) }] };
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications need no answer
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'brainyard-example', version: '1.0.0' },
      });
      break;
    case 'ping':
      reply(id, {});
      break;
    case 'tools/list':
      reply(id, { tools });
      break;
    case 'tools/call':
      reply(id, call(params?.name, params?.arguments));
      break;
    default:
      fail(id, -32601, `method not found: ${method}`);
  }
});
