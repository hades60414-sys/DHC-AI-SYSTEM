'use strict';
// Minimal read-only ZIP reader (enough to pull one named entry out of a .docx). No dependencies.
const zlib = require('node:zlib');

function findEOCD(buf) {
  const sig = 0x06054b50;
  const minLen = 22;
  for (let i = buf.length - minLen; i >= Math.max(0, buf.length - minLen - 65536); i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  throw Error('zip_eocd_not_found');
}

// Returns { name: Buffer } for the requested entry names found in the archive, or {} if absent.
function readEntries(buf, wantedNames) {
  const eocd = findEOCD(buf);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEntries = buf.readUInt16LE(eocd + 10);
  const out = {};
  let p = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (wantedNames.includes(name)) {
      const lh = localOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw Error('zip_local_header_bad:' + name);
      const lNameLen = buf.readUInt16LE(lh + 26);
      const lExtraLen = buf.readUInt16LE(lh + 28);
      const dataStart = lh + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      out[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { readEntries };
