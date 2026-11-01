import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Supplement a dedicated secret scanner; print locations/categories, not data.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const paths = git('ls-files', '-z').split('\0').filter(Boolean);
assert.ok(paths.includes('LICENSE') && paths.includes('README.md'), 'Stage the intended release before scanning');
const forbiddenPath = /(^|\/)(?:\.vercel|node_modules|dist|artifacts|private|secrets)\/|(?:^|\/)\.env(?!\.example$)|\.local\.json$|\.(?:pem|key|enc)$|^config\/accounts\.json$|^(?:BRIDGE_STATE_KEY|BRIDGE_JWKS|BRIDGE_OWNER_HASH|CRON_SECRET|OWNER_PASSWORD|FEISHU_ACCOUNTS_JSON|BRIDGE_OWNER_ID)$/;
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|ntn_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ['jwt-literal', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
  ['private-workstation-path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['credential-manager-reference', /op:\/\//],
  ['private-notes-or-chat', /https:\/\/(?:app\.notion\.com|www\.notion\.so|chatgpt\.com\/c\/)/],
];
const findings = [];
const instanceUrl = /https:\/\/[a-z0-9-]+\.(?:vercel\.app|workers\.dev)/;
function inspect(name, content) {
  for (const [kind, pattern] of patterns) if (pattern.test(content)) findings.push({ file: name, kind });
}
for (const name of paths) {
  if (forbiddenPath.test(name)) findings.push({ file: name, kind: 'private-file' });
  const content = readFileSync(name, 'utf8');
  inspect(name, content);
  if (instanceUrl.test(content)) findings.push({ file: name, kind: 'instance-url' });
  if (name.endsWith('.md')) for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!existsSync(resolve(dirname(name), target))) findings.push({ file: name, kind: 'broken-relative-link' });
  }
}
let historical = 0;
if (spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' }).status === 0) {
  const objects = git('rev-list', '--objects', '--all').trim().split('\n').filter(Boolean);
  for (const line of objects) {
    const [oid, ...name] = line.split(' ');
    if (git('cat-file', '-t', oid).trim() !== 'blob') continue;
    historical++;
    const path = name.join(' ');
    if (forbiddenPath.test(path)) findings.push({ file: path, kind: 'private-file-in-history' });
    inspect(`history:${oid.slice(0, 8)}:${path}`, git('cat-file', 'blob', oid));
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.equal(pkg.name, 'larksmith');
assert.equal(pkg.name, lock.name);
assert.equal(pkg.name, lock.packages[''].name);
const product = readFileSync('src/product.ts', 'utf8');
assert.ok(product.includes(`PRODUCT_NAME = '${pkg.name}'`));
assert.ok(product.includes(`PRODUCT_VERSION = '${pkg.version}'`));
assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
assert.deepEqual(pkg.devDependencies, lock.packages[''].devDependencies);
assert.equal(pkg.license, 'MIT');
assert.ok(existsSync('licenses/lark-cli-MIT.txt'));
if (findings.length) { console.error(JSON.stringify({ ok: false, findings }, null, 2)); process.exitCode = 1; }
else console.log(JSON.stringify({ ok: true, trackedFiles: paths.length, historicalBlobs: historical, note: 'Source identity checks, historical credential patterns and links passed; also run a dedicated secret scanner and human review before publication.' }));
