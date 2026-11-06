import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { runEnterpriseMigrations } from '../index.js';

test('缺少任一已知 migration 檔時回 ENTERPRISE_MIGRATION_FILE_MISSING，且不連線資料庫', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dhc-e05-missing-'));
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('should not connect'); } } as unknown as Pool;
  try {
    // 只有 0001，缺 0002
    for (const file of ['0001_enterprise_base.up.sql', '0001_enterprise_base.down.sql']) {
      await copyFile(path.resolve('db/enterprise/migrations', file), path.join(temporary, file));
    }
    await assert.rejects(runEnterpriseMigrations(pool, { directory: temporary, direction: 'up' }), (error: Error) => {
      assert.equal(error.message, 'ENTERPRISE_MIGRATION_FILE_MISSING');
      assert.ok(!error.message.includes(temporary));
      return true;
    });
    assert.equal(connected, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
