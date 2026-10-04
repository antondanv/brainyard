// npm packs only what is inside a package's folder: the README, the changelog and
// the licence live once at the repository root and are copied in before packing.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
for (const name of ['README.md', 'README.ru.md', 'CHANGELOG.md', 'LICENSE']) {
  copyFileSync(new URL(name, root), join(process.cwd(), name));
}
