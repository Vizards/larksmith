import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

test('patched Zod remains compatible with Vercel config schemas and platform OIDC token input', () => {
  const require = createRequire(import.meta.url);
  const { globalConfigSchema, authConfigSchema } = require('../node_modules/@vercel/cli-config/dist/schema.js');
  assert.equal(globalConfigSchema.parse({ credStorage: 'file', currentTeam: 'synthetic-team' }).currentTeam, 'synthetic-team');
  assert.equal(authConfigSchema.parse({ token: 'synthetic-token', tokenSource: 'env' }).tokenSource, 'env');
  assert.equal(globalConfigSchema.safeParse({ credStorage: 'invalid' }).success, false);
  const { getVercelOidcTokenSync } = require('@vercel/oidc');
  const previous = process.env.VERCEL_OIDC_TOKEN;
  try {
    process.env.VERCEL_OIDC_TOKEN = 'synthetic-platform-oidc';
    assert.equal(getVercelOidcTokenSync(), 'synthetic-platform-oidc');
  } finally {
    if (previous === undefined) delete process.env.VERCEL_OIDC_TOKEN; else process.env.VERCEL_OIDC_TOKEN = previous;
  }
});
