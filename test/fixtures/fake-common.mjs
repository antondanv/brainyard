// Shared plumbing for the fake CLIs: stdin as lines, and a record of how the
// fake was called (argv, cwd, stdin, a few env vars) written on exit.
import { writeFileSync } from 'node:fs';

export function recorder(args) {
  const record = {
    argv: args,
    cwd: process.cwd(),
    stdin: [],
    env: {
      IS_SANDBOX: process.env.IS_SANDBOX ?? null,
      FAKE_EXTRA: process.env.FAKE_EXTRA ?? null,
      CLAUDE_CODE_CHILD_SESSION: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,
      CLAUDE_EFFORT: process.env.CLAUDE_EFFORT ?? null,
    },
  };
  process.on('exit', () => {
    if (process.env.FAKE_RECORD) writeFileSync(process.env.FAKE_RECORD, JSON.stringify(record));
  });
  return record;
}

/** stdin line by line; `next()` resolves to undefined at EOF. */
export function lines(record) {
  const queue = [];
  const waiters = [];
  let buffer = '';
  let ended = false;
  const flush = () => {
    while (waiters.length && (queue.length || ended)) waiters.shift()(queue.length ? queue.shift() : undefined);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let cut = buffer.indexOf('\n');
    while (cut >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      record.stdin.push(line);
      queue.push(line);
      cut = buffer.indexOf('\n');
    }
    flush();
  });
  process.stdin.on('end', () => {
    if (buffer) {
      record.stdin.push(buffer);
      queue.push(buffer);
      buffer = '';
    }
    ended = true;
    flush();
  });
  return {
    next: () =>
      new Promise((resolve) => {
        waiters.push(resolve);
        flush();
      }),
    /** Everything until EOF, as one text. */
    all: async function () {
      const parts = [];
      for (;;) {
        const line = await this.next();
        if (line === undefined) return parts.join('\n');
        parts.push(line);
      }
    },
  };
}
