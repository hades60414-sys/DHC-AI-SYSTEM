// node test.cjs — offline checks for the Codex de-identification proxy (no network).
'use strict';
process.env.CODEX_DEID_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'codex-deid-'));
const assert = require('assert');
const { aliasRequest, sseRestorer } = require('./server.cjs');

const SECRETS = ['10.255.0.99', 'user389@example.org', 'A123456789'];
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok', name); };

const body = {
  model: 'gpt-5.6-luna', stream: true,
  input: [
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'shell', description: 'run on host 10.255.0.99', parameters: { type: 'object' } }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: `連 ${SECRETS[0]}，寄給 ${SECRETS[1]}，身分證 ${SECRETS[2]}` }] },
    { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['ping', SECRETS[0]] }) },
    { type: 'function_call_output', call_id: 'c1', output: `Reply from ${SECRETS[0]}: bytes=32` },
    { type: 'reasoning', id: 'r1', encrypted_content: 'SIGNED+BLOB==', summary: [] },
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
  ],
};
const counts = {};
const out = aliasRequest(body, counts);
const sent = JSON.stringify(out);

ok('no secret leaves', () => { for (const s of SECRETS) assert(!sent.includes(s), 'leaked ' + s); });
ok('protocol fields untouched', () => {
  assert.strictEqual(out.input.find((i) => i.type === 'reasoning').encrypted_content, 'SIGNED+BLOB==');
  assert.strictEqual(out.input.find((i) => i.type === 'function_call').name, 'shell');
  assert.strictEqual(out.input.find((i) => i.type === 'function_call').call_id, 'c1');
});
ok('arguments stay valid JSON', () => { JSON.parse(out.input.find((i) => i.type === 'function_call').arguments); });
ok('image held', () => { assert(!sent.includes('data:image')); assert(counts.IMAGE === 1); });
ok('note added', () => assert(/DEID_<KIND>_<number>/.test(sent)));

const ipAlias = /DEID_[A-Z]+_\d+/.exec(out.input.find((i) => i.type === 'function_call_output').output)[0];
const ev = (type, d) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
ok('split alias in text deltas is restored', () => {
  const fix = sseRestorer();
  const cut = 5;
  const stream = ev('response.output_text.delta', { item_id: 'm1', content_index: 0, delta: 'host ' + ipAlias.slice(0, cut) })
    + ev('response.output_text.delta', { item_id: 'm1', content_index: 0, delta: ipAlias.slice(cut) + ' up' })
    + ev('response.output_text.done', { item_id: 'm1', content_index: 0, text: `host ${ipAlias} up` });
  // feed in awkward chunk sizes
  let got = ''; for (let i = 0; i < stream.length; i += 7) got += fix(stream.slice(i, i + 7), false); got += fix('', true);
  const deltas = got.split('\n\n').filter(Boolean).map((e) => JSON.parse(/^data: (.*)$/m.exec(e)[1])).filter((d) => d.type.endsWith('.delta')).map((d) => d.delta).join('');
  assert.strictEqual(deltas, `host ${SECRETS[0]} up`);
  assert(got.includes(`"text":"host ${SECRETS[0]} up"`));
});
ok('tail flushed before .done', () => {
  const fix = sseRestorer();
  const got = fix(ev('response.output_text.delta', { item_id: 'm2', content_index: 0, delta: 'x ' + ipAlias }) + ev('response.output_text.done', { item_id: 'm2', content_index: 0, text: 'x ' + ipAlias }), true);
  const deltas = got.split('\n\n').filter(Boolean).map((e) => JSON.parse(/^data: (.*)$/m.exec(e)[1])).filter((d) => d.type.endsWith('.delta')).map((d) => d.delta).join('');
  assert.strictEqual(deltas, 'x ' + SECRETS[0]);
});
ok('function call arguments restored as JSON', () => {
  const fix = sseRestorer();
  const item = { type: 'function_call', name: 'shell', call_id: 'c2', arguments: JSON.stringify({ command: ['ping', ipAlias] }) };
  const got = fix(ev('response.output_item.done', { output_index: 0, item }), true);
  const d = JSON.parse(/^data: (.*)$/m.exec(got)[1]);
  assert.deepStrictEqual(JSON.parse(d.item.arguments).command, ['ping', SECRETS[0]]);
});
ok('non-responses body refused', () => assert.throws(() => aliasRequest({ messages: [] }, {})));
console.log(`${pass} passed`);
