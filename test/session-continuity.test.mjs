import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { makeOAuth, passwordHash } from '../dist/src/oauth.js';
import { StateDocument } from '../dist/src/state.js';
import { MemoryBackend } from './support/memory-backend.mjs';

test('configured owner subject and encrypted grants remain usable after restart', async () => {
  const master = randomBytes(32).toString('base64url'), backend = new MemoryBackend();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'ES256', use: 'sig' };
  const issuer = 'https://mcp.example.com', ownerId = 'configured-owner';
  const config = { master, issuer, jwks: { keys: [jwk] }, ownerHash: passwordHash('synthetic', 'salt'),
    state: new StateDocument({ master, name: 'oauth', backend, delay: false }) };
  const previous = makeOAuth({ ...config, ownerId });
  await new previous.Adapter('Grant').upsert('retained-grant', { accountId: ownerId, clientId: 'retained-client' }, 3600);
  const token = await new SignJWT({ grant_id: 'retained-grant', client_id: 'retained-client', scope: 'lark:read' })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'synthetic' }).setSubject(ownerId)
    .setIssuer(issuer).setAudience(`${issuer}/mcp`).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const original = process.env.BRIDGE_OWNER_ID;
  try {
    process.env.BRIDGE_OWNER_ID = ownerId;
    const restarted = makeOAuth({ ...config, state: new StateDocument({ master, name: 'oauth', backend, delay: false }) });
    assert.equal((await restarted.verifyAccess(token)).clientId, 'retained-client');
    await assert.rejects(makeOAuth({ ...config, ownerId: 'changed-owner' }).verifyAccess(token));
  } finally {
    if (original === undefined) delete process.env.BRIDGE_OWNER_ID; else process.env.BRIDGE_OWNER_ID = original;
  }
});
