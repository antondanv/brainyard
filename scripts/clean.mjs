// Removes the previous build so deleted sources never linger in dist/.
// npm runs a workspace's scripts from its own folder, so dist/ is that package's.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

rmSync(join(process.cwd(), 'dist'), { recursive: true, force: true });
