import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearFlagCache } from '../src/flags.js';
import { open, planOpen } from '../src/open.js';
import { claudeProjectDir, liveSessions, sessions, stopSession } from '../src/sessions.js';
import { openStore } from './fixtures/opencode-store.mjs';
import { FAKE, recording, tempDir } from './helpers.js';

const lines = (...entries: unknown[]) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

/** A project folder by its real name: the CLIs store resolved paths (`/private/var/…` on macOS). */
function project(): string {
  return realpathSync(tempDir('brainyard-project-'));
}

function claudeStore(home: string, cwd: string, id: string, entries: unknown[]): void {
  const dir = join(home, 'projects', claudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines(...entries));
}

const user = (cwd: string, text: string, entrypoint = 'cli') => ({
  type: 'user',
  entrypoint,
  cwd,
  timestamp: '2026-10-01T10:00:00.000Z',
  message: { role: 'user', content: text },
});

beforeEach(() => {
  clearFlagCache();
});

describe('stopping saved background sessions', () => {
  const id = '5e6f7a8b-0000-4000-8000-000000000001';
  const background = (cwd: string) => ({
    id: '5e6f7a8b',
    sessionId: id,
    kind: 'background',
    status: 'busy',
    state: 'working',
    cwd,
  });

  it('uses the refreshed short id, preserves the transcript and resumes the same conversation', async () => {
    const cwd = project();
    const home = tempDir();
    const rec = recording();
    claudeStore(home, cwd, id, [user(cwd, 'Keep this conversation')]);
    const before = await sessions({ cwd, brains: ['claude'], homes: { claude: home }, live: false });
    const result = await stopSession({
      brain: 'claude',
      sessionId: id,
      cwd,
      command: FAKE.claude,
      env: { FAKE_RECORD: rec.path, FAKE_AGENTS: JSON.stringify([background(cwd)]), CLAUDE_CODE_CHILD_SESSION: '1' },
    });
    expect(result).toBe('stopped');
    expect(rec.read()).toMatchObject({ argv: ['stop', '5e6f7a8b'], cwd, env: { CLAUDE_CODE_CHILD_SESSION: null } });
    expect(await sessions({ cwd, brains: ['claude'], homes: { claude: home }, live: false })).toEqual(before);
    const resumed = await open({ brain: 'claude', resume: id, cwd, command: FAKE.claude, homes: { claude: home } });
    expect(resumed).toMatchObject({ ok: true, sessionId: id, background: false });
  });

  it('does not issue a stop command for a session that already exited', async () => {
    const rec = recording();
    await expect(
      stopSession({
        brain: 'claude',
        sessionId: id,
        cwd: project(),
        command: FAKE.claude,
        env: { FAKE_RECORD: rec.path, FAKE_AGENTS: '[]' },
      }),
    ).resolves.toBe('not-running');
    expect(rec.read().argv).toEqual(['agents', '--json']);
  });

  it.each(['interactive', 'other-folder', 'missing-short-id'])('refuses an invalid target: %s', async (kind) => {
    const cwd = project();
    const rec = recording();
    const target = {
      ...background(kind === 'other-folder' ? project() : cwd),
      ...(kind === 'interactive' ? { kind: 'interactive' } : {}),
      ...(kind === 'missing-short-id' ? { id: '' } : {}),
    };
    await expect(
      stopSession({
        brain: 'claude',
        sessionId: id,
        cwd,
        command: FAKE.claude,
        env: { FAKE_RECORD: rec.path, FAKE_AGENTS: JSON.stringify([target]) },
      }),
    ).rejects.toThrow();
    expect(rec.read().argv).toEqual(['agents', '--json']);
  });

  it('reports a CLI failure without claiming the session stopped', async () => {
    const cwd = project();
    await expect(
      stopSession({
        brain: 'claude',
        sessionId: id,
        cwd,
        command: FAKE.claude,
        env: { FAKE_AGENTS: JSON.stringify([background(cwd)]), FAKE_STOP_EXIT: '1', FAKE_STOP_ERROR: 'stop failed' },
      }),
    ).rejects.toThrow('stop failed');
  });

  it('reports a broken live-session query instead of treating the session as stopped', async () => {
    await expect(
      stopSession({ brain: 'claude', sessionId: id, command: FAKE.claude, env: { FAKE_AGENTS: 'not JSON' } }),
    ).rejects.toThrow('invalid live-session JSON');
  });

  it('does not substitute a process kill for an unsupported CLI', async () => {
    await expect(stopSession({ brain: 'codex', sessionId: id })).rejects.toThrow('only Claude Code');
  });
});

