// DHC CLI 警示（側欄重新整理鈕旁的盾牌）：主機腳本用這支新增或列出警示。
// 存在 user_preferences 全站鍵 dhc.alerts，走本機 CloudCLI API（127.0.0.1:3001）。
//
//   node alert.cjs add <info|warn|danger> "<標題>" ["<說明>"] [--source 來源] [--key 去重鍵]
//   node alert.cjs list
//   node alert.cjs resolve <去重鍵開頭> [--by 誰]
//
// --key：同一個鍵還有未處理的警示時不重複新增（例如每 5 分鐘巡檢都撞到同一件事）。
// 標題與說明會顯示給所有使用者看，不要放密碼、金鑰原文或客戶資料。
const BASE = process.env.TASUI_BASE || 'http://127.0.0.1:3001';
const KEY = 'dhc.alerts';
const MAX_ITEMS = 200;

async function readAlerts() {
  const response = await fetch(`${BASE}/api/user/preferences`);
  if (!response.ok) throw new Error(`讀取失敗 HTTP ${response.status}`);
  const items = (await response.json()).preferences?.[KEY]?.items;
  return Array.isArray(items) ? items : [];
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const at = args.indexOf(name);
    if (at < 0) return '';
    const [, value] = args.splice(at, 2);
    return value || '';
  };
  const source = flag('--source') || '主機';
  const dedupeKey = flag('--key');
  const resolvedBy = flag('--by');
  const [command, level, title, detail = ''] = args;

  if (command === 'list') {
    for (const item of await readAlerts()) {
      console.log(`${item.resolvedAt ? '[已處理]' : '[待處理]'} ${item.level} ${item.createdAt} ${item.title}`);
    }
    return;
  }
  if (command === 'resolve') {
    // node alert.cjs resolve <去重鍵開頭> [--by 誰]：把鍵以此開頭、還沒處理的警示標成已處理（例：隔天自動收掉 Cloudflare 用量警示）。
    const prefix = level;
    if (!prefix) { console.error('用法：node alert.cjs resolve <去重鍵開頭> [--by 誰]'); process.exit(2); }
    const items = await readAlerts();
    const now = new Date().toISOString();
    let count = 0;
    const next = items.map((item) => {
      if (item.resolvedAt || !String(item.key || '').startsWith(prefix)) return item;
      count++;
      return { ...item, resolvedAt: now, resolvedBy: resolvedBy || '自動' };
    });
    if (!count) { console.log('沒有要收的警示'); return; }
    const response = await fetch(`${BASE}/api/user/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [KEY]: { items: next } }),
    });
    if (!response.ok) throw new Error(`寫入失敗 HTTP ${response.status}`);
    console.log(`已收掉 ${count} 則警示`);
    return;
  }
  if (command !== 'add' ||!['info', 'warn', 'danger'].includes(level) || !title) {
    console.error('用法：node alert.cjs add <info|warn|danger> "<標題>" ["<說明>"] [--source 來源] [--key 去重鍵]');
    process.exit(2);
  }

  const items = await readAlerts();
  if (dedupeKey && items.some((item) => item.key === dedupeKey && !item.resolvedAt)) {
    console.log('同鍵警示尚未處理，略過');
    return;
  }
  const alert = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    level,
    title: title.slice(0, 80),
    detail: detail.slice(0, 1000),
    source,
    createdAt: new Date().toISOString(),
    ...(dedupeKey ? { key: dedupeKey } : {}),
  };
  const next = [alert, ...items].slice(0, MAX_ITEMS);
  const response = await fetch(`${BASE}/api/user/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [KEY]: { items: next } }),
  });
  if (!response.ok) throw new Error(`寫入失敗 HTTP ${response.status}`);
  console.log(`已新增警示 ${alert.id}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
