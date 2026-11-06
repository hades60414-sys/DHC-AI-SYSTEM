import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { EnterpriseDocumentBlobStore } from '@/shared/index.js';

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function requireBlobRef(organizationId: unknown, storageKey: unknown) {
  if (typeof organizationId !== 'string' || !LOWER_UUID.test(organizationId)
    || typeof storageKey !== 'string' || !SHA256_HEX.test(storageKey)) {
    throw new Error('ENTERPRISE_BLOB_INVALID_REF');
  }
}

function sha256(content: Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * 供部署組裝（未來 composition root）與 enterprise-persistence 測試使用的本機檔案系統 adapter。
 * 佈局：<root>/<orgId>/<key 前 2 碼>/<key>；目錄 0700、檔案 0600；暫存檔寫完 fsync 後 rename，避免半寫入。
 * 根目錄必須是絕對路徑且不可被 group/other 寫入；org 目錄若被換成 symlink 或解析到根目錄外，一律拒絕。
 */
export function createLocalDocumentBlobStore(rootDirectory: string): EnterpriseDocumentBlobStore {
  if (typeof rootDirectory !== 'string' || !path.isAbsolute(rootDirectory)) throw new Error('ENTERPRISE_BLOB_STORE_ROOT');
  const root = path.resolve(rootDirectory);

  async function checkedRoot() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await stat(root);
    if (!info.isDirectory() || (info.mode & 0o022) !== 0) throw new Error('ENTERPRISE_BLOB_STORE_ROOT');
    return realpath(root);
  }

  /** 回傳 blob 的實際路徑；create=true 時建立缺少的目錄。每層都拒絕 symlink 並確認仍在根目錄內。 */
  async function blobPath(organizationId: string, storageKey: string, create: boolean) {
    const realRoot = await checkedRoot();
    let current = realRoot;
    for (const segment of [organizationId, storageKey.slice(0, 2)]) {
      current = path.join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('ENTERPRISE_BLOB_INVALID_REF');
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!create) throw new Error('ENTERPRISE_BLOB_NOT_FOUND');
        await mkdir(current, { mode: 0o700 });
      }
      if (!(await realpath(current)).startsWith(realRoot + path.sep)) throw new Error('ENTERPRISE_BLOB_INVALID_REF');
    }
    return path.join(current, storageKey);
  }

  async function readVerified(file: string, storageKey: string) {
    let content: Buffer;
    try {
      const info = await lstat(file);
      if (!info.isFile()) throw new Error('ENTERPRISE_BLOB_INVALID_REF');
      content = await readFile(file);
    } catch (error) {
      if (isMissing(error)) throw new Error('ENTERPRISE_BLOB_NOT_FOUND');
      throw error;
    }
    if (sha256(content) !== storageKey) throw new Error('ENTERPRISE_BLOB_INTEGRITY');
    return content;
  }

  return {
    async put(organizationId, storageKey, content) {
      requireBlobRef(organizationId, storageKey);
      if (!Buffer.isBuffer(content) || sha256(content) !== storageKey) throw new Error('ENTERPRISE_BLOB_INTEGRITY');
      const file = await blobPath(organizationId, storageKey, true);
      try {
        await readVerified(file, storageKey);
        return; // 內容定址：已存在且完整就是冪等成功
      } catch (error) {
        if ((error as Error).message !== 'ENTERPRISE_BLOB_NOT_FOUND') throw error;
      }
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async get(organizationId, storageKey) {
      requireBlobRef(organizationId, storageKey);
      return readVerified(await blobPath(organizationId, storageKey, false), storageKey);
    },
  };
}

/** 只供 enterprise-persistence 測試使用的記憶體 adapter；契約與本機 adapter 相同，進出都複製 Buffer。不可用於部署。 */
export function createMemoryDocumentBlobStore(): EnterpriseDocumentBlobStore {
  const blobs = new Map<string, Buffer>();
  return {
    async put(organizationId, storageKey, content) {
      requireBlobRef(organizationId, storageKey);
      if (!Buffer.isBuffer(content) || sha256(content) !== storageKey) throw new Error('ENTERPRISE_BLOB_INTEGRITY');
      blobs.set(`${organizationId}/${storageKey}`, Buffer.from(content));
    },
    async get(organizationId, storageKey) {
      requireBlobRef(organizationId, storageKey);
      const content = blobs.get(`${organizationId}/${storageKey}`);
      if (!content) throw new Error('ENTERPRISE_BLOB_NOT_FOUND');
      if (sha256(content) !== storageKey) throw new Error('ENTERPRISE_BLOB_INTEGRITY');
      return Buffer.from(content);
    },
  };
}