describe('sessions: Claude Code', () => {
  it('reads titles: a name beats the generated title, which beats the first prompt', async () => {
    const cwd = project();
    const home = tempDir();
    claudeStore(home, cwd, 'aaaaaaaa-0000-4000-8000-000000000001', [
      user(cwd, 'Fix the login form'),
      { type: 'ai-title', aiTitle: 'Login form fix' },
      { type: 'custom-title', customTitle: 'factoyard · login' },
    ]);
    claudeStore(home, cwd, 'aaaaaaaa-0000-4000-8000-000000000002', [
      user(cwd, '<command-name>/clear</command-name>'),
      user(cwd, 'Add a test'),
      { type: 'ai-title', aiTitle: 'Test for utils' },
    ]);
    claudeStore(home, cwd, 'aaaaaaaa-0000-4000-8000-000000000003', [user(cwd, 'Just the prompt here')]);

    const list = await sessions({ cwd, brains: ['claude'], homes: { claude: home }, live: false });
    const byId = new Map(list.map((session) => [session.id.slice(-1), session]));
    expect(byId.get('1')).toMatchObject({ title: 'factoyard · login', titleSource: 'name', interactive: true, cwd });
    expect(byId.get('2')).toMatchObject({ title: 'Test for utils', titleSource: 'generated' });
    expect(byId.get('3')).toMatchObject({ title: 'Just the prompt here', titleSource: 'prompt' });
    expect(byId.get('3')?.startedAt).toBe('2026-10-01T10:00:00.000Z');
  });

  it('leaves headless runs out unless asked, and marks background sessions', async () => {
    const cwd = project();
    const home = tempDir();
    claudeStore(home, cwd, 'bbbbbbbb-0000-4000-8000-000000000001', [user(cwd, 'headless', 'sdk-cli')]);
    claudeStore(home, cwd, 'bbbbbbbb-0000-4000-8000-000000000002', [
      user(cwd, 'in the background'),
      { type: 'system', sessionKind: 'bg', cwd },
    ]);
    claudeStore(home, cwd, 'bbbbbbbb-0000-4000-8000-000000000003', [{ type: 'permission-mode', permissionMode: 'x' }]);

    const people = await sessions({ cwd, brains: ['claude'], homes: { claude: home }, live: false });
    expect(people.map((session) => session.id.slice(-1))).toEqual(['2']);
    expect(people[0]?.background).toBe(true);

    const all = await sessions({ cwd, brains: ['claude'], homes: { claude: home }, live: false, headless: true });
    expect(all.map((session) => session.id.slice(-1)).sort()).toEqual(['1', '2']);
  });

  it('attaches live state from agent view and adds running sessions not on disk yet', async () => {
    const cwd = project();
    const home = tempDir();
    claudeStore(home, cwd, 'cccccccc-0000-4000-8000-000000000001', [user(cwd, 'working on it')]);
    const folder = cwd
      .split('/')
      .pop()!
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const agents = [
      {
        pid: 1,
        cwd,
        kind: 'interactive',
        sessionId: 'cccccccc-0000-4000-8000-000000000001',
        name: `${folder}-3f`,
        status: 'waiting',
        waitingFor: 'input needed',
      },
      {
        pid: 2,
        id: 'dddddddd',
        cwd,
        kind: 'background',
        sessionId: 'dddddddd-0000-4000-8000-000000000002',
        name: 'tree · deploy',
        status: 'busy',
        state: 'working',
        startedAt: 1790884806020,
      },
      {
        pid: 3,
        cwd: '/somewhere/else',
        kind: 'interactive',
        sessionId: 'eeeeeeee-0000-4000-8000-000000000003',
        name: 'other',
        status: 'idle',
      },
    ];
    const env = { ...process.env, FAKE_AGENTS: JSON.stringify(agents) };

    const live = await liveSessions({ cwd, brains: ['claude'], command: FAKE.claude, env });
    expect(live.map((session) => session.id.slice(0, 8))).toEqual(['cccccccc', 'dddddddd']);
    // `<folder>-3f` is agent view's label for an unnamed session, not a title.
    expect(live[0]?.title).toBeUndefined();
    expect(live[1]).toMatchObject({
      title: 'tree · deploy',
      background: true,
      live: { shortId: 'dddddddd', status: 'busy' },
    });

    const list = await sessions({ cwd, brains: ['claude'], homes: { claude: home }, command: FAKE.claude, env });
    expect(list).toHaveLength(2);
    const stored = list.find((session) => session.id.startsWith('cccccccc'));
    expect(stored).toMatchObject({ title: 'working on it', live: { status: 'waiting', waitingFor: 'input needed' } });
  });

  it('is an empty list when there is no store or no Claude Code', async () => {
    const cwd = project();
    expect(await sessions({ cwd, brains: ['claude'], homes: { claude: tempDir() }, live: false })).toEqual([]);
    expect(await liveSessions({ brains: ['claude'], command: '/nonexistent/claude' })).toEqual([]);
  });
});

