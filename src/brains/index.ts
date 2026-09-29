import type { BrainId } from '../types.js';
import type { Adapter } from './adapter.js';
import { antigravity } from './antigravity.js';
import { claude } from './claude.js';
import { codex } from './codex.js';

export const ADAPTERS: Record<BrainId, Adapter> = { claude, codex, antigravity };

export type { Adapter, Launch, LaunchPlan, Outcome, ParsedEvent, StreamParser } from './adapter.js';
export { BRAINS, type BrainInfo, brainId, type Capabilities } from './info.js';
