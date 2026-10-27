// DHC CLI 版本更新清單（右側「版本更新」視窗讀的 dhc-releases.json）。
// 唯一來源：clone 的 public/dhc-releases.json；這支把它複製到正式 dist 和 clone dist，兩邊永遠一致。
//   node release-notes.cjs sync       改完清單後跑：檢查格式並發布（前端改動要先上線 bundle 再跑）
//   node release-notes.cjs restarted  CloudCLI 重啟成功後跑（restart-cloudcli.cmd 會自動呼叫）：
//                                     把 "pending": "restart" 的項目轉成公開，時間改成重啟這一刻，再發布
// 要等重啟才生效的伺服器改動，項目先加 "pending": "restart"；視窗不顯示 pending 的項目。
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE;
const SOURCE = path.join(HOME, 'ai-tools', '_scans', 'src', 'claudecodeui', 'public', 'dhc-releases.json');
const TARGETS = [
  path.join(HOME, 'cc-host', 'node_modules', '@cloudcli-ai', 'cloudcli', 'dist', 'dhc-releases.json'),
  path.join(HOME, 'ai-tools', '_scans', 'src', 'claudecodeui', 'dist', 'dhc-releases.json'),
];
const LEVELS = ['high', 'mid', 'low'];
const KINDS = ['feature', 'ui', 'ux'];

const pad = (n) => String(n).padStart(2, '0');
const taipeiNow = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const mode = process.argv[2];
if (mode !== 'sync' && mode !== 'restarted') {
  console.error('用法：node release-notes.cjs sync | restarted');
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
if (!Array.isArray(data.entries)) throw new Error('entries 不是陣列');
const problems = [];
// 時間不能寫未來：清單只列已經能用的；寫錯時間也會讓排序亂掉。給 2 分鐘誤差。
const latestAllowed = (() => {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + 2 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
})();
const ids = new Set();
for (const e of data.entries) {
  if (ids.has(e.id)) problems.push(`id 重複：${e.id}`);
  ids.add(e.id);
  if (!e.pending && e.at > latestAllowed) problems.push(`時間在未來（現在約 ${taipeiNow()}）：${e.id} ${e.at}`);
  if (!e.id || !e.title || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(e.at || '')) problems.push(`格式不對：${e.id || e.title}`);
  if (!LEVELS.includes(e.level)) problems.push(`level 不對：${e.id}`);
  if (!KINDS.includes(e.kind)) problems.push(`kind 不對：${e.id}`);
  if (e.pending !== undefined && e.pending !== 'restart') problems.push(`pending 只能是 "restart"：${e.id}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

if (mode === 'restarted') {
  const at = taipeiNow();
  const published = data.entries.filter((e) => e.pending === 'restart');
  for (const e of published) {
    delete e.pending;
    e.at = at;
  }
  data.entries.sort((a, b) => b.at.localeCompare(a.at));
  fs.writeFileSync(SOURCE, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`[release-notes] 重啟後公開 ${published.length} 筆：${published.map((e) => e.id).join(', ') || '無'}`);
}

const text = fs.readFileSync(SOURCE);
for (const target of TARGETS) {
  if (fs.existsSync(path.dirname(target))) fs.writeFileSync(target, text);
}
const pendingCount = data.entries.filter((e) => e.pending).length;
console.log(`[release-notes] 已發布 ${data.entries.length - pendingCount} 筆，等重啟 ${pendingCount} 筆`);
