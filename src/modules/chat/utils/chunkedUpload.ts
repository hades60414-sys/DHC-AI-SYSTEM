import { api } from '@/shared/api';

/**
 * DHC CLI: attachments over 10MB go up in 8MB chunks (the server picks the
 * size) so no single request nears the ~100MB Cloudflare tunnel cap. Each
 * chunk carries its SHA-256 and the server rejects a damaged one; a failed
 * chunk is retried a few times before the whole upload is abandoned. The
 * body is the Blob slice itself: an ArrayBuffer body stalled the page about
 * half a second per chunk in Chromium (500MB: 52s and 63 stalls vs 18s, none).
 */

export const DIRECT_UPLOAD_MAX_SIZE = 10 * 1024 * 1024;
export const CHUNKED_UPLOAD_MAX_SIZE = 2 * 1024 * 1024 * 1024;
const CHUNK_RETRIES = 3;

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

const readError = async (response: Response, fallback: string) => {
  const body = await response.json().catch(() => null);
  return body?.error || `${fallback}（HTTP ${response.status}）`;
};

export async function uploadFileInChunks(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<unknown> {
  const startResponse = await api.assets.startUpload({
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
  });
  if (!startResponse.ok) {
    throw new Error(await readError(startResponse, '無法開始上傳'));
  }
  const { id, chunkSize, chunkCount } = await startResponse.json();

  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = file.slice(index * chunkSize, (index + 1) * chunkSize);
      const sha256 = toHex(await crypto.subtle.digest('SHA-256', await chunk.arrayBuffer()));
      let lastError = '';
      for (let attempt = 0; attempt < CHUNK_RETRIES; attempt += 1) {
        try {
          const response = await api.assets.uploadChunk(id, index, chunk, sha256);
          if (response.ok) {
            lastError = '';
            break;
          }
          lastError = await readError(response, `第 ${index + 1} 段上傳失敗`);
          // The upload is gone on the server (restart); retrying cannot help.
          if (response.status === 404) break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (lastError) {
        throw new Error(`${file.name}：${lastError}`);
      }
      onProgress?.((index + 1) / chunkCount);
    }

    const completeResponse = await api.assets.completeUpload(id);
    if (!completeResponse.ok) {
      throw new Error(`${file.name}：${await readError(completeResponse, '組回檔案失敗')}`);
    }
    const result = await completeResponse.json();
    return result.attachment;
  } catch (error) {
    await api.assets.cancelUpload(id).catch(() => undefined);
    throw error;
  }
}
