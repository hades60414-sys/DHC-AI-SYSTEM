import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EnterpriseTextUnit as TextUnit } from '@/shared/index.js';

/**
 * DEC-PDF-01／ASTRA-003：不可信文件解析的隔離子行程。
 * - 獨立 Node 行程：V8 heap 上限（預設 256 MiB）、時間上限（編譯後 20 秒；tsx 開發模式 60 秒；逾時 SIGKILL）、輸出上限 8 MiB。
 * - 環境變數清空：子行程拿不到資料庫密碼、BYOK 主金鑰等任何秘密。
 * - 同時最多 2 個子行程（其餘排隊），避免大量上傳造成行程風暴。
 * - 子行程崩潰（含 OOM）只讓這次擷取失敗，不影響主行程。
 */
const MAX_CONCURRENT = 2;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
/** 開發／測試以 tsx 即時編譯 worker，冷啟動較慢且測試並行時 CPU 競爭大；只在未編譯模式放寬。正式 image 一律 20 秒。 */
const DEV_TIMEOUT_MS = 60_000;
const DEFAULT_HEAP_MB = 256;

let running = 0;
const waiting: Array<() => void> = [];
async function acquire() {
  if (running < MAX_CONCURRENT) { running += 1; return; }
  await new Promise<void>(resolve => waiting.push(resolve));
  running += 1;
}
function release() {
  running -= 1;
  waiting.shift()?.();
}

function workerCommand(heapMb: number) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, 'extraction-worker.js');
  const limits = [`--max-old-space-size=${heapMb}`, '--max-semi-space-size=8', '--disallow-code-generation-from-strings'];
  if (existsSync(compiled)) return { script: compiled, execArgv: limits, defaultTimeoutMs: DEFAULT_TIMEOUT_MS };
  // 開發／測試（tsx）：以絕對路徑載入 tsx loader，與 cwd 無關
  return { script: path.join(here, 'extraction-worker.ts'), execArgv: ['--import', import.meta.resolve('tsx'), ...limits], defaultTimeoutMs: DEV_TIMEOUT_MS };
}

/** 供測試確認：子行程環境變數一律為空物件。 */
export function extractionChildEnv(): NodeJS.ProcessEnv {
  return {};
}

export async function runIsolatedExtraction(mediaType: string, content: Buffer, options: { timeoutMs?: number; heapMb?: number; execPath?: string } = {}):
  Promise<{ extractor: string; units: TextUnit[] }> {
  await acquire();
  try {
    const { script, execArgv, defaultTimeoutMs } = workerCommand(options.heapMb ?? DEFAULT_HEAP_MB);
    return await new Promise((resolve, reject) => {
      // 只結算一次：spawn 失敗時只會有 'error'（不一定有 'close'），不能讓 Promise 懸置而永久占住並行名額
      let settled = false;
      const done = (error: Error | null, value?: { extractor: string; units: TextUnit[] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
      const child = spawn(options.execPath ?? process.execPath, [...execArgv, script, mediaType], { stdio: ['pipe', 'pipe', 'ignore'], env: extractionChildEnv() });
      const chunks: Buffer[] = [];
      let size = 0;
      let outcome: string | null = null;
      const timer = setTimeout(() => { outcome = 'ENTERPRISE_EXTRACTION_TIMEOUT'; child.kill('SIGKILL'); }, options.timeoutMs ?? defaultTimeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) { outcome = 'ENTERPRISE_EXTRACTION_TOO_LARGE'; child.kill('SIGKILL'); return; }
        chunks.push(chunk);
      });
      child.stdin.on('error', () => undefined); // 子行程提早結束時寫入 EPIPE
      child.on('error', () => { child.kill('SIGKILL'); done(new Error(outcome ?? 'ENTERPRISE_EXTRACTION_FAILED')); });
      child.on('close', code => {
        if (outcome) return done(new Error(outcome));
        if (code !== 0) return done(new Error('ENTERPRISE_EXTRACTION_FAILED')); // 崩潰／OOM
        try {
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; code?: string; extractor?: string; units?: TextUnit[] };
          if (message.ok && typeof message.extractor === 'string' && Array.isArray(message.units)) return done(null, { extractor: message.extractor, units: message.units });
          done(new Error(typeof message.code === 'string' && /^ENTERPRISE_EXTRACTION_[A-Z_]+$/.test(message.code) ? message.code : 'ENTERPRISE_EXTRACTION_FAILED'));
        } catch {
          done(new Error('ENTERPRISE_EXTRACTION_FAILED'));
        }
      });
      child.stdin.end(content);
    });
  } finally {
    release();
  }
}
