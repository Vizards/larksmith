import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createOAuthAdapter, IDLE_SECONDS } from '../dist/src/oauth-state.js';
import { StateDocument } from '../dist/src/state.js';
import { MemoryBackend } from './support/memory-backend.mjs';

const setup = () => {
  let now = 1_000_000;
  const state = new StateDocument({ master: randomBytes(32).toString('base64url'), name: 'oauth', backend: new MemoryBackend(), delay: false });
  const Adapter = createOAuthAdapter(state, () => now);
  return { get now() { return now; }, advance: seconds => { now += seconds; }, adapter: name => new Adapter(name) };
};

test('authorization code cannot be redeemed twice concurrently', async () => {
  const s = setup();
  await s.adapter('Grant').upsert('g', { exp: s.now + IDLE_SECONDS }, IDLE_SECONDS);
  await s.adapter('AuthorizationCode').upsert('c', { grantId: 'g' }, 120);
  const results = await Promise.allSettled([s.adapter('AuthorizationCode').consume('c'), s.adapter('AuthorizationCode').consume('c')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await s.adapter('Grant').find('g'), undefined, 'replay revokes the grant atomically');
});

test('refresh rolls the idle grant window; active connections cross the original expiry', async () => {
  const s = setup();
  await s.adapter('Grant').upsert('g', { exp: s.now + IDLE_SECONDS }, IDLE_SECONDS);
  await s.adapter('RefreshToken').upsert('r1', { grantId: 'g' }, IDLE_SECONDS);
  s.advance(IDLE_SECONDS - 60);
  await s.adapter('RefreshToken').consume('r1');
  await s.adapter('RefreshToken').upsert('r2', { grantId: 'g' }, IDLE_SECONDS);
  s.advance(120);
  assert.ok(await s.adapter('Grant').find('g'));
  assert.ok(await s.adapter('RefreshToken').find('r2'));
  s.advance(IDLE_SECONDS);
  assert.equal(await s.adapter('RefreshToken').find('r2'), undefined);
});

test('revocation prevents a stale in-flight token save from reviving a grant', async () => {
  const s = setup();
  await s.adapter('Grant').upsert('g', {}, IDLE_SECONDS);
  await s.adapter('Grant').destroy('g');
  await assert.rejects(s.adapter('RefreshToken').upsert('late', { grantId: 'g' }, IDLE_SECONDS));
  await assert.rejects(s.adapter('Grant').upsert('g', {}, IDLE_SECONDS));
});

test('dynamic clients survive while transient interactions expire', async () => {
  const s = setup();
  await s.adapter('Client').upsert('client', { client_id: 'client' });
  await s.adapter('Interaction').upsert('login', { uid: 'u' }, 600);
  s.advance(IDLE_SECONDS * 2);
  assert.ok(await s.adapter('Client').find('client'));
  assert.equal(await s.adapter('Interaction').findByUid('u'), undefined);
});
