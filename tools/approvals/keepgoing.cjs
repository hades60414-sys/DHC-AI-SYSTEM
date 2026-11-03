// 時限續做（2026-11-03）：使用者說「到 8 點前隨便你」「再試兩小時」時，時限內對話每次閒下來就叫醒它接著做。
// 起因：11-03 夜裡使用者給到 08:00，AI 02:43 把待決定的事列完就結束回合，之後沒有東西叫醒它，一路閒到 07:26。
// 借 ralph-loop 的兩個點子（完成標記、次數上限），但不用 Stop hook 硬擋：等對話閒著才送，背景子代理、等待都不受影響。
//   node keepgoing.cjs start <Claude sessionId> --until <HH:MM 或 ISO> [--goal "<目標>"]   （UserPromptSubmit hook 會自動呼叫）
//   node keepgoing.cjs stop <sessionId> | list | tick [--dry]                                （tick 由 watch.cjs 每分鐘呼叫）
// 每次叫醒間隔至少 5 分鐘、最多 40 次；回覆裡寫「【時限工作完成】」就停；時間到送一次收尾訊息後結束。
const fs = require('node:fs'), path = require('node:path');
const L = require('./lib.cjs');
const { state, send, transcript, lastText, cloudRow } = require('./wake.cjs');

const KDIR = process.env.KEEPGOING_DIR || path.join(__dirname, 'keepgoing');
const GAP_MS = 5 * 60e3, MAX = 40, DONE = '【時限工作完成】';
const kp = (sid) => path.join(KDIR, sid + '.json');
const list = () => fs.existsSync(KDIR) ? fs.readdirSync(KDIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(KDIR, f), 'utf8'))) : [];
const hhmm = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
const ckpt = (sid) => path.join(KDIR, sid + '.md');

function start(sid, until, goal) {
  if (!/^[0-9a-f-]{36}$/.test(sid || '')) throw new Error('sessionId 格式不對');
  const u = Date.parse(until); if (!(u > Date.now())) throw new Error('時限要在未來：' + until);
  fs.mkdirSync(KDIR, { recursive: true });
  const k = { sid, until: new Date(u).toISOString(), goal: goal || '', created: new Date().toISOString(), lastNudge: Date.now(), nudges: 0 };
  fs.writeFileSync(kp(sid), JSON.stringify(k, null, 1), 'utf8');
  L.log(`keepgoing-start\t${sid}\tuntil=${k.until}`);
  return k;
}
function stop(sid, why) {
  if (!fs.existsSync(kp(sid))) return false;
  fs.renameSync(kp(sid), path.join(KDIR, `${sid}.${Date.now()}.done`));
  L.log(`keepgoing-stop\t${sid}\t${why}`);
  return true;
}

async function tick({ dry = false, now = Date.now() } = {}) {
  const out = [];
  for (const k of list()) {
    const file = transcript(k.sid);
    if (!file) { if (!dry) stop(k.sid, '找不到對話紀錄'); out.push(`${k.sid} 停：找不到對話紀錄`); continue; }
    if ((lastText(file) || '').includes(DONE)) { if (!dry) stop(k.sid, '回覆寫了完成標記'); out.push(`${k.sid} 停：已寫完成標記`); continue; }
    const s = state(file), row = cloudRow(k.sid);
    if (!row) { if (!dry) stop(k.sid, '不是網頁版對話'); out.push(`${k.sid} 停：不是網頁版對話`); continue; }
    if (!s.idle || s.quietSec < 120) { out.push(`${k.sid} 等：對話在忙或剛結束（${s.quietSec}s）`); continue; }
    const expired = now > Date.parse(k.until);
    if (!expired && (now - k.lastNudge < GAP_MS)) { out.push(`${k.sid} 等：距上次叫醒不到 5 分鐘`); continue; }
    if (!expired && k.nudges >= MAX) { if (!dry) stop(k.sid, `叫醒已達 ${MAX} 次`); out.push(`${k.sid} 停：叫醒次數到上限`); continue; }
    const left = Math.round((Date.parse(k.until) - now) / 60e3);
    const msg = expired
      ? `【時限續做】時間到了（${hhmm(Date.parse(k.until))}）。停手：把做到一半的收好（能回退的留備份），寫一份總結給使用者：做了什麼（路徑）、怎麼驗證、回退指令、還沒做的與原因。不要再開新工作。`
      : `【時限續做】使用者給的時限到 ${hhmm(Date.parse(k.until))}，還有 ${left} 分鐘${k.goal ? `，目標：${k.goal}` : ''}。` +
        `先讀（沒有就建立）checkpoint ${ckpt(k.sid)}：完成條件、已做、待做、證據、下一步，每做完一項就更新。接著做下一項；紅線項目留給使用者，先做不依賴它的。` +
        `不要只回報狀態就停。全部做完並驗證過，就在回覆裡寫「${DONE}」，之後不再叫醒。`;
    if (dry) { out.push(`${k.sid} 會叫醒：${msg.slice(0, 60)}…`); continue; }
    await send(row.session_id, row.model || 'default', s.mode, msg);
    if (expired) stop(k.sid, '時間到，已送收尾'); else { k.lastNudge = now; k.nudges++; fs.writeFileSync(kp(k.sid), JSON.stringify(k, null, 1), 'utf8'); }
    L.log(`keepgoing-nudge\t${k.sid}\t${expired ? 'final' : '#' + k.nudges}`);
    out.push(`${k.sid} 已叫醒${expired ? '（收尾）' : ` #${k.nudges}`}`);
  }
  return out;
}

if (require.main === module) {
  const [op, sid] = process.argv.slice(2), arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
  (async () => {
    if (op === 'start') { let u = arg('until'); if (/^\d{1,2}:\d{2}$/.test(u)) { const [h, m] = u.split(':').map(Number); const d = new Date(Date.now() + 8 * 3600e3); d.setUTCHours(h, m, 0, 0); let t = d.getTime() - 8 * 3600e3; if (t <= Date.now()) t += 864e5; u = new Date(t).toISOString(); } const k = start(sid, u, arg('goal')); return console.log(`已登記：到 ${hhmm(Date.parse(k.until))}`); }
    if (op === 'stop') return console.log(stop(sid, '手動') ? '已停' : '沒有這筆');
    if (op === 'list') { for (const k of list()) console.log(`${k.sid}\t到 ${hhmm(Date.parse(k.until))}\t已叫醒 ${k.nudges} 次\t${k.goal}`); return; }
    if (op === 'tick') return console.log((await tick({ dry: process.argv.includes('--dry') })).join('\n') || '沒有時限工作');
    throw new Error('用法：node keepgoing.cjs start <sid> --until HH:MM [--goal x] | stop <sid> | list | tick [--dry]');
  })().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { start, stop, tick, list, DONE, KDIR };
