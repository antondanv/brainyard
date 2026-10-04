/**
 * `brainyard sessions` and `brainyard stop`: the sessions of a folder, what
 * runs on this machine right now, and stopping a Claude Code background
 * session — its conversation stays.
 */
import {
  BRAIN_IDS,
  BRAINS,
  type BrainId,
  clip,
  listPanes,
  liveSessions,
  type SessionInfo,
  sessions,
  stopSession,
  tidyPaths,
} from '@antondanv/brainyard';

import { brainArg, countArg, Failure, parse, UsageError } from './args.js';
import { ago, cwdFlag, shortPath } from './format.js';
import { withSessions } from './panes.js';
import { type Paint, pad, paint } from './term.js';

const out = paint(process.stdout);
const err = paint(process.stderr);

const time = (session: SessionInfo) => Date.parse(session.updatedAt ?? session.startedAt ?? '') || 0;

/** At most `limit` sessions of each CLI, newest first, as `sessions()` keeps them. */
function newestPerBrain(list: readonly SessionInfo[], limit: number): SessionInfo[] {
  const seen = new Map<BrainId, number>();
  return [...list]
    .sort((a, b) => time(b) - time(a))
    .filter((session) => {
      const count = (seen.get(session.brain) ?? 0) + 1;
      seen.set(session.brain, count);
      return count <= limit;
    });
}

function state(session: SessionInfo, c: Paint): string {
  const live = session.live;
  if (!live) return '';
  if (live.status === 'busy') return c.cyan(' ● working');
  if (live.status === 'waiting') return c.yellow(` ● waiting${live.waitingFor ? `: ${live.waitingFor}` : ''}`);
  // A background session that has finished (`--live --all`) says how it ended.
  if (live.kind === 'background' && live.state && live.state !== 'working') return c.dim(` ● ${live.state}`);
  return c.green(' ● open');
}

/**
 * One line per session: CLI, id, age, folder (in machine-wide lists),
 * title, then what it does now and the pane it runs in.
 */
export function sessionLines(
  list: readonly SessionInfo[],
  c: Paint,
  options: { folders?: boolean; panes?: ReadonlyMap<string, string>; now?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const folders = list.map((session) => (session.cwd ? shortPath(tidyPaths(session.cwd), 40) : '?'));
  const folderWidth = Math.max(0, ...folders.map((folder) => folder.length));
  return list.map((session, index) => {
    const when = session.updatedAt ?? session.startedAt;
    const age = when ? ago(Date.parse(when), now) : '';
    const folder = options.folders ? `${pad(c.dim(folders[index] ?? ''), folderWidth)}  ` : '';
    const title = session.title ? clip(session.title, 72) : c.dim('(untitled)');
    const tags = [session.background ? 'bg' : '', session.interactive ? '' : 'headless']
      .filter(Boolean)
      .map((tag) => c.dim(` ${tag}`))
      .join('');
    const pane = options.panes?.get(session.id);
    return `${pad(BRAINS[session.brain].label, 12)} ${c.dim(session.id.slice(0, 8))}  ${pad(age, 8)} ${folder}${title}${tags}${state(session, c)}${pane ? c.dim(` ▣ ${pane}`) : ''}`;
  });
}

export async function sessionsCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    cwd: { type: 'string' },
    headless: { type: 'boolean' },
    limit: { type: 'string' },
    live: { type: 'boolean' },
    all: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  if (values.all && !values.live) {
    throw new UsageError('--all adds finished background sessions to --live: use the two together');
  }
  const brains = positionals.length > 0 ? positionals.map((value) => brainArg(value)) : [...BRAIN_IDS];
  const limit = values.limit === undefined ? 20 : countArg('--limit', values.limit);
  let list: SessionInfo[];
  if (values.live) {
    const running = await liveSessions({
      brains,
      ...(values.cwd ? { cwd: values.cwd } : {}),
      ...(values.all ? { all: true } : {}),
      // Codex shows some approval dialogs only on screen: look at Brainyard's panes too.
      panes: {},
    });
    // A headless run is not a session to come back to, as in `sessions()`.
    list = newestPerBrain(
      running.filter((session) => values.headless || session.interactive),
      limit,
    );
  } else {
    list = await sessions({ cwd: values.cwd ?? process.cwd(), brains, headless: values.headless === true, limit });
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  if (list.length === 0) {
    const none = values.live
      ? `nothing runs${values.cwd ? ' in this folder' : ''} right now`
      : 'no sessions in this folder yet';
    process.stdout.write(`${out.dim(none)}\n`);
    return 0;
  }
  const panes = new Map<string, string>();
  for (const pane of await withSessions(await listPanes())) if (pane.sessionId) panes.set(pane.sessionId, pane.pane);
  process.stdout.write(`${sessionLines(list, out, { folders: values.live === true, panes }).join('\n')}\n`);
  return 0;
}

export async function stopCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { cwd: { type: 'string' } });
  const [ref, ...extra] = positionals;
  if (!ref) throw new UsageError('name the session to stop: brainyard sessions --live lists them');
  if (extra.length > 0) throw new UsageError(`unexpected: ${extra.join(' ')}`);
  const running = await liveSessions({ brains: ['claude'] });
  const exact = running.filter((session) => session.id === ref);
  const found = exact.length > 0 ? exact : running.filter((s) => s.id.startsWith(ref) || s.live?.shortId === ref);
  if (found.length === 0) {
    throw new Failure(`no running Claude Code session is ${ref}`, 'brainyard sessions --live lists what runs');
  }
  if (found.length > 1) {
    throw new UsageError(`"${ref}" fits ${found.length} sessions: ${found.map((s) => s.id.slice(0, 8)).join(', ')}`);
  }
  const session = found[0]!;
  if (session.live?.kind !== 'background') {
    const pane = (await listPanes()).find((info) => info.sessionId === session.id);
    throw new Failure(
      `${session.id.slice(0, 8)} is open in a terminal, not in the background`,
      pane ? `it runs in a pane: brainyard pane close ${pane.pane}` : 'leave it where it runs (/exit)',
    );
  }
  // The person named the session: its own folder is the one it belongs to.
  const cwd = values.cwd ?? session.cwd ?? process.cwd();
  const result = await stopSession({ brain: 'claude', sessionId: session.id, cwd });
  if (result === 'not-running') throw new Failure(`${session.id.slice(0, 8)} has already stopped`);
  process.stderr.write(
    `stopped ${session.id} ${err.dim(`· open it again: brainyard open claude${cwdFlag(cwd)} --resume ${session.id}`)}\n`,
  );
  return 0;
}
