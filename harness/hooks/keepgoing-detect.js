// 時限續做的登記（UserPromptSubmit，2026-11-03）：使用者訊息像「到 8 點前隨便你」「再試兩小時」就登記時限，
// 需先配置 das-hooks.json 的 toolsRoot、workspaces、keepgoingEnabled，並設好 approvals/watch。
// 說「停／先停／不用做了」就取消；未啟用時不登記，也不承諾自動叫醒。
const NUM = { 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 半: 0.5 };
const TW = 8 * 3600e3;

// 回傳 { until: 毫秒 } 或 { cancel: true } 或 null
function parse(text, now = Date.now()) {
  const s = String(text || '').replace(/\s+/g, '');
  if (/^(停|先停|停止|不用做了|不用了|先不要做了|別做了)[。!！]?$/.test(s)) return { cancel: true };
  let m = s.match(/(再|繼續|多)(試|做|跑|弄|玩|搞)?個?(\d+(?:\.\d+)?|[一兩二三四五六半])個?(半)?(小時|鐘頭)(半)?/);
  if (m) { const h = (NUM[m[3]] ?? Number(m[3])) + (m[4] || m[6] ? 0.5 : 0); if (h > 0 && h <= 12) return { until: now + h * 3600e3 }; }
  m = s.match(/(到|直到)(明天|今天)?(早上|上午|中午|下午|晚上)?(\d{1,2}|十[一二]?|[一二兩三四五六七八九])(點|:|：)(半|(\d{2}))?(前|為止|之前)?/);
  if (m && (m[8] || /隨便你|你做|你玩|你搞|繼續|自己/.test(s))) {
    const CN = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    let h = CN[m[4]] ?? Number(m[4]); const min = m[6] === '半' ? 30 : Number(m[7] || 0);
    if (h > 23 || min > 59) return null;
    if ((m[3] === '下午' || m[3] === '晚上') && h < 12) h += 12;
    const d = new Date(now + TW); d.setUTCHours(h, min, 0, 0);
    let t = d.getTime() - TW; if (t <= now) t += 864e5;
    if (t - now <= (m[2] === '明天' ? 24 : 14) * 3600e3) return { until: t };
  }
  return null;
}

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (c) => (input += c)).on('end', () => {
    try {
      const e = JSON.parse(input);
      const C = require('./das-config.js'), config = C.load();
      if (!config.keepgoingEnabled || !config.toolsRoot || !C.applies(e.cwd, config) || !e.session_id) return;
      const r = parse(e.prompt); if (!r) return;
      const K = require(require('path').join(config.toolsRoot, 'approvals', 'keepgoing.cjs'));
      let note;
      if (r.cancel) note = K.stop(e.session_id, '使用者說停') ? '已取消這個對話的時限續做。' : null;
      else {
        const k = K.start(e.session_id, new Date(r.until).toISOString(), String(e.prompt).slice(0, 80));
        const hm = new Date(Date.parse(k.until) + TW).toISOString().slice(11, 16);
        note = `已登記時限續做：到 ${hm}。時限內每次結束回合、對話閒下來 2 分鐘後，程式會叫醒你接著做（間隔至少 5 分鐘）。` +
          `把完成條件、已做、待做、證據寫在 checkpoint ${require('path').join(K.KDIR, e.session_id + '.md')}。紅線留給使用者，先做不依賴它的項目。全部做完並驗證過才寫「${K.DONE}」。`;
      }
      if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } }));
    } catch {}
  });
}
module.exports = { parse };
