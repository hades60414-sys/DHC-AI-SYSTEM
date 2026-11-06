import { Pool } from 'pg';

import { bootstrapEnterpriseOrganization, setEnterpriseSubscriptionBySlug } from './index.js';

// 由操作員在安裝時執行；不由 server/index.ts 載入，不提供網路 API。管理員密碼只從環境變數讀取，不接受命令列參數。
const [command, ...args] = process.argv.slice(2);
const usage = [
  'Usage: enterprise-admin.cli.js bootstrap <organization-slug> <organization-name> <admin-email>  (password from ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD)',
  '       enterprise-admin.cli.js subscription <organization-slug> <plan> <status> <period-start> <period-end> <reason>  (vendor operation, audited)',
].join('\n');
if (!((command === 'bootstrap' && args.length === 3) || (command === 'subscription' && args.length === 6))) {
  console.error(usage);
  process.exitCode = 2;
} else if (process.env.ENTERPRISE_DB_USER !== 'dhc_migrator' || !process.env.ENTERPRISE_DB_PASSWORD) {
  console.error('Bootstrap requires dedicated dhc_migrator credentials');
  process.exitCode = 2;
} else {
  const pool = new Pool({
    host: process.env.ENTERPRISE_DB_HOST, port: Number(process.env.ENTERPRISE_DB_PORT || '5432'),
    database: process.env.ENTERPRISE_DB_NAME, user: 'dhc_migrator', password: process.env.ENTERPRISE_DB_PASSWORD,
    max: 1, connectionTimeoutMillis: 10000, statement_timeout: 30000,
  });
  try {
    const result = command === 'bootstrap'
      ? await bootstrapEnterpriseOrganization(pool, { slug: args[0], name: args[1], adminEmail: args[2], adminPassword: process.env.ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD })
      : await setEnterpriseSubscriptionBySlug(pool, { slug: args[0], planKey: args[1], status: args[2], periodStart: args[3], periodEnd: args[4], reason: args[5],
        actor: `cli:${process.env.USER ?? 'operator'}` });
    console.log(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('ENTERPRISE_') ? error.message : 'ENTERPRISE_BOOTSTRAP_FAILED';
    console.error(message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