describe('sessions: Codex', () => {
  it('reads rollouts of this folder, with thread names or the first typed prompt', async () => {
    const cwd = project();
    const home = tempDir();
    const day = join(home, 'sessions', '2026', '10', '01');
    mkdirSync(day, { recursive: true });
    const rollout = (id: string, extra: Record<string, unknown>, more: unknown[] = []) =>
      writeFileSync(
        join(day, `rollout-2026-10-01T10-00-00-${id}.jsonl`),
        lines(
          {
            timestamp: '2026-10-01T10:00:00.000Z',
            type: 'session_meta',
            payload: { id, timestamp: '2026-10-01T10:00:00.000Z', cwd, base_instructions: 'x'.repeat(5000), ...extra },
          },
          ...more,
        ),
      );
    rollout('019f-named', { source: 'cli' });
    rollout('019f-typed', { source: 'vscode' }, [
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Сделай этап 2' }] },
      },
    ]);
    rollout('019f-exec', { source: 'exec', originator: 'codex_exec' });
    rollout('019f-guard', { source: { subagent: { other: 'guardian' } }, thread_source: 'subagent' });
    writeFileSync(join(home, 'session_index.jsonl'), lines({ id: '019f-named', thread_name: 'Выполнить этап 1' }));

    const list = await sessions({ cwd, brains: ['codex'], homes: { codex: home } });
    const byId = new Map(list.map((session) => [session.id, session]));
    expect([...byId.keys()].sort()).toEqual(['019f-named', '019f-typed']);
    expect(byId.get('019f-named')).toMatchObject({ title: 'Выполнить этап 1', titleSource: 'generated' });
    expect(byId.get('019f-typed')).toMatchObject({ title: 'Сделай этап 2', titleSource: 'prompt' });

    const all = await sessions({ cwd, brains: ['codex'], homes: { codex: home }, headless: true });
    // The guardian thread is nobody's session, headless or not.
    expect(all.map((session) => session.id).sort()).toEqual(['019f-exec', '019f-named', '019f-typed']);
  });
});

