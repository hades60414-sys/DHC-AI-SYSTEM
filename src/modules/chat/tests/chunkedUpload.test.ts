import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { chunks: Array<{ index: number; size: number; sha256: string }>; cancelled: string[] } = {
  chunks: [],
  cancelled: [],
};
let failChunkTimes = 0;

vi.mock('@/shared/api', () => {
  const reply = (ok: boolean, data: unknown, status = ok ? 200 : 500) =>
    Promise.resolve({ ok, status, json: async () => data });
  return {
    api: {
      assets: {
        startUpload: ({ size }: { size: number }) => reply(true, { id: 'u1', chunkSize: 4, chunkCount: Math.ceil(size / 4) }),
        uploadChunk: (_id: string, index: number, chunk: Blob, sha256: string) => {
          if (failChunkTimes > 0) {
            failChunkTimes -= 1;
            return reply(false, { error: 'boom' });
          }
          calls.chunks.push({ index, size: chunk.size, sha256 });
          return reply(true, {});
        },
        completeUpload: () => reply(true, { attachment: { name: 'f.bin', path: '/x/f.bin' } }),
        cancelUpload: (id: string) => {
          calls.cancelled.push(id);
          return reply(true, {});
        },
      },
    },
  };
});

import { uploadFileInChunks } from '@/modules/chat/utils/chunkedUpload';

// jsdom Blobs lack arrayBuffer(); browsers have it.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    return new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(this);
    });
  };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('uploadFileInChunks', () => {
  beforeEach(() => {
    calls.chunks = [];
    calls.cancelled = [];
    failChunkTimes = 0;
  });

  it('sends every chunk with its own hash and reports progress', async () => {
    const progress: number[] = [];
    const result = await uploadFileInChunks(new File(['abcdefghij'], 'f.bin'), (fraction) => progress.push(fraction));

    expect(calls.chunks).toEqual([
      { index: 0, size: 4, sha256: sha('abcd') },
      { index: 1, size: 4, sha256: sha('efgh') },
      { index: 2, size: 2, sha256: sha('ij') },
    ]);
    expect(progress).toEqual([1 / 3, 2 / 3, 1]);
    expect(result).toEqual({ name: 'f.bin', path: '/x/f.bin' });
  });

  it('retries a failed chunk, then gives up and cancels the upload', async () => {
    failChunkTimes = 2;
    await uploadFileInChunks(new File(['abcd'], 'f.bin'));
    expect(calls.chunks).toHaveLength(1);

    failChunkTimes = 3;
    await expect(uploadFileInChunks(new File(['abcd'], 'f.bin'))).rejects.toThrow('boom');
    expect(calls.cancelled).toEqual(['u1']);
  });
});
