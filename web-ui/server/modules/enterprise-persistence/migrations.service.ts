import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Pool } from 'pg';

/**
 * 已知 migration，依套用順序排列；history 必須是此清單的前綴。
 * tables：該版本建立、且 down 前要檢查是否有資料的資料表（不含 schema_migrations）。
 */
const migrations = [
  { version: '0001_enterprise_base', tables: ['audit_events', 'documents', 'tasks', 'org_member_roles', 'roles', 'org_members', 'user_accounts', 'organizations'] },
  { version: '0002_document_versions', tables: ['document_versions', 'document_blobs'] },
  { version: '0003_identity_sessions', tables: ['auth_sessions', 'account_credentials'] },
  { version: '0004_document_index', tables: ['document_chunks', 'document_extractions'] },
  { version: '0005_workflow_models', tables: ['draft_exports', 'approvals', 'model_usage', 'runs', 'draft_revisions', 'drafts', 'model_providers'] },
  { version: '0006_subscriptions', tables: ['invoices', 'subscription_events', 'subscriptions'] },
  { version: '0007_egress_notifications', tables: ['notification_reads', 'notifications'] },
  { version: '0008_run_quarantine', tables: ['run_quarantine'] },
  { version: '0009_citation_integrity', tables: [] },
  { version: '0010_usage_ledger', tables: [] },
  { version: '0011_approval_revision_binding', tables: [] },
  { version: '0012_reconciliations', tables: ['reconciliations'] },
] as const;

/**
 * 供同模組 CLI/測試使用；獨立 migrator Pool，版本、checksum、DDL、history 在同一 transaction。
 * up：依序套用尚未記錄的版本。down：依反序移除全部已套用版本；任一表有資料時需要 allowDataLoss。
 * 回傳 version 為最新已知版本；appliedVersions 為本次實際套用或移除的版本（依執行順序）。
 */
export async function runEnterpriseMigrations(pool: Pool, options: { directory: string; direction: 'up' | 'down'; allowDataLoss?: boolean }) {
  const readMigration = async (filename: string) => {
    try {
      return await readFile(path.join(options.directory, filename), 'utf8');
    } catch (error) {
      // 不把完整路徑帶進錯誤訊息；CLI 只輸出 ENTERPRISE_ 開頭的代碼。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ENTERPRISE_MIGRATION_FILE_MISSING');
      throw error;
    }
  };
  const files = await Promise.all(migrations.map(async migration => {
    const up = await readMigration(`${migration.version}.up.sql`);
    const down = await readMigration(`${migration.version}.down.sql`);
    return { ...migration, up, down, checksum: createHash('sha256').update(up).update('\0').update(down).digest('hex') };
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(842020261101::bigint)');
    await client.query(`CREATE TABLE IF NOT EXISTS enterprise.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const history = await client.query<{ version: string; checksum: string }>('SELECT version,checksum FROM enterprise.schema_migrations ORDER BY version');
    const known = new Map<string, (typeof files)[number]>(files.map(file => [file.version, file]));
    if (history.rows.some(row => !known.has(row.version))) throw new Error('ENTERPRISE_UNKNOWN_MIGRATION');
    for (const row of history.rows) {
      if (known.get(row.version)!.checksum !== row.checksum) throw new Error('ENTERPRISE_MIGRATION_CHECKSUM_MISMATCH');
    }
    // history 必須正好是已知清單的前綴，避免跳版或只剩較新版本的狀態被當成可繼續。
    if (history.rows.some((row, index) => files[index]?.version !== row.version)) throw new Error('ENTERPRISE_MIGRATION_HISTORY_GAP');
    const applied = files.slice(0, history.rows.length);
    const appliedVersions: string[] = [];
    if (options.direction === 'up') {
      for (const file of files.slice(history.rows.length)) {
        await client.query(file.up);
        await client.query('INSERT INTO enterprise.schema_migrations(version,checksum) VALUES ($1,$2)', [file.version, file.checksum]);
        appliedVersions.push(file.version);
      }
    } else if (applied.length > 0) {
      const tables = applied.flatMap(file => file.tables);
      if (!options.allowDataLoss) {
        // owner 也受 FORCE RLS：先在本交易解除 FORCE 以完整檢查資料；拒絕時 ROLLBACK 會恢復 FORCE。
        for (const table of tables) await client.query(`ALTER TABLE enterprise.${table} NO FORCE ROW LEVEL SECURITY`);
        const counts = await client.query<{ has_data: boolean }>(`SELECT ${tables.map(table => `EXISTS(SELECT 1 FROM enterprise.${table})`).join(' OR ')} AS has_data`);
        if (counts.rows[0].has_data) throw new Error('ENTERPRISE_DOWN_REQUIRES_ALLOW_DATA_LOSS');
      }
      for (const file of [...applied].reverse()) {
        await client.query(file.down);
        await client.query('DELETE FROM enterprise.schema_migrations WHERE version=$1', [file.version]);
        appliedVersions.push(file.version);
      }
    }
    await client.query('COMMIT');
    return { version: files[files.length - 1].version, direction: options.direction, applied: appliedVersions.length > 0, appliedVersions };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
