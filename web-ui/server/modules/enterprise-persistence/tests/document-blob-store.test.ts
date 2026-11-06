import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createLocalDocumentBlobStore, createMemoryDocumentBlobStore } from '../document-blob-store.js';

const ORG_A = '00000000-0000-4000-8000-000000000001';
const ORG_B = '00000000-0000-4000-8000-000000000002';
const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');

describe('createLocalDocumentBlobStore（本機檔案系統 adapter）', () => {
  let root: string;
  before(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'dhc-e05-blob-')); });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  test('依 org 分目錄存放，key 即內容 hash；讀回驗證 hash', async () => {
    const store = createLocalDocumentBlobStore(root);
    const content = Buffer.from('合成文件內容 A');
    await store.put(ORG_A, sha(content), content);
    assert.deepEqual(await store.get(ORG_A, sha(content)), content);
    const file = path.join(root, ORG_A, sha(content).slice(0, 2), sha(content));
    assert.deepEqual(await readFile(file), content);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, ORG_A))).mode & 0o777, 0o700);
  });

  test('V5.1 verify：串流驗證存在與 hash，不回傳內容；遺失 NOT_FOUND、竄改 INTEGRITY、跨組織 NOT_FOUND', async () => {
    const store = createLocalDocumentBlobStore(root);
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
    await store.put(ORG_A, sha(content), content);
    assert.equal(await store.verify!(ORG_A, sha(content)), undefined);
    await assert.rejects(store.verify!(ORG_B, sha(content)), /ENTERPRISE_BLOB_NOT_FOUND/);
    await assert.rejects(store.verify!(ORG_A, 'f'.repeat(64)), /ENTERPRISE_BLOB_NOT_FOUND/);
    await writeFile(path.join(root, ORG_A, sha(content).slice(0, 2), sha(content)), Buffer.from('tampered'));
    await assert.rejects(store.verify!(ORG_A, sha(content)), /ENTERPRISE_BLOB_INTEGRITY/);
    const memory = createMemoryDocumentBlobStore();
    await memory.put(ORG_A, sha(content), content);
    assert.equal(await memory.verify!(ORG_A, sha(content)), undefined);
    await assert.rejects(memory.verify!(ORG_B, sha(content)), /ENTERPRISE_BLOB_NOT_FOUND/);
  });

  test('同一內容重複 put 為冪等；不留下暫存檔', async () => {
    const store = createLocalDocumentBlobStore(root);
    const content = Buffer.from('冪等內容');
    await store.put(ORG_A, sha(content), content);
    await store.put(ORG_A, sha(content), content);
    const entries = await readdir(path.join(root, ORG_A, sha(content).slice(0, 2)));
    assert.deepEqual(entries, [sha(content)]);
  });

  test('其他組織以同一 key 讀取視為不存在', async () => {
    const store = createLocalDocumentBlobStore(root);
    const content = Buffer.from('只屬於 A');
    await store.put(ORG_A, sha(content), content);
    await assert.rejects(store.get(ORG_B, sha(content)), /ENTERPRISE_BLOB_NOT_FOUND/);
  });

  test('key 與內容 hash 不符時拒絕寫入', async () => {
    const store = createLocalDocumentBlobStore(root);
    await assert.rejects(store.put(ORG_A, '0'.repeat(64), Buffer.from('x')), /ENTERPRISE_BLOB_INTEGRITY/);
  });

  test('磁碟上的內容被竄改時讀取失敗', async () => {
    const store = createLocalDocumentBlobStore(root);
    const content = Buffer.from('會被竄改的內容');
    await store.put(ORG_A, sha(content), content);
    await writeFile(path.join(root, ORG_A, sha(content).slice(0, 2), sha(content)), 'tampered');
    await assert.rejects(store.get(ORG_A, sha(content)), /ENTERPRISE_BLOB_INTEGRITY/);
  });

  test('拒絕非 UUID 的 org、非 hex64 的 key（含路徑穿越）', async () => {
    const store = createLocalDocumentBlobStore(root);
    for (const [org, key] of [['../x', sha(Buffer.from('a'))], [ORG_A, '../../etc/passwd'], [ORG_A, 'A'.repeat(64)], ['ABCDEF00-0000-4000-8000-000000000001', sha(Buffer.from('a'))]]) {
      await assert.rejects(store.put(org, key, Buffer.from('a')), /ENTERPRISE_BLOB_INVALID_REF/);
      await assert.rejects(store.get(org, key), /ENTERPRISE_BLOB_INVALID_REF/);
    }
  });

  test('org 目錄若被換成指向根目錄外的 symlink，拒絕讀寫', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'dhc-e05-outside-'));
    try {
      const store = createLocalDocumentBlobStore(root);
      await symlink(outside, path.join(root, ORG_B));
      const content = Buffer.from('不應寫到外部');
      await assert.rejects(store.put(ORG_B, sha(content), content), /ENTERPRISE_BLOB_INVALID_REF/);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(path.join(root, ORG_B), { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('根目錄必須是絕對路徑', () => {
    assert.throws(() => createLocalDocumentBlobStore('relative/dir'), /ENTERPRISE_BLOB_STORE_ROOT/);
  });

  test('根目錄權限過寬時拒絕使用', async () => {
    const wide = await mkdtemp(path.join(os.tmpdir(), 'dhc-e05-wide-'));
    try {
      await mkdir(path.join(wide, 'blobs'), { mode: 0o777 });
      const { chmod } = await import('node:fs/promises');
      await chmod(path.join(wide, 'blobs'), 0o777);
      const store = createLocalDocumentBlobStore(path.join(wide, 'blobs'));
      const content = Buffer.from('x');
      await assert.rejects(store.put(ORG_A, sha(content), content), /ENTERPRISE_BLOB_STORE_ROOT/);
    } finally {
      await rm(wide, { recursive: true, force: true });
    }
  });
});

describe('createMemoryDocumentBlobStore（僅供測試的 adapter，契約相同）', () => {
  test('org 隔離、hash 驗證與 key 格式規則與本機 adapter 一致', async () => {
    const store = createMemoryDocumentBlobStore();
    const content = Buffer.from('記憶體內容');
    await store.put(ORG_A, sha(content), content);
    assert.deepEqual(await store.get(ORG_A, sha(content)), content);
    await assert.rejects(store.get(ORG_B, sha(content)), /ENTERPRISE_BLOB_NOT_FOUND/);
    await assert.rejects(store.put(ORG_A, '0'.repeat(64), content), /ENTERPRISE_BLOB_INTEGRITY/);
    await assert.rejects(store.put('bad', sha(content), content), /ENTERPRISE_BLOB_INVALID_REF/);
  });

  test('回傳副本，呼叫端修改不影響已存內容', async () => {
    const store = createMemoryDocumentBlobStore();
    const content = Buffer.from('原始');
    await store.put(ORG_A, sha(content), content);
    content.fill(0);
    const first = await store.get(ORG_A, sha(Buffer.from('原始')));
    first.fill(0);
    assert.deepEqual(await store.get(ORG_A, sha(Buffer.from('原始'))), Buffer.from('原始'));
  });
});
