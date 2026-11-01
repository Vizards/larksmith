import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHelp } from '../dist/src/cli-metadata.js';
import { unavailable } from '../dist/src/commands.js';

const command = ['test', '+example'];
const help = risk => `Synthetic command\n\n${risk}\n\nUsage:\n  lark-cli test +example [flags]\n\nFlags:\n      --as string   identity type: user | bot\n`;

test('risk labels accept explanatory parentheses and horizontal whitespace', () => {
  for (const risk of ['read', 'write', 'high-risk-write']) {
    for (const label of [`Risk: ${risk}`, `Risk: ${risk} (requires confirmation (see --yes))`, ` \tRisk \t:\t ${risk} (details) \t\r`]) {
      assert.equal(parseHelp(command, help(label)).risk, risk, label);
    }
  }
});

test('schema and help reconcile known risks while either missing source can use the other', () => {
  for (const risk of ['read', 'write', 'high-risk-write']) {
    assert.equal(parseHelp(command, help(''), risk).risk, risk);
    assert.equal(parseHelp(command, help(`Risk: ${risk}`), risk).risk, risk);
    assert.equal(parseHelp(command, help(`Risk: ${risk} (details)`), risk).risk, risk);
    for (const other of ['read', 'write', 'high-risk-write'].filter(other => other !== risk)) {
      const entry = parseHelp(command, help(`Risk: ${other}`), risk);
      assert.equal(entry.risk, null);
      assert.equal(unavailable(entry), 'upstream_risk_unannotated');
    }
  }
  assert.equal(parseHelp(command, help('')).risk, null);
});

test('unknown, malformed and duplicate risk declarations remain unavailable even with a known schema risk', () => {
  for (const label of ['Risk: unknown', 'Risk:', 'Risk:\nread', 'Risk: read-extra', 'Risk: read or write', 'Risk: high-risk-write (unfinished', 'Risk: read\nRisk: write', 'Risk: read\nRisk: read']) {
    for (const schemaRisk of [undefined, 'read', 'high-risk-write']) {
      const entry = parseHelp(command, help(label), schemaRisk);
      assert.equal(entry.risk, null, label);
      assert.equal(unavailable(entry), 'upstream_risk_unannotated');
    }
  }
  for (const schemaRisk of ['unknown', '', ' read ', null, false, 1, {}, []]) {
    assert.equal(parseHelp(command, help('Risk: read'), schemaRisk).risk, null);
  }
});
