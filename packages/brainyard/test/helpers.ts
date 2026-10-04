import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

import type { BrainId } from '../src/types.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Run the fake CLIs with the Node that runs the tests: no shebang, no PATH needed. */
export const FAKE: Record<BrainId, string[]> = {
  claude: [process.execPath, join(fixtures, 'fake-claude.mjs')],
  codex: [process.execPath, join(fixtures, 'fake-codex.mjs')],
  antigravity: [process.execPath, join(fixtures, 'fake-agy.mjs')],
  opencode: [process.execPath, join(fixtures, 'fake-opencode.mjs')],
};

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'brainyard-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export interface Recorded {
  argv: string[];
  cwd: string;
  stdin: string[];
  env: Record<string, string | null>;
}

/** Where a fake writes how it was called, and a reader for it. */
export function recording(): { path: string; read(): Recorded } {
  const path = join(tempDir('brainyard-record-'), 'call.json');
  return {
    path,
    read: () => {
      if (!existsSync(path)) throw new Error('the fake CLI did not record a call');
      return JSON.parse(readFileSync(path, 'utf8')) as Recorded;
    },
  };
}
