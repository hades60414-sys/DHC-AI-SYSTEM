// 11/02 程式先查（MausBot quiet routines）：中台小助理內建巡查「卡住與用量哨兵」每小時先跑這支。
// 沒有異常就什麼都不印（exit 0）→ 小助理不叫模型；有異常就每項印一行 → 模型從這裡開始查證。
// 只讀 log 與 runstate.js，不改任何東西。檔案讀不到就印「查不到」那一行（交給模型判斷）。
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const HOUR = 3600_000;
const now = Date.now();
const found = [];

// 本機時間（台北）的 "YYYY-MM-DD HH:MM:SS" 開頭的行，最近一小時內的
function recentLocal(file, pattern) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { found.push(`查不到 ${file}`); return []; }
  return text.split(/\r?\n/).slice(-400).filter((line) => {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(line);
    return m && now - Date.parse(`${m[1]}T${m[2]}+08:00`) <= HOUR && pattern.test(line);
  });
}

const health = recentLocal(process.env.PRECHECK_HEALTH || 'D:\\TAS\\cc-hosts\\health-check.log', /FAIL|DOWN|restart|tunnel|answers 0/i);
if (health.length) found.push(`健康檢查最近一小時 ${health.length} 筆異常，最後一筆：${health.at(-1).slice(0, 200)}`);

const kills = recentLocal(process.env.PRECHECK_MEM || 'D:\\TAS\\cc-hosts\\node-mem-guard.log', /killed/i);
if (kills.length) found.push(`記憶體防護最近一小時砍了 ${kills.length} 個程序，最後一筆：${kills.at(-1).slice(0, 200)}`);

try {
  const lines = fs.readFileSync('D:\\TAS\\cc-web\\auto-resume.log', 'utf8').split(/\r?\n/).slice(-200);
  const limits = lines.filter((line) => / limit /.test(line) && now - Date.parse(line.slice(0, 24)) <= HOUR);
  if (limits.length) found.push(`最近一小時有 ${limits.length} 個對話撞額度，最後一筆：${limits.at(-1).slice(0, 200)}`);
} catch {}

// RUNNING 但超過 60 分鐘沒有新紀錄 = 可能卡住
try {
  const out = execFileSync(process.execPath, ['D:\\TAS\\cc-web\\runstate.js'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  for (const line of out.split(/\r?\n/)) {
    const m = /^RUNNING\s+(\S+)\s+(\S+Z)\s+(\S+)/.exec(line);
    if (m && now - Date.parse(m[2]) > HOUR) found.push(`對話 ${m[3]}（${m[1]}）顯示執行中，但已 ${Math.round((now - Date.parse(m[2])) / 60000)} 分鐘沒有新紀錄`);
  }
} catch {
  found.push('runstate.js 跑不起來，查不到有沒有卡住的對話');
}

if (found.length) console.log(found.join('\n'));
