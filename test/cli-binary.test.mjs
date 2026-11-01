import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { commandArguments } from '../dist/src/commands.js';
import { userEnvironment } from '../dist/src/cli.js';

const execute = promisify(execFile);
const binary = process.env.LARK_TEST_BINARY;
const pin = JSON.parse(await readFile(new URL('../config/cli-version.json', import.meta.url), 'utf8'));

test('pinned binary preserves user-only JSON record reads without credentials or business calls', { skip: !binary }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'larksmith-cli-compat-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, 'config'));
  const env = userEnvironment(scratch, { appId: 'cli_synthetic', accessToken: 'synthetic' });
  const options = { cwd: scratch, env, timeout: 10_000, maxBuffer: 64 * 1024 };
  assert.equal((await execute(binary, ['--version'], options)).stdout.trim(), `lark-cli version ${pin.version}`);
  const common = { 'base-token': 'synthetic', 'table-id': 'tblSynthetic', 'dry-run': true };
  const cases = [
    ['+record-list', {}, data => assert.match(data.api[0].url, /limit=100(?:&|$)/)],
    ['+record-get', { json: { record_id_list: ['recSynthetic'] } }, data => assert.deepEqual(data.api[0].body.record_id_list, ['recSynthetic'])],
    ['+record-search', { json: { keyword: 'Synthetic' } }, data => assert.equal(data.api[0].body.keyword, 'Synthetic')],
  ];
  for (const [name, flags, inspect] of cases) {
    const prepared = commandArguments(['base', name], { ...common, ...flags }, 'read');
    await writeFile(join(scratch, 'config/policy.yml'), prepared.policy, { mode: 0o600 });
    const result = JSON.parse((await execute(binary, prepared.args, options)).stdout);
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(result.identity, 'user');
    inspect(result.data);
  }
  // This must fail before a request even without the bridge's catalog check.
  await rm(join(scratch, 'config/policy.yml'));
  await assert.rejects(execute(binary, ['vc', '+meeting-join', '--meeting-number=123456789', '--as=user', '--json', '--dry-run'], options), error => {
    const result = JSON.parse(error.stderr);
    return result.ok === false && /identity_not_supported/.test(result.error.hint);
  });
  assert.deepEqual(await readdir(scratch), ['config'], 'JSON reads must not produce local NDJSON artifacts');
  assert.deepEqual(await readdir(join(scratch, 'config')), [], 'external user tokens must not create local auth/key state');
});

test('pinned binary accepts confirmed high-risk plans in offline dry-run mode', { skip: !binary }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'larksmith-high-risk-plan-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, 'config'));
  const options = { cwd: scratch, env: userEnvironment(scratch, { appId: 'cli_synthetic', accessToken: 'synthetic' }), timeout: 10_000, maxBuffer: 64 * 1024 };
  for (const [command, flags] of [
    [['calendar', 'calendars', 'delete'], { 'calendar-id': 'synthetic-calendar' }],
    [['application', '+slash-command-delete'], { 'command-id': 'synthetic-command' }],
  ]) {
    const parameters = { ...flags, 'dry-run': true };
    assert.throws(() => commandArguments(command, parameters, 'write'), /explicit_user_confirmation/);
    const prepared = commandArguments(command, parameters, 'write', true);
    assert.ok(prepared.args.includes('--dry-run=true'));
    assert.ok(prepared.args.includes('--yes'));
    await writeFile(join(scratch, 'config/policy.yml'), prepared.policy, { mode: 0o600 });
    const result = JSON.parse((await execute(binary, prepared.args, options)).stdout);
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(result.identity, 'user');
  }
});
