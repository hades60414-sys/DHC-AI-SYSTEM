// 不返工收下率 v2：「宣稱完成 → 同對話下一則使用者訊息」逐對交給 haiku 判讀（claude -p，每批 20 對、回 JSON）。
// A＝說成果錯了／沒做完／要重做；C＝對成果的小幅調整或偏好；B＝同意、新需求、問問題、與成果無關。
// 用法：node rw-judge.cjs   結果寫 rw-judge.json。11-03 與人工 40 則比對：sonnet＋本提示一致率 88–93%（haiku 75%，返工類只抓到一半）。
const fs = require('fs'), { execFileSync } = require('child_process');
const { claims, users, SINCE } = require('./rw-data.cjs');
const rec = claims.filter((c) => c.ts >= SINCE);
const pairs = rec.map((c) => ({ c, u: users.filter((u) => u.sid === c.sid && u.ts > c.ts).sort((a, b) => a.ts - b.ts)[0] })).filter((p) => p.u);
const clip = (s, n) => s.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').slice(0, n);
const CLAUDE = 'D:/TAS/cc-host/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const out = [];
for (let i = 0; i < pairs.length; i += 20) {
  const batch = pairs.slice(i, i + 20);
  const prompt = '下面每一對是：AI 回報工作完成的訊息（節錄）、使用者接著回的下一則。判斷使用者那則屬於哪類：\n' +
    'A＝指出 AI 剛交的成果有錯、沒做完、看錯或誤解需求、質疑 AI 的做法（例如「你為什麼還有子代理在跑」「重看一次我的圖」「感覺沒什麼進度」「重做」）；' +
    'C＝成果被接受，但對剛交的東西要求小幅修改或換偏好（例如「改成向左」「金色紫色互換」）；' +
    'B＝同意、批准、新增另一個功能或需求、問問題、補充資訊、與剛交的成果無關。新需求即使用了「改」「拿掉」也是 B，除非是在修正 AI 剛做錯的地方。\n' +
    '只輸出一個 JSON 陣列，例如 [{"i":0,"k":"B"}]，不要其他文字。\n\n' +
    batch.map((p, j) => `#${j}\nAI：${clip(p.c.text, 700)}\n使用者：${clip(p.u.text, 200)}`).join('\n\n');
  let r = '', arr = [];
  // 失敗重試，最多 3 次（11-03 第一次跑有一批 0/20）
  for (let tries = 0; tries < 3 && arr.length === 0; tries++) {
    try { r = execFileSync(CLAUDE, ['-p', '--model', process.env.RW_MODEL || 'sonnet', '--output-format', 'text'], { input: prompt, encoding: 'utf8', cwd: 'D:/TAS/tmp', timeout: 180000 }); } catch (e) { r = String(e.stdout || ''); }
    const m = r.match(/\[[\s\S]*\]/);
    try { arr = JSON.parse(m ? m[0] : '[]'); } catch {}
  }
  batch.forEach((p, j) => out.push({ sid: p.c.sid, ts: p.c.ts, user: clip(p.u.text, 80), k: (arr.find((x) => x.i === j) || {}).k || '?' }));
  console.log(`批 ${i / 20 + 1}：${arr.length}/${batch.length} 有判讀`);
}
fs.writeFileSync(__dirname + '/rw-judge.json', JSON.stringify(out, null, 1));
const cnt = (k) => out.filter((x) => x.k === k).length;
console.log(JSON.stringify({ pairs: out.length, A: cnt('A'), C: cnt('C'), B: cnt('B'), unknown: cnt('?'),
  strictAccepted: ((1 - cnt('A') / out.length) * 100).toFixed(1) + '%', acceptedNoChange: ((1 - (cnt('A') + cnt('C')) / out.length) * 100).toFixed(1) + '%' }));
