import { createHash, randomUUID } from 'node:crypto';
import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureImageAssetsDir, buildStoredAttachmentRecords } from '@/modules/assets/services/image-assets.service.js';

/**
 * DHC CLI: chunked uploads for chat attachments over 10MB. The browser sends
 * the file in fixed-size chunks (each well under the ~100MB per-request cap of
 * the Cloudflare tunnel), each carrying its own SHA-256; the server writes
 * them at their offsets into one partial file and, once every chunk is in,
 * moves it into the assets folder under the same naming scheme as
 * `/api/assets/files`. Chunk writes are positional, so a retried chunk simply
 * overwrites itself. In-progress uploads live in memory only; a server
 * restart drops them and the stale partial files are swept on the next start.
 */

export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_CHUNKED_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

type ChunkedUpload = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  chunkCount: number;
  received: Set<number>;
  partialPath: string;
  createdAt: number;
};

const uploads = new Map<string, ChunkedUpload>();

export function getUploadTempDir(): string {
  return path.join(os.homedir(), '.cloudcli', 'upload-tmp');
}

export class ChunkedUploadError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Drops in-memory uploads and partial files older than a day. */
async function sweepStaleUploads(now: number): Promise<void> {
  for (const [id, upload] of uploads) {
    if (now - upload.createdAt > STALE_UPLOAD_MS) {
      uploads.delete(id);
      await fs.rm(upload.partialPath, { force: true });
    }
  }
  const entries = await fs.readdir(getUploadTempDir()).catch(() => [] as string[]);
  for (const entry of entries) {
    const full = path.join(getUploadTempDir(), entry);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_UPLOAD_MS) {
      await fs.rm(full, { force: true });
    }
  }
}

export async function startChunkedUpload(input: { name?: unknown; size?: unknown; mimeType?: unknown }) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const size = typeof input.size === 'number' ? input.size : NaN;
  if (!name || name.length > 255) {
    throw new ChunkedUploadError(400, '檔名不正確');
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new ChunkedUploadError(400, '檔案大小不正確');
  }
  if (size > MAX_CHUNKED_UPLOAD_SIZE) {
    throw new ChunkedUploadError(413, '檔案太大（上限 2GB）');
  }

  const now = Date.now();
  await sweepStaleUploads(now);
  await fs.mkdir(getUploadTempDir(), { recursive: true });

  const id = randomUUID();
  const partialPath = path.join(getUploadTempDir(), `${id}.part`);
  await fs.writeFile(partialPath, '');
  uploads.set(id, {
    id,
    name,
    size,
    mimeType: typeof input.mimeType === 'string' && input.mimeType ? input.mimeType : 'application/octet-stream',
    chunkCount: Math.ceil(size / CHUNK_SIZE),
    received: new Set(),
    partialPath,
    createdAt: now,
  });
  return { id, chunkSize: CHUNK_SIZE, chunkCount: Math.ceil(size / CHUNK_SIZE) };
}

function getUpload(id: string): ChunkedUpload {
  const upload = uploads.get(id);
  if (!upload) {
    throw new ChunkedUploadError(404, '找不到這次上傳（可能伺服器重啟過），請重新附加檔案');
  }
  return upload;
}

export async function writeUploadChunk(id: string, index: number, body: Buffer, sha256: string | undefined) {
  const upload = getUpload(id);
  if (!Number.isInteger(index) || index < 0 || index >= upload.chunkCount) {
    throw new ChunkedUploadError(400, '分段編號不正確');
  }
  const expectedLength = index === upload.chunkCount - 1 ? upload.size - index * CHUNK_SIZE : CHUNK_SIZE;
  if (!Buffer.isBuffer(body) || body.length !== expectedLength) {
    throw new ChunkedUploadError(400, `第 ${index + 1} 段長度不對（收到 ${body?.length ?? 0}，應為 ${expectedLength}）`);
  }
  const actual = createHash('sha256').update(body).digest('hex');
  if (!sha256 || actual !== sha256.toLowerCase()) {
    throw new ChunkedUploadError(422, `第 ${index + 1} 段雜湊不符，傳輸中損壞`);
  }

  const handle = await fs.open(upload.partialPath, 'r+');
  try {
    await handle.write(body, 0, body.length, index * CHUNK_SIZE);
  } finally {
    await handle.close();
  }
  upload.received.add(index);
  return { received: upload.received.size, chunkCount: upload.chunkCount };
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fsSync.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export async function completeChunkedUpload(id: string) {
  const upload = getUpload(id);
  if (upload.received.size !== upload.chunkCount) {
    const missing = [];
    for (let i = 0; i < upload.chunkCount && missing.length < 5; i += 1) {
      if (!upload.received.has(i)) missing.push(i + 1);
    }
    throw new ChunkedUploadError(409, `還缺 ${upload.chunkCount - upload.received.size} 段（例如第 ${missing.join('、')} 段）`);
  }
  const stat = await fs.stat(upload.partialPath);
  if (stat.size !== upload.size) {
    throw new ChunkedUploadError(500, `組回的檔案大小不對（${stat.size}，應為 ${upload.size}）`);
  }

  const sha256 = await hashFile(upload.partialPath);
  const assetsDir = await ensureImageAssetsDir();
  // Same naming as the multer storage in assets.routes.ts.
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const filename = `${uniqueSuffix}-${upload.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const finalPath = path.join(assetsDir, filename);
  try {
    await fs.rename(upload.partialPath, finalPath);
  } catch {
    // Temp and assets folders can sit on different volumes.
    await fs.copyFile(upload.partialPath, finalPath);
    await fs.rm(upload.partialPath, { force: true });
  }
  uploads.delete(id);

  const [record] = buildStoredAttachmentRecords([
    { originalname: upload.name, filename, size: upload.size, mimetype: upload.mimeType },
  ]);
  return { attachment: record, sha256 };
}

export async function cancelChunkedUpload(id: string): Promise<void> {
  const upload = uploads.get(id);
  if (!upload) return;
  uploads.delete(id);
  await fs.rm(upload.partialPath, { force: true });
}
