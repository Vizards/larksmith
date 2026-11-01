// Load the actual deployment entry outside the repository's package scope.
// A parent package.json must not hide a missing ESM declaration in the function.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkBuild(functionPath) {
  const scratch = await mkdtemp(join(tmpdir(), 'lark-bundle-check-'));
  try {
    for (const entry of ['src', 'config', 'index.mjs', 'package.json']) await cp(join(functionPath, entry), join(scratch, entry), { recursive: true });
    await symlink(resolve(functionPath, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const script = `const app = await import(${JSON.stringify(pathToFileURL(join(scratch, 'index.mjs')).href)}); if (typeof app.default !== 'function') throw new Error('missing handler');`;
    const output = execFileSync(process.execPath, ['--no-experimental-detect-module', '--input-type=module', '-e', script], {
      cwd: scratch, timeout: 30_000, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: scratch },
    });
    assert.equal(output, '');
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
