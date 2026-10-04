/** How `brainyard status` and the app describe a CLI: a word for its state and what follows it. */
import type { BrainStatus } from '@antondanv/brainyard';

import type { Paint } from './term.js';

type Colour = 'green' | 'yellow' | 'gray' | 'red';

export const AVAILABILITY: Record<BrainStatus['availability'], [word: string, colour: Colour]> = {
  ready: ['ready', 'green'],
  needs_login: ['sign in', 'yellow'],
  limited: ['limited', 'yellow'],
  unknown: ['unknown', 'yellow'],
  not_installed: ['not installed', 'gray'],
  error: ['error', 'red'],
};

/** After the state word: who is signed in, how the live check went, or what to do. */
export function details(brain: BrainStatus, c: Paint): string {
  const arrow = c.dim('→');
  switch (brain.availability) {
    case 'not_installed':
      return `${arrow} ${brain.fix ?? ''}`;
    case 'needs_login':
      return `not signed in ${arrow} ${brain.fix ?? ''}`;
    case 'limited':
    case 'error':
      return `${brain.ping?.error?.message ?? brain.summary} ${brain.fix ? `${arrow} ${brain.fix}` : ''}`.trim();
    case 'unknown':
      return `sign-in not confirmed${brain.auth.detail ? ` (${brain.auth.detail})` : ''}`;
    default: {
      if (brain.ping?.ok) {
        const cost = brain.ping.costUsd === null ? '' : ` · $${brain.ping.costUsd.toFixed(4)}`;
        return `answered "${brain.ping.text}" in ${(brain.ping.ms / 1000).toFixed(1)}s${cost}${brain.ping.model ? ` · ${brain.ping.model}` : ''}`;
      }
      const how = [brain.auth.method, brain.auth.plan].filter(Boolean).join(', ');
      const parts = [`signed in${how ? ` with ${how}` : ''}${brain.auth.account ? ` as ${brain.auth.account}` : ''}`];
      if (brain.defaultModel) parts.push(`default model ${brain.defaultModel}`);
      if (!how && brain.auth.detail) parts.push(brain.auth.detail);
      return parts.join(' · ');
    }
  }
}
