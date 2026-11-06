// 僅檢查 DHC 應用存活；不代表資料庫或模型可用。
import { pathToFileURL } from 'node:url';

/** 供 Docker HEALTHCHECK 與本機失敗路徑測試使用。 */
export async function probeHealth(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body?.status !== 'ok') throw new Error('health status is not ok');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await probeHealth(`http://127.0.0.1:${process.env.SERVER_PORT || '3001'}/health`);
  } catch (error) {
    console.error('DHC healthcheck failed:', error.name);
    process.exitCode = 1;
  }
}
