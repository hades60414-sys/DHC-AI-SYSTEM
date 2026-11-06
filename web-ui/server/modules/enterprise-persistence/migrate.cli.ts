import path from 'node:path';

import { Pool } from 'pg';

import { runEnterpriseMigrations } from './index.js';

// 由 Compose tools profile 或操作員執行；不由 server/index.ts 載入，不提供網路 API。
const direction = process.argv[2];
if ((direction !== 'up' && direction !== 'down') || process.argv.slice(3).some(arg => arg !== '--allow-data-loss')) {
  console.error('Usage: migrate.cli.js up|down [--allow-data-loss]');
  process.exitCode = 2;
} else if (process.env.ENTERPRISE_DB_USER !== 'dhc_migrator' || !process.env.ENTERPRISE_DB_PASSWORD) {
  console.error('Migration requires dedicated dhc_migrator credentials');
  process.exitCode = 2;
} else {
  const pool = new Pool({
    host: process.env.ENTERPRISE_DB_HOST, port: Number(process.env.ENTERPRISE_DB_PORT || '5432'),
    database: process.env.ENTERPRISE_DB_NAME, user: 'dhc_migrator', password: process.env.ENTERPRISE_DB_PASSWORD,
    max: 1, connectionTimeoutMillis: 10000, statement_timeout: 30000,
  });
  try {
    console.log(JSON.stringify(await runEnterpriseMigrations(pool, {
      directory: path.resolve('db/enterprise/migrations'), direction,
      allowDataLoss: process.argv.includes('--allow-data-loss'),
    })));
  } catch (error) {
    // 不輸出連線設定、密碼、SQL payload 或完整 driver error 物件。
    const message = error instanceof Error && error.message.startsWith('ENTERPRISE_') ? error.message : 'ENTERPRISE_MIGRATION_FAILED';
    console.error(message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