describe('live: Codex and Antigravity', () => {
  it('Codex: an open turn is work, an approval request is waiting, a finished turn is nothing', async () => {
    const cwd = project();
    const home = tempDir();
    const day = join(home, 'sessions', '2026', '10', '02');
    mkdirSync(day, { recursive: true });
    const rollout = (id: string, events: string[]) =>
      writeFileSync(
        join(day, `rollout-2026-10-02T10-00-00-${id}.jsonl`),
        lines(
          { type: 'session_meta', payload: { id, cwd, source: 'cli', timestamp: new Date().toISOString() } },
          ...events.map((type) => ({ type: 'event_msg', payload: { type } })),
        ),
      );
    rollout('019f-busy', ['task_started', 'token_count']);
    rollout('019f-asks', ['task_started', 'exec_approval_request']);
    rollout('019f-done', ['task_started', 'task_complete']);
    const live = await liveSessions({ cwd, brains: ['codex'], homes: { codex: home } });
    const byId = new Map(live.map((session) => [session.id, session.live?.status]));
    expect(byId).toEqual(
      new Map([
        ['019f-busy', 'busy'],
        ['019f-asks', 'waiting'],
      ]),
    );
  });

  it('Antigravity: the status in its summaries database', async () => {
    const cwd = project();
    const home = tempDir();
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const db = new DatabaseSync(join(home, 'conversation_summaries.db'));
    db.exec(
      'CREATE TABLE conversation_summaries (conversation_id text, title text, workspace_uris text, status text, ' +
        'not_fully_idle numeric, killed numeric, last_modified_time datetime, last_user_input_time datetime)',
    );
    const uri = JSON.stringify([`file://${cwd}`]).replace(/'/g, "''");
    db.exec(
      `INSERT INTO conversation_summaries VALUES ('run', 'Работает', '${uri}', 'CASCADE_RUN_STATUS_RUNNING', 0, 0, datetime('now'), datetime('now')),` +
        `('idle', 'Спит', '${uri}', 'CASCADE_RUN_STATUS_IDLE', 0, 0, datetime('now'), datetime('now')),` +
        `('asks', 'Ждёт', '${uri}', 'CASCADE_RUN_STATUS_WAITING_FOR_USER', 0, 0, datetime('now'), datetime('now'))`,
    );
    db.close();
    const live = await liveSessions({ cwd, brains: ['antigravity'], homes: { antigravity: home } });
    const byId = new Map(live.map((session) => [session.id, session.live?.status]));
    expect(byId).toEqual(
      new Map([
        ['run', 'busy'],
        ['asks', 'waiting'],
      ]),
    );
  });
});

describe('sessions: Antigravity', () => {
  it('groups history lines by conversation', async () => {
    const cwd = project();
    const home = tempDir();
    writeFileSync(
      join(home, 'history.jsonl'),
      lines(
        { display: 'first prompt, no id yet', timestamp: 1790000000000, workspace: cwd },
        { display: 'Собери сайт', timestamp: 1790000001000, workspace: cwd, conversationId: 'conv-1' },
        { display: 'и задеплой', timestamp: 1790000099000, workspace: cwd, conversationId: 'conv-1' },
        { display: 'elsewhere', timestamp: 1790000002000, workspace: '/other', conversationId: 'conv-2' },
      ),
    );
    const list = await sessions({ cwd, brains: ['antigravity'], homes: { antigravity: home } });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'conv-1', title: 'Собери сайт', titleSource: 'prompt' });
    expect(list[0]?.updatedAt).toBe(new Date(1790000099000).toISOString());
  });
});

