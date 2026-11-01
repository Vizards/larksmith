import assert from 'node:assert/strict';
import handler from '../.vercel/output/functions/api/probe.func/index.mjs';

async function invoke(method = 'GET') {
  let result;
  const response = { statusCode: 200, setHeader() {}, end(body) { result = JSON.parse(body); } };
  await handler({ method }, response);
  return { status: response.statusCode, ...result };
}

(async () => {
  const first = await invoke();
  assert.equal(first.status, 200);
  assert.equal(first.ok, true);
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => invoke()));
  for (const item of concurrent) {
    assert.equal(item.ok, true);
    assert.equal(item.scratchCleaned, true);
  }
  assert.equal(new Set(concurrent.map(x => x.requestId)).size, 4);
  assert.equal((await invoke('POST')).status, 405);
  console.log(JSON.stringify({ initial: first, concurrent: concurrent.length, distinctScratch: true, postRejected: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
