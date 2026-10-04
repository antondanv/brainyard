import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyFailure, findReset } from '../src/errors.js';
import { clip, describeTool, shortPath, tidyPaths, unDouble } from '../src/humanize.js';
import { maskEmail, redact } from '../src/redact.js';

describe('classifyFailure', () => {
  it('tells a subscription limit from throttling, and keeps the reset time', () => {
    const limit = classifyFailure("API error 429: You've hit your session limit · resets 6:50pm");
    expect(limit).toEqual({ kind: 'usage_limit', retryable: false, resetsAt: '6:50pm' });
    expect(classifyFailure('Too Many Requests')).toEqual({ kind: 'rate_limited', retryable: true });
    expect(classifyFailure('Error 529: overloaded').kind).toBe('rate_limited');
  });

  it('recognises a signed-out CLI', () => {
    expect(classifyFailure('Invalid API key · Please run /login').kind).toBe('not_logged_in');
    expect(classifyFailure('Not logged in').kind).toBe('not_logged_in');
  });

  it('recognises a dropped connection', () => {
    expect(classifyFailure('fetch failed: ECONNRESET').kind).toBe('network');
    expect(classifyFailure('upstream returned 503').kind).toBe('network');
  });

  it('does not read a status code into an unrelated number', () => {
    expect(classifyFailure('processed 4291 files, then crashed').kind).toBe('failed');
  });

  it('finds reset times in the usual phrasings', () => {
    expect(findReset("You've hit your usage limit. Try again at 5:00 PM.")).toBe('5:00 PM');
    expect(findReset('limit · resets 6:50pm (Europe/Moscow)')).toBe('6:50pm (Europe/Moscow)');
    expect(findReset('no time here')).toBeUndefined();
  });
});

describe('redact', () => {
  it('masks keys by shape', () => {
    expect(redact('key sk-ant-api03-abcdefghijklmnopqrstuvwx here')).toBe('key *** here');
    expect(redact('OPENAI sk-proj-abcdefghijklmnopqrstu')).toBe('OPENAI ***');
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('***');
    expect(redact('Authorization: Bearer abcdefghijklmnop.qrstuv')).toBe('Authorization: ***');
  });

  it('masks a Telegram token inside a URL, where there is no word boundary', () => {
    expect(redact('https://api.telegram.org/bot123456789:AAEhBP0av18Pqd8RtaYOqT3KT_Yl8oPTABC/getMe')).toBe(
      'https://api.telegram.org/bot***/getMe',
    );
  });

  it('keeps the host of a connection string and hides the password', () => {
    expect(redact('postgresql://app:s3cr3t-pass@db.local:5432/app')).toBe('postgresql://app:***@db.local:5432/app');
  });

  it('masks named values but leaves prose alone', () => {
    expect(redact('API_KEY=abcd1234efgh5678')).toBe('API_KEY=***');
    expect(redact('token: none')).toBe('token: none');
  });

  it('masks emails to something recognisable', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j******e@example.com');
    expect(maskEmail('ab@example.com')).toBe('a*b@example.com');
  });
});

describe('describeTool', () => {
  const cwd = join(homedir(), 'work', 'app');

  it('names built-in tools of every CLI', () => {
    expect(describeTool('Bash', { command: 'npm test' })).toEqual({ kind: 'command', summary: 'ran: npm test' });
    expect(describeTool('Write', { file_path: join(cwd, 'src/a.ts') }, cwd)).toEqual({
      kind: 'file_write',
      summary: 'wrote src/a.ts',
    });
    expect(describeTool('run_command', { CommandLine: 'ls -la' }).summary).toBe('ran: ls -la');
    expect(describeTool('search_web', { query: 'brainyard' }).summary).toBe('searched the web: brainyard');
    expect(describeTool('TodoWrite', {}).summary).toBe('updated the plan');
  });

  it('names MCP tools by server and tool', () => {
    expect(describeTool('mcp__github__create_issue', {}).summary).toBe('called github: create_issue');
    expect(describeTool('call_mcp_tool', { ServerName: 'docs_docs', ToolName: 'search' }).summary).toBe(
      'called docs: search',
    );
  });

  it('does not invent a phrase for tools it does not know', () => {
    expect(describeTool('FancyNewTool', {}).summary).toBe('used FancyNewTool');
    expect(describeTool('browser_click_element', {}).summary).toBe('used the browser: click element');
  });

  it('falls back to a renamed argument instead of losing it', () => {
    expect(describeTool('Read', { path: 'README.md' }).summary).toBe('read README.md');
  });
});

describe('paths and lines', () => {
  const cwd = join(homedir(), 'work', 'app');

  it('makes paths inside the working directory relative and the home directory ~', () => {
    expect(tidyPaths(`cat ${cwd}/notes.md`, cwd)).toBe('cat notes.md');
    expect(tidyPaths(`cd ${cwd} && ls`, cwd)).toBe('cd . && ls');
    expect(tidyPaths(`${homedir()}/other/file.txt`, cwd)).toBe('~/other/file.txt');
  });

  it('does not mangle a sibling directory that shares a prefix', () => {
    expect(tidyPaths(`${cwd}2/file.txt`, cwd)).toBe('~/work/app2/file.txt');
  });

  it('shortens absolute paths inside the working directory', () => {
    expect(shortPath(join(cwd, 'a', 'b.txt'), cwd)).toBe(join('a', 'b.txt'));
    expect(shortPath('/etc/hosts', cwd)).toBe('/etc/hosts');
  });

  it('clips to one line', () => {
    expect(clip('a\n  b\tc', 100)).toBe('a b c');
    expect(clip('x'.repeat(10), 5)).toBe('xxxx…');
  });

  it('undoes the doubled plugin name Antigravity gives MCP servers', () => {
    expect(unDouble('factory_factory')).toBe('factory');
    expect(unDouble('my_server')).toBe('my_server');
  });
});
