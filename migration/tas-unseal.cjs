// usage: node tas-unseal.cjs <sealed.bin> <hexkey> <outfile>
const c = require('crypto'), fs = require('fs');
const [, , inp, key, out] = process.argv;
const b = fs.readFileSync(inp);
const d = c.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), b.subarray(0, 12));
d.setAuthTag(b.subarray(12, 28));
fs.writeFileSync(out, Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8') + '\r\n');
console.log('unsealed', fs.statSync(out).size, 'bytes');
