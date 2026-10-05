// tsc compiles TypeScript only; the pages are static files next to their server.
import { copyFileSync, mkdirSync } from 'node:fs';

for (const name of ['dashboard.html', 'app.html']) {
  const from = new URL(`../src/ui/${name}`, import.meta.url);
  const to = new URL(`../dist/ui/${name}`, import.meta.url);
  mkdirSync(new URL('.', to), { recursive: true });
  copyFileSync(from, to);
}
