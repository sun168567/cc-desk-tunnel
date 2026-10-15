import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.CODEX_HOME;
if (home) appendFileSync(join(home, 'launches'), 'x');
process.exit(1);
