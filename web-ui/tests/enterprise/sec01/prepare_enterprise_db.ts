// SEC-01 harness 的資料庫準備：重建合成 QA DB 的 enterprise schema、套用 migration、初始化一個組織與管理員。
// 只接受 dhc_e02a_qa_* 合成資料庫名稱；密碼只來自環境變數。
import path from 'node:path';

import { Pool } from 'pg';

import { bootstrapEnterpriseOrganization, runEnterpriseMigrations } from '../../../server/modules/enterprise-persistence/index.js';

const database = process.env.E02A_TEST_DATABASE ?? '';
if (!/^dhc_e02a_qa_[a-f0-9]+$/.test(database)) throw new Error('synthetic QA database required');
const config = { host: '127.0.0.1', port: Number(process.env.E02A_TEST_PORT), database, max: 1 };
const admin = new Pool({ ...config, user: 'dhc_bootstrap', password: process.env.E02A_TEST_ADMIN_PASSWORD });
const migrator = new Pool({ ...config, user: 'dhc_migrator', password: process.env.E02A_TEST_MIGRATOR_PASSWORD });
try {
  await admin.query('DROP SCHEMA enterprise CASCADE; CREATE SCHEMA enterprise AUTHORIZATION dhc_migrator; GRANT USAGE ON SCHEMA enterprise TO dhc_app');
  await runEnterpriseMigrations(migrator, { directory: path.resolve('db/enterprise/migrations'), direction: 'up' });
  const result = await bootstrapEnterpriseOrganization(migrator, {
    slug: 'sec01', name: 'SEC-01 合成公司', adminEmail: 'admin@sec01.example.invalid', adminPassword: process.env.SEC01_ADMIN_PASSWORD,
  });
  console.log(JSON.stringify({ prepared: true, organizationId: result.organizationId }));
} finally {
  await Promise.all([admin.end(), migrator.end()]);
}
