// node --test pii-mask.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const pii = require('./pii-mask.cjs');

// Synthetic values built at run time: an ID with a computed check digit, a 09 mobile, a Luhn-valid test card.
const body8 = '1' + '2345678';
const sum = 1 + body8.split('').reduce((a, d, i) => a + Number(d) * [8, 7, 6, 5, 4, 3, 2, 1][i], 0);
const ID = 'A' + body8 + String((10 - (sum % 10)) % 10);
const PHONE = '09' + '12' + '345' + '678';
const CARD = '4' + '1'.repeat(15);

test('masks IDs, cards and mobiles, keeping the length', () => {
  const text = `客戶 ${ID} 卡 ${CARD} 電話 ${PHONE.slice(0, 4)}-${PHONE.slice(4, 7)}-${PHONE.slice(7)}`;
  const out = pii.maskText(text);
  assert.equal(out.count, 3);
  assert.equal(out.text.length, text.length);
  assert.ok(out.text.includes('A12****' + ID.slice(-3)));
  assert.ok(!out.text.includes(ID) && !out.text.includes(CARD));
  assert.ok(out.text.includes('091******678'));
});

test('leaves ordinary text alone', () => {
  const text = '部位 2026-11-02 損益 -1,234,567 session 3f2a1c49-02d7-405a-a652-f2c4b5da2338 hash b' + PHONE + 'f 時間 1730512345678';
  assert.deepEqual(pii.maskText(text), { text, count: 0 });
});

test('a card sent as a bare JSON number stays valid JSON', () => {
  const out = pii.maskJsonish(`{"card":${CARD},"list":[${CARD}],"note":"id ${ID}"}`);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.card, '411**********111');
  assert.match(parsed.note, /A12\*{4}/);
});

test('spots a masked value coming back', () => {
  assert.ok(pii.hasMaskedPii(JSON.stringify({ content: 'x A12****789 y' })));
  assert.ok(!pii.hasMaskedPii('**bold** and 2 * 3'));
});

function zipOf(name, content) {
  const data = zlib.deflateRawSync(Buffer.from(content));
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(8, 8); head.writeUInt32LE(data.length, 18);
  head.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([head, Buffer.from(name), data]);
}

test('finds personal data inside binary downloads', () => {
  assert.ok(pii.binaryHasPii(zipOf('xl/sharedStrings.xml', `<t>${ID}</t>`)));
  assert.ok(!pii.binaryHasPii(zipOf('xl/sharedStrings.xml', '<t>台積電</t>')));
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\nstream\n'), zlib.deflateSync(Buffer.from(`BT (${PHONE}) Tj ET`)), Buffer.from('\nendstream\n')]);
  assert.ok(pii.binaryHasPii(pdf));
  assert.ok(pii.binaryHasPii(Buffer.from(`tel ${PHONE}`, 'utf16le')));
  assert.ok(!pii.binaryHasPii(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])));
});

const frame = (opcode, payload, fin = true) => {
  const p = Buffer.from(payload);
  const b0 = (fin ? 0x80 : 0) | opcode;
  return p.length < 126 ? Buffer.concat([Buffer.from([b0, p.length]), p])
    : Buffer.concat([Buffer.from([b0, 126, p.length >> 8, p.length & 0xff]), p]);
};
const payloads = (bufs) => {
  const all = Buffer.concat(bufs); const out = []; let i = all.indexOf('\r\n\r\n') + 4;
  while (i < all.length) {
    let len = all[i + 1] & 0x7f, off = 2;
    if (len === 126) { len = all.readUInt16BE(i + 2); off = 4; }
    out.push({ opcode: all[i] & 0x0f, text: all.toString('utf8', i + off, i + off + len) });
    i += off + len;
  }
  return out;
};

test('masks text frames from the server, across chunk splits, and leaves binary frames', () => {
  const mask = pii.createWsMasker();
  const head = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
  const long = JSON.stringify({ type: 'claude-response', text: '查到 ' + ID + ' 的資料 '.repeat(20) });
  const stream = Buffer.concat([head, frame(1, long), frame(2, ID), frame(1, `{"n":${CARD}}`)]);
  const out = [];
  for (let i = 0; i < stream.length; i += 7) out.push(...mask(stream.subarray(i, i + 7)));
  assert.ok(out[0].toString().startsWith('HTTP/1.1 101'));
  const got = payloads(out);
  assert.equal(got.length, 3);
  assert.ok(!got[0].text.includes(ID) && got[0].text.includes('A12****'));
  assert.equal(JSON.parse(got[0].text).type, 'claude-response');
  assert.equal(got[1].opcode, 2); assert.equal(got[1].text, ID);
  assert.deepEqual(JSON.parse(got[2].text), { n: '411**********111' });
});

test('masks continuation frames of a text message', () => {
  const mask = pii.createWsMasker();
  const out = mask(Buffer.concat([Buffer.from('HTTP/1.1 101 x\r\n\r\n'), frame(1, 'a ', false), frame(0, `${ID} b`, true)]));
  const got = payloads(out);
  assert.equal(got[1].opcode, 0);
  assert.ok(got[1].text.startsWith('A12****'));
});
