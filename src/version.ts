import { readFileSync } from 'node:fs';

function read(): string {
  // src/ and dist/ both sit one level below package.json.
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = read();
