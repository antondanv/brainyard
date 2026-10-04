// OpenCode's store as the real CLI keeps it (`~/.local/share/opencode/opencode.db`),
// reduced to the columns Brainyard reads. Shared by the fake CLI and the tests.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The rules `opencode run` gives its sessions; a session opened in the TUI has none. */
export const RUN_RULES = JSON.stringify([
  { permission: 'question', pattern: '*', action: 'deny' },
  { permission: 'plan_enter', pattern: '*', action: 'deny' },
  { permission: 'plan_exit', pattern: '*', action: 'deny' },
]);

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS session (
    id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
    title text NOT NULL, version text NOT NULL, permission text, time_created integer NOT NULL,
    time_updated integer NOT NULL, time_archived integer, cost real DEFAULT 0 NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS message (
    id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
    data text NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL)`);
  let counter = 0;
  const next = (prefix) => `${prefix}_${String(++counter).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;
  return {
    /** A session; `run: true` marks it as started by `opencode run`. */
    session({ id, directory, title, created, updated, parent = null, run = false, archived = null }) {
      const at = created ?? Date.now();
      db.prepare(
        'INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, permission, time_created, time_updated, time_archived) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        'global',
        parent,
        'fake-slug',
        directory,
        title,
        '1.18.999',
        run ? RUN_RULES : null,
        at,
        updated ?? at,
        archived,
      );
    },
    /** A user message with its text, or an assistant message (`completed: false` while it is being written). */
    message({ session, role, text, at, completed = true }) {
      const id = next('msg');
      const time = at ?? Date.now();
      const data =
        role === 'user'
          ? { role, time: { created: time } }
          : { role, time: completed ? { created: time, completed: time + 1 } : { created: time }, finish: 'stop' };
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
        id,
        session,
        time,
        time,
        JSON.stringify(data),
      );
      if (text !== undefined) {
        db.prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(next('prt'), id, session, time, time, JSON.stringify({ type: 'text', text }));
      }
      return id;
    },
    close() {
      db.close();
    },
  };
}
