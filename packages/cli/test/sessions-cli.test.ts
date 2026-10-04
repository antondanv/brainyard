import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { claudeProjectDir } from '@antondanv/brainyard';
import { describe, expect, it } from 'vitest';

import { recording, tempDir } from '../../brainyard/test/helpers.js';
import { cli, machine } from './run-cli.js';

/** A project folder by its real name, as the CLIs store it (`/private/var/…` on macOS). */
const project = () => realpathSync(tempDir('brainyard-project-'));

/** One session open in a terminal here, one in the background elsewhere, as `claude agents` lists them. */
function running(here: string, elsewhere: string) {
  return [
    {
      id: 'aaaaaaaa',
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      kind: 'interactive',
      status: 'busy',
      cwd: here,
      name: 'tests',
      startedAt: Date.now() - 60_000,
    },
    {
      id: 'bbbbbbbb',
      sessionId: 'bbbbbbbb-0000-4000-8000-000000000002',
      kind: 'background',
      status: 'waiting',
      waitingFor: 'input needed',
      state: 'working',
      cwd: elsewhere,
      name: 'deploy',
    },
  ];
}

describe('brainyard sessions --live', () => {
  it('lists what runs on the whole machine, or in one folder', () => {
    const here = project();
    const agents = running(here, project());
    const env = machine(agents);
    const all = JSON.parse(cli(['sessions', '--live', '--json'], { env }).stdout);
    expect(all.map((session: { id: string }) => session.id.slice(0, 8)).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    const one = JSON.parse(cli(['sessions', '--live', '--cwd', here, '--json'], { env }).stdout);
    expect(one).toEqual([
      expect.objectContaining({
        id: agents[0]!.sessionId,
        cwd: here,
        live: expect.objectContaining({ status: 'busy' }),
      }),
    ]);

    const text = cli(['sessions', '--live'], { env }).stdout;
    expect(text).toMatch(/Claude Code\s+aaaaaaaa\s+now\s+\S+\s+tests ● working/);
    expect(text).toContain('deploy bg ● waiting: input needed');
    expect(cli(['sessions', '--live', '--cwd', tempDir()], { env }).stdout.trim()).toBe(
      'nothing runs in this folder right now',
    );
  });

  it('--all asks Claude Code for finished background sessions too', () => {
    const calls = recording();
    const finished = { ...running(project(), project())[1], status: 'idle', state: 'done' };
    const env = { ...machine([finished]), FAKE_RECORD: calls.path };
    const text = cli(['sessions', '--live', '--all'], { env }).stdout;
    expect(calls.read().argv).toEqual(['agents', '--json', '--all']);
    expect(text).toContain('deploy bg ● done');
  });

  it('takes --all only with --live, and a limit that is a number', () => {
    expect(cli(['sessions', '--all']).code).toBe(2);
    expect(cli(['sessions', '--live', '--limit', '0']).code).toBe(2);
  });

  it('still lists the saved sessions of a folder, with the running ones marked', () => {
    const here = project();
    const [open] = running(here, project());
    const env = machine([{ ...open, id: 'cccccccc', sessionId: 'cccccccc-0000-4000-8000-000000000003' }]);
    const dir = join(env.CLAUDE_CONFIG_DIR!, 'projects', claudeProjectDir(here));
    mkdirSync(dir, { recursive: true });
    const user = { type: 'user', entrypoint: 'cli', cwd: here, timestamp: new Date().toISOString() };
    writeFileSync(
      join(dir, 'cccccccc-0000-4000-8000-000000000003.jsonl'),
      `${JSON.stringify({ ...user, message: { role: 'user', content: 'Plan the CLI' } })}\n`,
    );
    const text = cli(['sessions', '--cwd', here], { env }).stdout;
    expect(text).toMatch(/Claude Code\s+cccccccc\s+now\s+Plan the CLI ● working/);
  });
});

describe('brainyard stop', () => {
  const id = '5e6f7a8b-0000-4000-8000-000000000001';
  const backgroundIn = (cwd: string) => ({
    id: '5e6f7a8b',
    sessionId: id,
    kind: 'background',
    status: 'busy',
    state: 'working',
    cwd,
  });

  it('stops a background session named by its short id or the start of its id', () => {
    const here = project();
    const background = backgroundIn(here);
    const calls = recording();
    const env = { ...machine([background]), FAKE_RECORD: calls.path };
    const stopped = cli(['stop', '5e6f7a8b'], { env });
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(calls.read()).toMatchObject({ argv: ['stop', '5e6f7a8b'], cwd: here });
    expect(stopped.stderr).toContain(`stopped ${id}`);
    expect(stopped.stderr).toContain(`open it again: brainyard open claude --cwd ${here} --resume ${id}`);
    expect(cli(['stop', '5e6f'], { env }).code).toBe(0);
  });

  it('refuses an open session, an unknown one and a name that fits two', () => {
    const here = project();
    const env = machine([
      {
        id: '11111111',
        sessionId: '11111111-0000-4000-8000-000000000001',
        kind: 'interactive',
        status: 'idle',
        cwd: here,
      },
      {
        id: '22222222',
        sessionId: '22220000-0000-4000-8000-000000000002',
        kind: 'background',
        status: 'busy',
        cwd: here,
      },
      {
        id: '22223333',
        sessionId: '22223333-0000-4000-8000-000000000003',
        kind: 'background',
        status: 'busy',
        cwd: here,
      },
    ]);
    const open = cli(['stop', '11111111'], { env });
    expect(open.code).toBe(1);
    expect(open.stderr).toContain('11111111 is open in a terminal, not in the background');
    expect(cli(['stop', 'ffffffff'], { env }).stderr).toContain('no running Claude Code session is ffffffff');
    const two = cli(['stop', '2222'], { env });
    expect(two.code).toBe(2);
    expect(two.stderr).toContain('"2222" fits 2 sessions: 22220000, 22223333');
    expect(cli(['stop'], { env }).code).toBe(2);
  });

  it('reports a failing claude stop', () => {
    const env = { ...machine([backgroundIn(project())]), FAKE_STOP_EXIT: '1', FAKE_STOP_ERROR: 'stop failed' };
    const failed = cli(['stop', '5e6f7a8b'], { env });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('stop failed');
  });
});
