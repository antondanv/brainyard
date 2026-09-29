// tsc compiles TypeScript only; the dashboard page is a static file next to its server.
import { copyFileSync, mkdirSync } from 'node:fs';

const from = new URL('../src/ui/dashboard.html', import.meta.url);
const to = new URL('../dist/ui/dashboard.html', import.meta.url);
mkdirSync(new URL('.', to), { recursive: true });
copyFileSync(from, to);
