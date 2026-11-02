// 回合結束守門（2026-10-28 使用者要求，盤點「需要介入過多」後做的）：
// A. 被背景通知喚醒後只回 "No response requested." 就停 → 擋下，要它接著做或交代一行狀態。
// B. 結尾在問使用者要不要做（選單、問句）→ 擋一次，提醒可回退又在範圍內的事直接做；真該問就直接結束。
// 重來那次（stop_hook_active）一律放行，不會無限迴圈。程式碼區塊不算結尾文字。
const EMPTY = /^No response requested\.?$/i;

// 結尾問使用者的樣子
const ASK = /(要不要|要我|需要我|是否要|是否需要|回覆?[「『][^」』\n]{1,12}[」』][^。\n]{0,6}[我就]|請選|可以嗎|好嗎|行嗎|OK 嗎|嗎[？?]|[？?]\s*$)/;
// 碰到紅線的問題本來就該問，不擋
const RED = /(確認執行|刪除|刪掉|清掉|清空|封存|移除|DROP|TRUNCATE|對外|寄出|寄給|發送|發給|送出|\bpush\b|\bPR\b|帳密|密碼|權限|付費|花錢|費用|算錢|金額|損益|部位|下單|正式|htdocs|取代|覆蓋|上架|排程|上線|部署|Python)/i;

function tail(text) {
  const prose = text.replace(/```[\s\S]*?```/g, ' ');
  const lines = prose.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).join('\n');
}

function verdict(e) {
  if (e.stop_hook_active) return null;
  const text = typeof e.last_assistant_message === 'string' ? e.last_assistant_message.trim() : '';
  // 2026-10-29：只吐一個看不見的組合字元（U+0338）就結束，舊版當成有回覆放行。沒有任何字母、數字、中文就算空回合。
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return '這回合沒有任何實際內容就結束了（空白或只有看不見的字元）。回到使用者這回合的要求接著做；' +
      '做不下去就用繁體中文說明卡在哪裡、下一步是什麼。';
  }
  if (EMPTY.test(text)) {
    return '這回合是被背景通知或系統訊息喚醒的，不要只回空話就停。先讀通知內容：原本的工作還沒完成就接著做；' +
      '真的沒事可做，就用一行繁體中文交代狀態（什麼還在跑、大約何時好、下一步是什麼）。';
  }
  const t = tail(text);
  // 2026-11-01：蒸餾模式（燒杯）每回合正事做完後附一題「🧪 蒸餾提問」，是使用者要的，不擋。
  if (/🧪 ?蒸餾提問/.test(t)) return null;
  if (!ASK.test(t) || RED.test(t)) return null;
  return '這則回覆的結尾在問使用者。使用者規則：可回退、又在這回合要求範圍內的事，直接照你建議的預設做完再回報，並列出做了哪些假設。' +
    '只有紅線（算錢／資料邏輯、刪資料、對外送出、帳密權限、花錢）、超出使用者這回合要的範圍，或缺了只有使用者知道的資訊時才問。' +
    '如果確實該問（或使用者這回合本來就要你問），只輸出「（等你回覆）」這五個字就結束，前面的內容使用者已經看到了，不要重寫或重複。';
}

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (c) => (input += c)).on('end', () => {
    try {
      const reason = verdict(JSON.parse(input));
      if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    } catch {}
  });
}

module.exports = { verdict };
