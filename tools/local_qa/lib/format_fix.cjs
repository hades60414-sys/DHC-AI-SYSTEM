'use strict';
// 用程式修格式（2026-09-30 晚上）：模型常見的引用與 STATUS 寫法錯誤，能確定意思的就直接修，不必叫模型整題重寫。
// 只動寫法、不動內容；段落編號只修「可見段落」裡真的有的，編錯或不存在的編號照樣留給檢查去標。
// C# 版在 gemma-offline\agent-channel\DocQa.cs（FixFormat），兩邊用 format-fix-parity.json 逐題比對。
const ID = '[^\\s\\[\\]()（）【】,，、;；]+#\\d+(?:-\\d+)?';
const STATUS_LINE = /^\s*[*_`>]*\s*STATUS\s*[:：]\s*[*_`]*\s*(ANSWER|NO_INFO|CONFLICT|DENIED)\s*[*_`]*\s*[。.]?\s*$/i;

function fixFormat(text, visible) {
  const vis = new Set(visible || []);
  let t = String(text ?? '');
  // （X#01）、(X#01)、【X#01】 → [X#01]
  t = t.replace(new RegExp(`[（(【]\\s*(${ID})\\s*[）)】]`, 'g'), (m, id) => vis.has(id) ? `[${id}]` : m);
  // [MAP:X#01] → [X#01]（MAP 只該接文件代碼，不該接段落編號）
  t = t.replace(new RegExp(`\\[\\s*MAP\\s*[:：]\\s*(${ID})\\s*\\]`, 'gi'), (m, id) => vis.has(id) ? `[${id}]` : m);
  // [X#01, Y#02] → [X#01][Y#02]
  t = t.replace(new RegExp(`\\[\\s*(${ID}(?:\\s*[,，、;；]\\s*${ID})+)\\s*\\]`, 'g'), (m, inner) => {
    const ids = inner.split(/\s*[,，、;；]\s*/);
    return ids.every(id => vis.has(id)) ? ids.map(id => `[${id}]`).join('') : m;
  });
  // STATUS 行：只有一行時，去掉粗體／句點、統一寫法，並移到最後一行
  const lines = t.split(/\r?\n/), hits = lines.map((l, i) => [i, l.match(STATUS_LINE)]).filter(x => x[1]);
  let lastUsed = lines.length - 1; while (lastUsed >= 0 && !lines[lastUsed].trim()) lastUsed--;
  if (hits.length === 1 && !(hits[0][0] === lastUsed && lines[lastUsed].trim() === 'STATUS: ' + hits[0][1][1].toUpperCase())) {   // 已經正確就不動
    const [i, m] = hits[0];
    lines.splice(i, 1);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    t = lines.join('\n') + '\n\nSTATUS: ' + m[1].toUpperCase();
  }
  return t;
}
// 模型只回 STATUS 時的整理：取第一個像 STATUS 的值
function statusFromReply(reply) {
  const m = String(reply ?? '').match(/STATUS\s*[:：]\s*[*_`]*\s*(ANSWER|NO_INFO|CONFLICT|DENIED)/i) || String(reply ?? '').trim().match(/^[*_`]*(ANSWER|NO_INFO|CONFLICT|DENIED)[*_`。.]*$/i);
  return m ? 'STATUS: ' + m[1].toUpperCase() : null;
}
const STATUS_ONLY_PROMPT = '你的回答少了最後的 STATUS 行。只回一行，不要其他文字，從下列選一個：STATUS: ANSWER、STATUS: NO_INFO、STATUS: CONFLICT、STATUS: DENIED';

module.exports = { fixFormat, statusFromReply, STATUS_ONLY_PROMPT, STATUS_LINE };
