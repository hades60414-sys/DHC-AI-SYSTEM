import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CHUNK_SIZE,
  MAX_CHUNKED_UPLOAD_SIZE,
  completeChunkedUpload,
  startChunkedUpload,
  writeUploadChunk,
} from '@/modules/assets/services/chunked-upload.service.js';
import { isImageAttachmentDescriptor } from '@/shared/image-attachments.js';

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

// Point os.homedir() at a scratch folder so nothing lands in the real ~/.cloudcli.
const withScratchHome = async (run: () => Promise<void>) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chunked-upload-'));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    await run();
  } finally {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
};

const makeFile = (size: number) => {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) buffer[i] = (i / 4096) % 251;
  return buffer;
};

test('chunks sent out of order reassemble into the original bytes', async () => {
  await withScratchHome(async () => {
    const original = makeFile(CHUNK_SIZE * 2 + 12345);
    const { id, chunkCount } = await startChunkedUpload({ name: '大檔.csv', size: original.length, mimeType: 'text/csv' });
    assert.equal(chunkCount, 3);

    for (const index of [2, 0, 1, 0]) {
      const chunk = original.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
      await writeUploadChunk(id, index, Buffer.from(chunk), sha(chunk));
    }
    const { attachment, sha256 } = await completeChunkedUpload(id);

    assert.equal(sha256, sha(original));
    assert.equal(attachment.name, '大檔.csv');
    assert.equal(attachment.size, original.length);
    assert.equal(sha(await fs.readFile(attachment.path)), sha(original));
    assert.ok(attachment.path.includes('/.cloudcli/assets/'));
  });
});

test('a damaged or short chunk is rejected and completion reports what is missing', async () => {
  await withScratchHome(async () => {
    const original = makeFile(CHUNK_SIZE + 10);
    const { id } = await startChunkedUpload({ name: 'a.bin', size: original.length });
    const first = Buffer.from(original.subarray(0, CHUNK_SIZE));

    await assert.rejects(writeUploadChunk(id, 0, first, sha(Buffer.from('other'))), { status: 422 });
    await assert.rejects(writeUploadChunk(id, 0, first.subarray(1), sha(first.subarray(1))), { status: 400 });
    await assert.rejects(writeUploadChunk(id, 5, first, sha(first)), { status: 400 });

    await writeUploadChunk(id, 0, first, sha(first));
    await assert.rejects(completeChunkedUpload(id), { status: 409 });
  });
});

test('uploads over 2GB or with unknown ids are refused', async () => {
  await withScratchHome(async () => {
    await assert.rejects(startChunkedUpload({ name: 'x', size: MAX_CHUNKED_UPLOAD_SIZE + 1 }), { status: 413 });
    await assert.rejects(startChunkedUpload({ name: '', size: 10 }), { status: 400 });
    await assert.rejects(completeChunkedUpload('no-such-id'), { status: 404 });
  });
});

test('images too big for the Claude API go through as file paths', () => {
  assert.equal(isImageAttachmentDescriptor({ path: '/a/x.png', mimeType: 'image/png', size: 3 * 1024 * 1024 }), true);
  assert.equal(isImageAttachmentDescriptor({ path: '/a/x.png', mimeType: 'image/png', size: 4 * 1024 * 1024 }), false);
  assert.equal(isImageAttachmentDescriptor({ path: '/a/x.png', mimeType: 'image/png' }), true);
});
