/**
 * 隔離擷取子行程（由 extraction-sandbox 以 `node --max-old-space-size=… extraction-worker <mediaType>` 啟動，環境變數為空）。
 * stdin：文件原始位元組；stdout：一行 JSON {ok:true, extractor, units} 或 {ok:false, code}。
 * 只輸出 ENTERPRISE_EXTRACTION_* 代碼，不輸出例外訊息或堆疊（避免把不可信內容帶回主行程日誌）。
 */
import { extractInProcess } from './document-extraction.js';

const MAX_INPUT_BYTES = 100 * 1024 * 1024;

async function main() {
  const mediaType = process.argv[2] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_INPUT_BYTES) throw new Error('ENTERPRISE_EXTRACTION_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  const result = await extractInProcess(mediaType, Buffer.concat(chunks));
  process.stdout.write(JSON.stringify({ ok: true, extractor: result.extractor, units: result.units }));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const code = /^ENTERPRISE_EXTRACTION_[A-Z_]+$/.test(message) ? message : 'ENTERPRISE_EXTRACTION_FAILED';
  process.stdout.write(JSON.stringify({ ok: false, code }));
  process.exitCode = 0;
});
