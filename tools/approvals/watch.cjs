// 每分鐘由排程 TAS-Approvals-Watch 叫一次：找出使用者已按鈕的核准單，交給 run.cjs（run.cjs 會再核對一次）。
// 不經過小助手模型：按鈕訊息只是「同意」的紀錄，執行由這支程式負責。
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const L = require('./lib.cjs');

async function main() {
  if (!fs.existsSync(L.DIR)) return;
  const pending = fs.readdirSync(L.DIR).filter((f) => /^[0-9a-f]{6}\.json$/.test(f))
    .map((f) => L.load(f.slice(0, 6)))
    .filter((t) => t.status === 'pending' && Date.now() <= Date.parse(t.expires));
  const byRoom = {};
  for (const t of pending) (byRoom[t.room] ||= []).push(t);
  for (const [room, ts] of Object.entries(byRoom)) {
    const msgs = await L.readMsgs(room);
    for (const t of ts) {
      const clicked = msgs.some((m) => m.by !== L.ASSISTANT && String(m.text || '').trim() === t.button && Date.parse(m.at) > Date.parse(t.created));
      if (!clicked) continue;
      try { execFileSync(process.execPath, [path.join(__dirname, 'run.cjs'), t.id], { stdio: 'inherit' }); }
      catch { /* run.cjs 自己會記錄失敗並貼回聊天室 */ }
    }
  }
}
main().catch((e) => { L.log('watch-error\t' + e.message); process.exitCode = 1; });
