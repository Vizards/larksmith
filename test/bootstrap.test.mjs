import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passwordHash } from '../dist/src/oauth.js';

test('fresh bootstrap writes private files, prints no secrets and refuses overwriting keys', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'larksmith-setup-test-'));
  try {
    const destination = join(scratch, 'secrets');
    const run = () => spawnSync(process.execPath, ['scripts/setup.ts', destination], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    const values = {};
    for (const name of ['BRIDGE_STATE_KEY', 'BRIDGE_JWKS', 'BRIDGE_OWNER_HASH', 'CRON_SECRET', 'OWNER_PASSWORD']) {
      const file = join(destination, name);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      values[name] = await readFile(file, 'utf8');
      assert.equal((first.stdout + first.stderr).includes(values[name]), false);
    }
    assert.equal(Buffer.from(values.BRIDGE_STATE_KEY, 'base64url').length, 32);
    assert.equal(JSON.parse(values.BRIDGE_JWKS).keys[0].alg, 'ES256');
    assert.equal(passwordHash(values.OWNER_PASSWORD, values.BRIDGE_OWNER_HASH.split(':')[0]), values.BRIDGE_OWNER_HASH);
    assert.notEqual(run().status, 0);
    assert.equal(await readFile(join(destination, 'BRIDGE_STATE_KEY'), 'utf8'), values.BRIDGE_STATE_KEY);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
