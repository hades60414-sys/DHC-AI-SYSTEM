// 5 小時用量：--loop 每 30 秒呼叫 poll() 寫 usage.json；hook 與交工流程用 effective() 讀。
// 來源：cc-web 的 seal-proxy http://127.0.0.1:3002/_usage（x-tasui-edge 用 cc-web\.env 的 TASUI_EDGE_SEAL）。
// 環境變數 TAKEOVER_USAGE_OVERRIDE=86 可直接覆寫百分比（測試用，不耗用量）。
// 讀不到就保留舊值並標 stale=true；effective() 對太舊（>10 分鐘）或視窗已重置的值一律當作「不知道」，讓 hook 放行。
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const FILE = process.env.TAKEOVER_USAGE_FILE || path.join(__dirname, 'usage.json');
const ENV_FILE = 'D:/TAS/cc-web/.env';
const MAX_AGE_MS = 10 * 60e3;

function seal() {
  try { const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^TASUI_EDGE_SEAL=(.*)$/m); return m ? m[1].trim().replace(/^"|"$/g, '') : ''; } catch { return ''; }
}

function fetchUsage() {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:3002/_usage', { headers: { 'x-tasui-edge': seal() }, timeout: 5000 }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (d) => b += d);
      res.on('end', () => { try { const j = JSON.parse(b); j.session && typeof j.session.percent === 'number' ? resolve(j) : reject(new Error('回應沒有 session.percent')); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('逾時')));
    req.on('error', reject);
  });
}

function readFile() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } }

// 寫 usage.json：成功＝新值＋read_at；失敗＝保留舊值、stale=true、記錯誤。
async function poll() {
  const old = readFile() || {};
  let next;
  try { const u = await fetchUsage(); next = { read_at: new Date().toISOString(), stale: false, session: u.session, weekly_all: u.weekly_all, fetched_at: u.fetched_at }; }
  catch (e) { next = { ...old, stale: true, error: String(e.message || e).slice(0, 120), last_try: new Date().toISOString() }; }
  fs.writeFileSync(FILE, JSON.stringify(next, null, 1));
  return next;
}

// hook 用：回傳 { percent, key, reason }。percent=null 表示不知道（檔案壞了、太舊、視窗已重置）→ 呼叫端一律放行。
// key 是這個 5 小時視窗的識別（resets_at），用來讓「每個視窗只提醒一次」。
function effective(now = Date.now()) {
  const ov = process.env.TAKEOVER_USAGE_OVERRIDE;
  if (ov !== undefined && ov !== '' && !isNaN(Number(ov))) return { percent: Number(ov), key: process.env.TAKEOVER_USAGE_KEY || 'override', reason: 'override' };
  const u = readFile();
  if (!u || !u.session || typeof u.session.percent !== 'number') return { percent: null, reason: 'usage.json 讀不到或格式不對' };
  const readAt = Date.parse(u.read_at || '');
  if (!(now - readAt <= MAX_AGE_MS)) return { percent: null, reason: 'usage.json 超過 10 分鐘沒更新' };
  const reset = Date.parse(u.session.resets_at || '');
  if (reset && reset < now) return { percent: null, reason: '視窗已重置，數值過期' };
  return { percent: u.session.percent, key: String(u.session.resets_at || '').slice(0, 16) /* 到分鐘；resets_at 的小數秒每次讀都不同，整串當視窗識別會重複提醒 */, reason: 'ok' };
}

module.exports = { poll, fetchUsage, effective, FILE };
if (require.main === module) {
  (process.argv.includes('--poll') ? poll().then((u) => console.log(JSON.stringify(u))) : Promise.resolve(console.log(JSON.stringify(effective())))).catch((e) => { console.error(e); process.exit(1); });
}
