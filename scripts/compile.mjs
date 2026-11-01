import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
mkdirSync('dist/config', { recursive: true });
for (const name of ['cli-version.json', 'cli-catalog.json']) cpSync(`config/${name}`, `dist/config/${name}`);