describe('sessions: Antigravity without a workspace in its database', () => {
  it('finds the folder in the run log', async () => {
    const cwd = project();
    const home = tempDir();
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const db = new DatabaseSync(join(home, 'conversation_summaries.db'));
    db.exec(
      'CREATE TABLE conversation_summaries (conversation_id text, title text, workspace_uris text, status text, ' +
        'not_fully_idle numeric, killed numeric, last_modified_time datetime, last_user_input_time datetime)',
    );
    db.exec(
      "INSERT INTO conversation_summaries VALUES ('aa11bb22-0000-4000-8000-000000000001', 'Здесь', '', 'CASCADE_RUN_STATUS_IDLE', 0, 0, datetime('now'), datetime('now'))," +
        "('aa11bb22-0000-4000-8000-000000000002', 'Не здесь', '', 'CASCADE_RUN_STATUS_RUNNING', 0, 0, datetime('now'), datetime('now'))",
    );
    db.close();
    mkdirSync(join(home, 'log'));
    writeFileSync(
      join(home, 'log', 'cli-20261003_233502.log'),
      `I1003 23:35:02.826984 1 server.go:323] Creating CLI server backend: product=antigravity workspaceDirs=[${cwd}] appDataDir=${home}\n` +
        'I1003 23:35:07.165237 411 server.go:1263] Created conversation aa11bb22-0000-4000-8000-000000000001\n',
    );
    writeFileSync(
      join(home, 'log', 'cli-20261003_233610.log'),
      'I1003 23:36:10.000000 1 server.go:323] Creating CLI server backend: product=antigravity workspaceDirs=[/other] appDataDir=x\n' +
        'I1003 23:36:12.000000 411 server.go:3133] GetConversationDetail: found conversation aa11bb22-0000-4000-8000-000000000002 (active=true)\n',
    );
    const list = await sessions({ cwd, brains: ['antigravity'], homes: { antigravity: home } });
    expect(list.map((session) => [session.id, session.cwd])).toEqual([['aa11bb22-0000-4000-8000-000000000001', cwd]]);
    const live = await liveSessions({ brains: ['antigravity'], homes: { antigravity: home } });
    expect(live.map((session) => [session.id, session.cwd])).toEqual([
      ['aa11bb22-0000-4000-8000-000000000002', '/other'],
    ]);
  });
});

describe('sessions: OpenCode', () => {
  it("reads its database: the folder's own sessions, the first prompt until a title is generated", async () => {
    const cwd = project();
    const home = tempDir();
    const store = openStore(join(home, 'opencode.db'));
    store.session({
      id: 'ses_named',
      directory: cwd,
      title: 'Анализ проекта',
      created: 1790000000000,
      updated: 1790000500000,
    });
    store.session({
      id: 'ses_fresh',
      directory: cwd,
      title: 'New session - 2026-10-04T10:00:00.000Z',
      created: 1790000600000,
    });
    store.message({ session: 'ses_fresh', role: 'user', text: 'Собери сайт\nи задеплой', at: 1790000600001 });
    store.session({ id: 'ses_child', directory: cwd, title: 'Explore (@explore subagent)', parent: 'ses_named' });
    store.session({ id: 'ses_archived', directory: cwd, title: 'Убран', archived: 1790000000001 });
    store.session({ id: 'ses_run', directory: cwd, title: 'fix it', run: true });
    store.session({ id: 'ses_other', directory: '/elsewhere', title: 'Не здесь' });
    store.close();
    const options = { cwd, brains: ['opencode'], homes: { opencode: home }, live: false };
    const list = await sessions(options);
    expect(list.map((s) => [s.id, s.title, s.titleSource, s.interactive])).toEqual([
      ['ses_fresh', 'Собери сайт и задеплой', 'prompt', true],
      ['ses_named', 'Анализ проекта', 'generated', true],
    ]);
    expect(list[1]).toMatchObject({
      cwd,
      startedAt: new Date(1790000000000).toISOString(),
      updatedAt: new Date(1790000500000).toISOString(),
    });
    // `opencode run` sessions are headless: listed only when asked for.
    const all = await sessions({ ...options, headless: true });
    expect(all.find((s) => s.id === 'ses_run')).toMatchObject({ interactive: false, title: 'fix it' });
  });

  it('live: an answer still being written is work, a finished or abandoned one is not', async () => {
    const cwd = project();
    const home = tempDir();
    const now = Date.now();
    const store = openStore(join(home, 'opencode.db'));
    for (const [id, completed, at] of [
      ['ses_busy', false, now],
      ['ses_idle', true, now],
      ['ses_abandoned', false, now - 3_600_000],
    ] as const) {
      store.session({ id, directory: cwd, title: id, created: at - 5000, updated: at });
      store.message({ session: id, role: 'user', text: 'go', at: at - 4000 });
      store.message({ session: id, role: 'assistant', at: at - 3000, completed });
    }
    store.session({ id: 'ses_asked', directory: cwd, title: 'asked', created: now - 100, updated: now });
    store.message({ session: 'ses_asked', role: 'user', text: 'just sent', at: now - 50 });
    store.session({ id: 'ses_run', directory: cwd, title: 'run', created: now - 100, updated: now, run: true });
    store.message({ session: 'ses_run', role: 'assistant', at: now - 50, completed: false });
    store.close();
    const live = await liveSessions({ cwd, brains: ['opencode'], homes: { opencode: home } });
    expect(new Map(live.map((s) => [s.id, s.live?.status]))).toEqual(
      new Map([
        ['ses_busy', 'busy'],
        ['ses_asked', 'busy'],
        ['ses_run', 'busy'],
      ]),
    );
    // A headless run at work is still not a session to come back to.
    const list = await sessions({ cwd, brains: ['opencode'], homes: { opencode: home } });
    expect(
      list
        .filter((s) => s.live)
        .map((s) => s.id)
        .sort(),
    ).toEqual(['ses_asked', 'ses_busy']);
    const withRuns = await sessions({ cwd, brains: ['opencode'], homes: { opencode: home }, headless: true });
    expect(withRuns.find((s) => s.id === 'ses_run')?.live?.status).toBe('busy');
  });

  it('is an empty list when there is no database', async () => {
    expect(await sessions({ cwd: project(), brains: ['opencode'], homes: { opencode: tempDir() } })).toEqual([]);
  });
});

