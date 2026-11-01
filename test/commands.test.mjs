import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog, commandArguments } from '../dist/src/commands.js';
import { validateDocumentXml } from '../dist/src/document-input.js';
import { parseHelp } from '../dist/src/cli-metadata.js';

test('generated catalog discovers hundreds of upstream commands without handwritten per-command schemas', () => {
  assert.equal(catalog().totalCatalog, 783);
  const search = catalog({ command: ['drive', '+search'] });
  assert.equal(search.risk, 'read'); assert.ok(search.flags['query']);
  assert.equal(catalog({ command: ['drive', 'files', 'list'] }).schema.type, 'object');
  assert.ok(catalog({ command: ['drive', 'files', 'copy'] }).flags.data);
  assert.ok(catalog({ command: ['docs', '+create'] }).flags['reference-map']);
  assert.ok(catalog({ query: 'calendar', limit: 3 }).nextOffset === 3);
  for (const query of ['mail', 'task', 'base', 'okr']) assert.ok(catalog({ query }).total > 0);
});

test('generic dispatch separates risk and identity, preserves argv values and excludes runtime-management inputs', () => {
  const search = commandArguments(['drive', '+search'], { query: '--as=bot', 'page-size': '10' }, 'read');
  assert.ok(search.args.includes('--query=--as=bot'));
  assert.ok(search.args.includes('--as=user'));
  assert.match(search.policy, /max_risk: read/);
  for (const [command, params, mode] of [[['auth', 'login'], {}, 'write'], [['docs', '+create'], { title: 'test' }, 'read'], [['drive', '+search'], { query: 'test', profile: 'beta' }, 'read'], [['drive', '+upload'], { file: '/tmp/somewhere' }, 'write'], [['docs', '+script'], {}, 'read']]) assert.throws(() => commandArguments(command, params, mode));
  const prepared = commandArguments(['docs', '+create'], { title: 'synthetic', content: '<p>😀 &amp; 中文</p>' }, 'write');
  assert.ok(prepared.args.includes('--content=@./content.xml'));
  assert.equal(catalog({ command: ['drive', '+delete'] }).risk, 'high-risk-write');
  assert.throws(() => commandArguments(['drive', '+delete'], {}, 'write'), /explicit_user_confirmation/);
  assert.ok(commandArguments(['drive', '+delete'], {}, 'write', true).args.includes('--yes'));
  const copied = commandArguments(['drive', 'files', 'copy'], { 'file-token': 'TOKEN', data: { folder_token: 'FOLDER', name: 'test', type: 'docx' } }, 'write');
  assert.ok(copied.args.includes('--data={"folder_token":"FOLDER","name":"test","type":"docx"}'));
});

test('metadata parser separates example prose from flags and retains custom flag types', () => {
  const help = 'Test\n\nUsage:\n  lark-cli test +example [flags]\n\nFlags:\n      --reference-map reference_map   JSON refs\n      --flag                          Boolean switch\n\nTips:\n      --not-a-flag string   this is example text\n\nRisk: write\n';
  const entry = parseHelp(['test', '+example'], help);
  assert.equal(entry.flags['reference-map'].type, 'reference_map');
  assert.equal(entry.flags.flag.type, 'bool');
  assert.equal(entry.flags['not-a-flag'], undefined);
  assert.throws(() => parseHelp(['wrong', '+command'], help));
});

test('business JSON flags survive generic forwarding while local media hidden in content is rejected', () => {
  const prepared = commandArguments(['base', '+form-submit'], { 'share-token': 'SHARE', json: { fields: { Rating: 5 } } }, 'write', true);
  assert.ok(prepared.args.includes('--json={"fields":{"Rating":5}}'));
  assert.equal(prepared.args.includes('--json'), false);
  for (const [command, input] of [
    [['base', '+form-submit'], { json: { fields: {}, attachments: { Attachment: ['./secret'] } } }],
    [['slides', '+create'], { slide: ['<slide><img src="@./config/policy.yml"/></slide>'] }],
    [['slides', '+create'], { slides: '["<slide><img src=\\"@./secret\\"/></slide>"]' }],
    [['mail', '+draft-create'], { body: '<p>Hello<img src="config/policy.yml"></p>' }],
    [['mail', '+draft-create'], { attach: ['config/policy.yml'] }],
    [['im', '+messages-send'], { image: './secret.png' }],
    [['slides', '+create'], { slide: ['  @./secret'] }],
  ]) assert.throws(() => commandArguments(command, input, 'write', true), /(?:file_transport|local_media|local_paths)/, command.join(' '));
  assert.doesNotThrow(() => commandArguments(['slides', '+create'], { slide: ['<slide><img src="EXISTING_MEDIA_TOKEN"/></slide>'] }, 'write'));
});

test('DocxXML transport rejects local reads, remote assets, entity tricks and malformed XML', () => {
  for (const content of ['<p>Hello <b>world</b></p>', '<img src="EXISTING_TOKEN"/>', '<source token="TOKEN" name="报告.pdf"/>', '<a href="https://example.com">Link</a>', '<pre lang="json"><code>{}</code></pre>']) assert.equal(validateDocumentXml(content), content);
  for (const content of ['@/etc/passwd', '<img path="@/proc/self/environ"/>', '<img href="http://169.254.169.254/"/>', '<img src="https://evil.example"/>', '<img p&#97;th="x"/>', '<img path="&#64;/etc/passwd"/>', '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><p>&secret;</p>', '<p>unclosed', '<whiteboard type="svg" path="@./x"/>', '<a href="file:///etc/passwd">x</a>']) assert.throws(() => validateDocumentXml(content), content);
});
