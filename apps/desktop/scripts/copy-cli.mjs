// Puts the bundled `styx` CLI where the app ships it (resources/cli), on any OS (no `mkdir -p` / `cp` on Windows).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(app, 'resources', 'cli'), { recursive: true });
copyFileSync(
  join(app, '..', '..', 'packages', 'cli', 'dist', 'styx.js'),
  join(app, 'resources', 'cli', 'styx.js'),
);