describe('planOpen', () => {
  it('Claude Code: session id up front, a name, instructions in the system prompt, the prompt after --', async () => {
    const cwd = project();
    const plan = await planOpen({
      brain: 'claude',
      cwd,
      prompt: '---starts with dashes',
      system: 'You work on node k3f9.',
      name: 'factoyard · Медиа-цех',
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
      command: FAKE.claude,
    });
    expect(plan.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.args).toEqual([
      '--session-id',
      plan.sessionId,
      '--name',
      'factoyard · Медиа-цех',
      '--append-system-prompt',
      'You work on node k3f9.',
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'plan',
      '--',
      '---starts with dashes',
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('Claude Code: an older CLI gets the instructions in the message and says what it could not do', async () => {
    // The flag probe reads `--help` with our own environment.
    process.env.FAKE_OLD = '1';
    try {
      const plan = await planOpen({
        brain: 'claude',
        cwd: project(),
        prompt: 'go',
        system: 'Context.',
        name: 'x',
        command: FAKE.claude,
      });
      expect(plan.args).toEqual(['--', 'Context.\n\ngo']);
      expect(plan.sessionId).toBeUndefined();
      expect(plan.warnings).toHaveLength(2);
    } finally {
      delete process.env.FAKE_OLD;
    }
  });

  it('Claude Code: resume and background', async () => {
    const cwd = project();
    const resumed = await planOpen({
      brain: 'claude',
      cwd,
      resume: 'abc-123',
      system: 'ignored',
      command: FAKE.claude,
    });
    expect(resumed.args).toEqual(['--resume', 'abc-123']);
    expect(resumed.sessionId).toBe('abc-123');
    expect(resumed.warnings).toHaveLength(1);

    const bg = await planOpen({
      brain: 'claude',
      cwd,
      prompt: 'go',
      name: 'n',
      background: true,
      command: FAKE.claude,
    });
    expect(bg.args).toEqual(['--name', 'n', '--bg', '--', 'go']);
    expect(bg.sessionId).toBeUndefined();
    expect(bg.background).toBe(true);
  });

  it('Codex: resume subcommand, instructions in front of the prompt, no names', async () => {
    const cwd = project();
    const plan = await planOpen({
      brain: 'codex',
      cwd,
      resume: '019f-x',
      prompt: 'continue',
      system: 'Node k3f9.',
      name: 'ignored',
      model: 'gpt-x',
      effort: 'high',
      command: FAKE.codex,
    });
    expect(plan.args).toEqual([
      'resume',
      '019f-x',
      '-m',
      'gpt-x',
      '-c',
      'model_reasoning_effort="high"',
      '--',
      'Node k3f9.\n\ncontinue',
    ]);
    expect(plan.warnings.join(' ')).toMatch(/names/);
    await expect(planOpen({ brain: 'codex', cwd, background: true, command: FAKE.codex })).rejects.toThrow(
      /background/,
    );
  });

  it('Antigravity: conversation, mode and the prompt bound to its flag', async () => {
    const plan = await planOpen({
      brain: 'agy',
      cwd: project(),
      resume: 'conv-1',
      prompt: '-dash',
      permissionMode: 'acceptEdits',
      command: FAKE.antigravity,
    });
    expect(plan.args).toEqual(['--conversation', 'conv-1', '--mode', 'accept-edits', '--prompt-interactive=-dash']);
  });

  it('Antigravity: bypassPermissions approves every tool', async () => {
    const plan = await planOpen({
      brain: 'antigravity',
      cwd: project(),
      resume: 'conv-1',
      permissionMode: 'bypassPermissions',
      command: FAKE.antigravity,
    });
    expect(plan.args).toEqual(['--conversation', 'conv-1', '--dangerously-skip-permissions']);
    expect(plan.warnings).toEqual([]);
  });

  it('OpenCode: model, plan agent, and instructions with the prompt bound to its flag', async () => {
    const plan = await planOpen({
      brain: 'opencode',
      cwd: project(),
      prompt: '---starts with dashes',
      system: 'You work on node k3f9.',
      model: 'sber/GigaChat-3-Pro',
      permissionMode: 'plan',
      command: FAKE.opencode,
    });
    expect(plan.args).toEqual([
      '--model',
      'sber/GigaChat-3-Pro',
      '--agent',
      'plan',
      '--prompt=You work on node k3f9.\n\n---starts with dashes',
    ]);
    expect(plan.sessionId).toBeUndefined();
    expect(plan.warnings).toEqual([]);
  });

  it('OpenCode: resume, bypassPermissions as --auto, and what it cannot do said out loud', async () => {
    const plan = await planOpen({
      brain: 'opencode',
      cwd: project(),
      resume: 'ses_abc',
      name: 'auth refactor',
      effort: 'high',
      worktree: true,
      permissionMode: 'bypassPermissions',
      command: FAKE.opencode,
    });
    expect(plan.args).toEqual(['--session', 'ses_abc', '--auto']);
    expect(plan.sessionId).toBe('ses_abc');
    expect(plan.warnings).toHaveLength(3);
    const odd = await planOpen({
      brain: 'opencode',
      cwd: project(),
      permissionMode: 'dontAsk',
      command: FAKE.opencode,
    });
    expect(odd.warnings[0]).toMatch(/no "dontAsk" mode/);
  });

  it('refuses a folder that does not exist', async () => {
    await expect(planOpen({ brain: 'claude', cwd: '/no/such/folder', command: FAKE.claude })).rejects.toThrow(
      /no such folder/,
    );
  });
});

describe('open', () => {
  it('Claude Code in the terminal: the session id is the one it was given', async () => {
    const cwd = project();
    const rec = recording();
    const result = await open({
      brain: 'claude',
      cwd,
      prompt: 'hi',
      command: FAKE.claude,
      env: { FAKE_RECORD: rec.path },
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const argv = rec.read().argv;
    expect(argv).toContain(result.sessionId);
    expect(argv.slice(-2)).toEqual(['--', 'hi']);
  });

  it('a session opened from inside Claude Code is not its child (it keeps its transcript)', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'p',
      CLAUDE_EFFORT: 'xhigh',
    });
    try {
      const rec = recording();
      await open({ brain: 'claude', cwd: project(), command: FAKE.claude, env: { FAKE_RECORD: rec.path } });
      expect(rec.read().env).toMatchObject({
        CLAUDE_CODE_CHILD_SESSION: null,
        CLAUDE_CODE_SESSION_ID: null,
        CLAUDE_EFFORT: null,
      });
    } finally {
      for (const key of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT'])
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
  });

  it('reports a non-zero exit', async () => {
    const result = await open({ brain: 'claude', cwd: project(), command: FAKE.claude, env: { FAKE_EXIT: '3' } });
    expect(result).toMatchObject({ ok: false, exitCode: 3 });
  });

  it('Claude Code in the background: short id from the output, full id from agent view', async () => {
    const cwd = project();
    const agents = [
      {
        id: '5e6f7a8b',
        cwd,
        kind: 'background',
        sessionId: '5e6f7a8b-1111-4222-8333-444455556666',
        name: 'n',
        status: 'busy',
      },
    ];
    const result = await open({
      brain: 'claude',
      cwd,
      prompt: 'deploy',
      name: 'n',
      background: true,
      command: FAKE.claude,
      env: { FAKE_BG_ID: '5e6f7a8b', FAKE_AGENTS: JSON.stringify(agents) },
    });
    expect(result).toMatchObject({ ok: true, background: true, shortId: '5e6f7a8b', sessionId: agents[0]!.sessionId });
    expect(result.output).toMatch(/backgrounded/);
  });

  it('Claude Code in the background: an untrusted folder is a failure, not a silent zero', async () => {
    const result = await open({
      brain: 'claude',
      cwd: project(),
      prompt: 'x',
      background: true,
      command: FAKE.claude,
      env: { FAKE_SCENARIO: 'untrusted' },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Workspace not trusted/);
  });

  it('Codex: the new session is found in its store after the CLI exits', async () => {
    const cwd = project();
    const home = tempDir();
    const result = await open({
      brain: 'codex',
      cwd,
      prompt: 'Выполни этап 2',
      command: FAKE.codex,
      env: { FAKE_CODEX_HOME: home, FAKE_SESSION_ID: '019f-new-session' },
      homes: { codex: home },
    });
    expect(result).toMatchObject({ ok: true, sessionId: '019f-new-session' });
  });

  it('Antigravity: the new conversation is found in its history', async () => {
    const cwd = project();
    const home = tempDir();
    const result = await open({
      brain: 'antigravity',
      cwd,
      prompt: 'Собери сайт',
      command: FAKE.antigravity,
      env: { FAKE_AGY_HOME: home, FAKE_SESSION_ID: 'conv-new' },
      homes: { antigravity: home },
    });
    expect(result).toMatchObject({ ok: true, sessionId: 'conv-new' });
  });

  it('OpenCode: the new session is found in its database after the TUI exits', async () => {
    const cwd = project();
    const home = tempDir();
    const calls = recording();
    const result = await open({
      brain: 'opencode',
      cwd,
      prompt: 'Собери сайт',
      command: FAKE.opencode,
      env: { FAKE_OPENCODE_HOME: home, FAKE_SESSION_ID: 'ses_fromTui', FAKE_RECORD: calls.path },
      homes: { opencode: home },
    });
    expect(result).toMatchObject({ ok: true, sessionId: 'ses_fromTui' });
    expect(calls.read().argv).toEqual(['--prompt=Собери сайт']);
    const [found] = await sessions({ cwd, brains: ['opencode'], homes: { opencode: home }, live: false });
    expect(found).toMatchObject({ id: 'ses_fromTui', title: 'Собери сайт', titleSource: 'prompt' });
  });

  it('says so when the store has no trace of the session', async () => {
    const result = await open({
      brain: 'codex',
      cwd: project(),
      command: FAKE.codex,
      homes: { codex: tempDir() },
    });
    expect(result.sessionId).toBeUndefined();
    expect(result.warnings.join(' ')).toMatch(/no new Codex session/);
  });
});
