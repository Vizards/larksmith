import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fresh installations only. No secret goes to stdout, shell arguments or logs.
// Exclusive directory creation prevents accidental rotation of an existing set.
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error('Usage: npm run setup -- /private/path/to/new-directory');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rel = relative(root, resolve(directory));
if (!rel || (!rel.startsWith('../') && rel !== '..')) throw new Error('Secrets directory must be outside this project');
await mkdir(resolve(directory), { mode: 0o700 });
const password = randomBytes(32).toString('base64url');
const salt = randomBytes(16).toString('base64url');
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const values = {
  BRIDGE_STATE_KEY: randomBytes(32).toString('base64url'),
  BRIDGE_JWKS: JSON.stringify({ keys: [{ ...privateKey.export({ format: 'jwk' }), kid: randomBytes(12).toString('hex'), alg: 'ES256', use: 'sig' }] }),
  BRIDGE_OWNER_HASH: `${salt}:${scryptSync(password, salt, 32).toString('base64url')}`,
  CRON_SECRET: randomBytes(32).toString('base64url'),
};
for (const [name, value] of Object.entries(values)) await writeFile(join(directory, name), value, { mode: 0o600, flag: 'wx' });
await writeFile(join(directory, 'OWNER_PASSWORD'), password, { mode: 0o600, flag: 'wx' });
console.log('Fresh secrets saved with restricted permissions. Back up in your password manager; upload server fields to Vercel. Never commit this directory.');
