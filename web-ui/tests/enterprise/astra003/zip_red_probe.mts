/**
 * ASTRA-003 前後對照探針：只用新舊版本都有的 extractDocumentText(mediaType, buffer) API。
 * 用法：tsx tests/enterprise/astra003/zip_red_probe.mts <repo-root>
 * 每個案例輸出一行 JSON：結果、主行程 RSS 變化、耗時。全部為合成資料。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const { extractDocumentText } = await import(pathToFileURL(path.join(root, 'server/modules/enterprise-persistence/document-extraction.ts')).href);
const { default: JSZip } = await import(pathToFileURL(path.join(root, 'node_modules/jszip/lib/index.js')).href);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function build(extra: (zip: any) => void, text = 'synthetic small') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  extra(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>;
}
function forgeDeclared(buffer: Buffer, name: string, value: number) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    let pointer = buffer.readUInt32LE(offset + 16);
    while (buffer.readUInt32LE(pointer) === 0x02014b50) {
      const nameLength = buffer.readUInt16LE(pointer + 28);
      if (buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString() === name) buffer.writeUInt32LE(value, pointer + 24);
      pointer += 46 + nameLength + buffer.readUInt16LE(pointer + 30) + buffer.readUInt16LE(pointer + 32);
    }
  }
  return buffer;
}
const cases: Array<[string, () => Promise<Buffer>]> = [
  ['astra-24mib-irrelevant-entry', () => build(zip => zip.file('irrelevant.bin', Buffer.alloc(24 * 1024 * 1024, 65)))],
  ['forged-declared-size-5mib-as-100b', async () => forgeDeclared(await build(() => undefined, 'A'.repeat(5 * 1024 * 1024)), 'word/document.xml', 100)],
  ['2001-entries', () => build(zip => { for (let i = 0; i < 2001; i += 1) zip.file(`x/${i}.txt`, 'x'); })],
  ['ratio-4mib-zeros', () => build(zip => zip.file('zeros.bin', Buffer.alloc(4 * 1024 * 1024, 0)))],
];
for (const [name, make] of cases) {
  const bytes = await make();
  global.gc?.();
  const before = process.memoryUsage().rss;
  const started = Date.now();
  let result: unknown;
  try { const out = await extractDocumentText(DOCX, bytes); result = { accepted: true, units: out.units.length, extractor: out.extractor }; }
  catch (error) { result = { rejected: (error as Error).message }; }
  console.log(JSON.stringify({ case: name, zip_bytes: bytes.length, result, rss_growth_bytes: process.memoryUsage().rss - before, elapsed_ms: Date.now() - started }));
}
