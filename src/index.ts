/**
 * Brainyard — one API for agentic coding CLIs: Claude Code, Codex and
 * Antigravity.
 *
 * ```ts
 * import { ask, start, status } from '@antondanv/brainyard';
 *
 * const { ready } = await status();
 * const { text } = await ask('codex', 'One-line summary of RFC 9110?');
 *
 * const agent = start({ brain: 'claude', prompt: 'Add a test for utils.ts', cwd: './app' });
 * for await (const event of agent) if (event.feed) console.log(event.summary);
 * const result = await agent.result;
 * ```
 */
export { type AskAllEntry, ask, askAll } from './ask.js';
export { BRAINS, type BrainInfo, brainId, type Capabilities } from './brains/info.js';
export {
  type Catalog,
  CLAUDE_EFFORTS,
  clearCatalogCache,
  type ModelInfo,
  models,
  type Pick,
  parseAgyModels,
  parseCodexModels,
  resolvePick,
} from './catalog.js';
export { estimateCost } from './cost.js';
export { BrainyardError, classifyFailure, findReset } from './errors.js';
export { describeTool, tidyPaths } from './humanize.js';
export { maskEmail, redact } from './redact.js';
export { type AgentRun, continuePrompt, run, start } from './run.js';
export {
  type AuthInfo,
  type Availability,
  type BrainStatus,
  checkBrain,
  type PingResult,
  ping,
  type StatusOptions,
  type StatusReport,
  status,
} from './status.js';
export { EventStream } from './stream.js';
export * from './types.js';
export { VERSION } from './version.js';
