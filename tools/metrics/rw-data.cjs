// 不返工收下率的資料層（唯讀）：從 Harness優化 對話紀錄抽出「AI 宣稱完成」與使用者訊息，給 rw-judge.cjs 判讀。
// 11-03 試過用關鍵字直接判返工：收下率算出 99%，人工抽 40 則真返工 4 則只抓到 1 則，作廢；改由 rw-judge.cjs 交給模型判讀。
const fs = require('fs'), path = require('path');
const DIR = 'C:/Users/demo/.claude/projects/D--TAS-Claude-Code---Harness--';
const SINCE = Date.now() - 14 * 864e5, WIN = 7 * 864e5;
const DONE = /(已完成|完成了|已上線|上線了|已修好|修好了|已部署|部署好|RESULT OK|全部通過|全過|實測通過|已改好|改好了)/;
const FIX = /(怎麼(沒|還|又|不)|還是(不|沒|一樣|壞)|又(壞|錯|不行|掛)|不對|錯了|沒有?更新|沒生效|沒反應|看不到|壞掉|不能用|失敗了|沒成功|不是這樣|重做|改回來|根本(沒|不))/;
const FILE = /[\w.-]+\.(cjs|js|php|md|ps1|cmd|py|html|json)\b|index-[\w-]{6,}/g;
const claims = [], users = [];
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'))) {
  const sid = f.slice(0, 8); let lastA = null, cwd = '';
  const flush = () => { if (lastA && DONE.test(lastA.text)) claims.push({ sid, ...lastA, files: [...new Set(lastA.text.match(FILE) || [])] }); lastA = null; };
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.cwd) cwd = o.cwd; if (o.isSidechain || !/Harness優化/.test(cwd)) continue;
    const ts = Date.parse(o.timestamp); if (!ts) continue;
    const c = o.message?.content;
    // 帶圖片／附件的訊息是陣列格式（11-03 第一版漏了這 262 則）
    const ut = typeof c === 'string' ? c : Array.isArray(c) && !c.some((x) => x.type === 'tool_result')
      ? c.filter((x) => x.type === 'text').map((x) => x.text).filter((x) => !/^\[(Image|Request interrupted)/.test(x)).join('\n') : null;
    if (o.type === 'user' && ut != null) {
      const u = ut.trim();
      if (!u || /^[<【\[]/.test(u) || /^(Stop hook|Caveat:|This session)/.test(u)) continue;
      flush(); users.push({ sid, ts, text: u });
    }
    if (o.type === 'assistant' && Array.isArray(c)) { const t = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n'); if (t.trim()) lastA = { ts, text: t }; }
  }
  flush();
}
module.exports = { claims, users, SINCE };
