// 觀察者量測①基準：使用者「光回一句好」（AI 的選單／問句沒帶來新資訊）占使用者訊息的比例，turn-end-guard 上線前後對照。
// 只讀本機對話紀錄；只算 Harness優化 工作區、人打的字串訊息（排除系統通知、工具結果、續接訊息）。
const fs = require('fs'), path = require('path');
const dir = 'C:/Users/demo/.claude/projects/D--TAS-Claude-Code---Harness--';
const HOOK_ON = Date.parse('2026-10-28T05:57:00Z'); // turn-end-guard B 類上線時間；after＝之後全部
// 事先固定的規則（觀察者要求：先固定 regex，不能邊量邊放寬）
const ASSENT = /^(好|好的|好啊|好喔|可以|行|ok|OK|Ok|嗯|對|是|沒問題|同意|照做|都做|都可以|都好|全部做|全部|做一做|做吧|做|就這樣|go|Go|yes|Yes|都OK|都ok|OK都做|ok都做)[!！。.～~啦喔吧啊阿]*$|^(都做一做|做一做啦|全部做一做|都先OK|直接做|你決定|你看著辦|隨便你)/;
const ITEMIZED = /(^|\s)[1-9１-９][.、:：)）]?\s*(可以|好|不要|先不要|OK|ok|沒有|有|改|用)/;
const out = { before: { msgs: 0, assent: 0, itemized: 0 }, after: { msgs: 0, assent: 0, itemized: 0 } };
const samples = [];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' || typeof o.message?.content !== 'string' || o.isSidechain) continue;
    if (!/Harness優化/.test(o.cwd || '')) continue;
    const s = o.message.content.trim();
    if (!s || s.startsWith('<') || s.startsWith('【') || s.startsWith('[') || /^Caveat:|^This session is being continued/.test(s)) continue;
    const ts = Date.parse(o.timestamp); if (!ts) continue;
    const b = ts < HOOK_ON ? out.before : out.after;
    b.msgs++;
    const short = s.replace(/\s+/g, '');
    if (short.length <= 12 && ASSENT.test(short)) { b.assent++; if (samples.length < 400) samples.push([ts < HOOK_ON ? '前' : '後', s]); }
    if (ITEMIZED.test(s)) b.itemized++;
  }
}
for (const k of ['before', 'after']) { const b = out[k]; b.assentPct = (b.assent / Math.max(1, b.msgs) * 100).toFixed(1) + '%'; b.itemizedPct = (b.itemized / Math.max(1, b.msgs) * 100).toFixed(1) + '%'; }
console.log(JSON.stringify(out));
const cnt = {}; for (const [, s] of samples) cnt[s] = (cnt[s] || 0) + 1;
console.log(Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([s, n]) => `${s}×${n}`).join('  '));
