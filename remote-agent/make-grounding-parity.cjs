'use strict';
// 產生 grounding-parity.json：C# Grounding.cs 要和 Node tools\local_qa\lib\grounding.cjs 逐題結果完全相同（紅、黃清單與順序）。
// 來源：合成題庫的 C# 最終版 37 份答案 + Node 版 37 份答案（只用合成文件），加上手寫的邊界案例。
//   node make-grounding-parity.cjs
const fs = require('fs'), path = require('path');
const WS = path.resolve(__dirname, '../..');
const { checkGrounding } = require(path.join(WS, 'tools/local_qa/lib/grounding.cjs'));
const rd = f => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const bank = require(path.join(WS, 'experiments/task_design_20260926/rag/cases.json'));
const cases = Object.fromEntries((bank.cases || bank).map(c => [c.case_id, c]));
const asOfDefault = (bank.defaults || {}).as_of_date || '';
const idx = JSON.parse(fs.readFileSync(path.join(WS, 'tools/local_qa/indexes/synthetic/index.json'), 'utf8'));
const store = Object.fromEntries((Array.isArray(idx) ? idx : idx.chunks).map(c => [c.chunk_id, c]));
const feed = c => { const m = c.metadata || {}; return `[${c.chunk_id}] ${m.title || c.doc_id} ${m.version || ''}｜${m.doc_type || ''}｜狀態:${m.status || '無'}｜公告:${m.publish_date || '無'}｜生效:${m.effective_date || '無'}｜廢止:${m.repealed_date || '無'}\n${c.section || ''}\n${c.text}`; };
const citedIds = t => [...new Set((String(t || '').match(/\[([^\[\]]+#\d+(?:-\d+)?)\]/g) || []).map(s => s.slice(1, -1)))];

const texts = {}, out = [];
function push(name, answer, cited, visible, extra) {
  const g = checkGrounding(answer, cited.map(id => texts[id]), visible.map(id => texts[id]), extra);
  out.push({ name, answer, cited, visible, extra, red: g.red.map(x => x.text), yellow: g.yellow.map(x => x.text) });
}
for (const [label, file] of [['csharp', path.join(WS, 'deploy_docqa_v3_20260930/rehearsal/records-final.ndjson')], ['node', path.join(WS, 'tools/local_qa/eval_runs/2026-09-29T162810852Z/records.ndjson')]]) {
  for (const r of rd(file)) {
    const text = r.text ?? r.answer; if (!text) continue;
    const vis = (r.visible_chunks || citedIds(text)).filter(id => store[id]); if (!vis.length) continue;
    for (const id of vis) texts[id] = feed(store[id]);
    const cit = citedIds(text).filter(id => store[id]); for (const id of cit) texts[id] = feed(store[id]);
    const c = cases[r.case_id] || {};
    push(label + ':' + r.case_id, text, cit.length ? cit : vis, vis, [c.question, c.as_of_date || asOfDefault, ...(c.history || []).map(h => h.content), ...(r.flags || []).map(f => f.text || '')].join('\n'));
  }
}
// 手寫邊界案例：H 開頭的段落只在這裡用
const H = (id, t) => { texts[id] = t; return id; };
const big = '9'.repeat(400);
H('H#01', '單筆上限為新台幣 500,000 元，年度總額 150,000,000 元。');
H('H#02', '應於三個營業日內完成，兩週內回報；逾期 1 次記點。');
H('H#03', '4. 通知：由風控通知交易員。\n第十二條 其他事項依公告。');
H('H#04', '每日 15:30 前上傳，中午 12:00 截止。');
H('H#05', '生效日 2026-03-23，公告日 2026/3/1。');
H('H#06', '檔案放在 D:/DHC/out，暫存表 dbo.tmp_x，代碼 PT01。');
H('H#07', '上限 50 萬元，比例 85 %。');
H('H#08', '共 ' + big + ' 筆。');
H('H#09', '例外情形另行公告。');
H('H#10', '本辦法自民國115年3月23日起施行，系統日期 115/03/23。');
H('H#11', '生效日 2026-03-23。');
H('H#12', '報表放在 D:\\DHC\\out 資料夾，主機 10.255.0.12。');
H('H#13', '每日下午 3:30 前上傳。');
const one = (name, answer, cited, visible, extra = '問題\n2026-09-30') => push('hand:' + name, answer, cited, visible || cited, extra);
one('萬 換算：50 萬元對 500,000 元', '單筆上限 50 萬元 [H#01]。\nSTATUS: ANSWER', ['H#01']);
one('億 換算：1.5 億對 150,000,000', '年度總額 1.5 億 [H#01]。\nSTATUS: ANSWER', ['H#01']);
one('反向：500,000 元對 50 萬元', '上限 500,000 元 [H#07]。\nSTATUS: ANSWER', ['H#07']);
one('中文小數字：三個營業日、兩週', '3 個營業日內完成，2 週內回報 [H#02]。\nSTATUS: ANSWER', ['H#02']);
one('推算出的數字標紅', '合計 6 個營業日、4 週 [H#02]。\nSTATUS: ANSWER', ['H#02']);
one('條號對得上「4.」與「第十二條」', '依第 4 點通知，並依第 12 條辦理 [H#03]。\nSTATUS: ANSWER', ['H#03']);
one('條號對不上', '依第 7 點辦理 [H#03]。\nSTATUS: ANSWER', ['H#03']);
one('時間與中午', '15:30 前上傳，中午截止 [H#04]。\nSTATUS: ANSWER', ['H#04']);
one('12 小時制：下午 3:30 對原文 15:30', '下午 3:30 前上傳 [H#04]。\nSTATUS: ANSWER', ['H#04']);
one('12 小時制：下午3點半對原文 15:30', '下午3點半前上傳 [H#04]。\nSTATUS: ANSWER', ['H#04']);
one('12 小時制：原文寫下午、答案寫 15:30', '15:30 前上傳 [H#13]。\nSTATUS: ANSWER', ['H#13']);
one('12 小時制：原文寫下午、答案省略下午', '3:30 前上傳 [H#13]。\nSTATUS: ANSWER', ['H#13']);
one('12 小時制：下午時間寫錯要標紅', '下午 4:30 前上傳 [H#04]。\nSTATUS: ANSWER', ['H#04']);
one('沒寫年份的月日、不同日期寫法', '3 月 23 日生效，2026年3月1日公告 [H#05]。\nSTATUS: ANSWER', ['H#05']);
one('錯的日期標紅', '2026-03-24 生效 [H#05]。\nSTATUS: ANSWER', ['H#05']);
one('路徑斜線方向、反引號表名', '放在 D:\\DHC\\out，表 `dbo.tmp_x` [H#06]。\nSTATUS: ANSWER', ['H#06']);
one('編出來的檔名與代碼', '請改 `pa_declare.php` 並查 ACCT-ERR-9001 [H#06]。\nSTATUS: ANSWER', ['H#06']);
one('在別段不在引用段：標黃', '代碼 PT01，上限 50 萬元 [H#09]。\nSTATUS: ANSWER', ['H#09'], ['H#09', 'H#06', 'H#07']);
one('引用與欄位名不算', '依 [H#06] 與 `[H#07]`，見 [MAP:doc_x]，as_of_date 與 chunk_id 照抄。\nSTATUS: ANSWER', ['H#06']);
one('年份不算數量、版本號不算代碼', '2026 年起適用 v4.2 版，3 年內有效 [H#09]。\nSTATUS: ANSWER', ['H#09']);
one('全形數字先正規化', '應於３個營業日內完成 [H#02]。\nSTATUS: ANSWER', ['H#02']);
one('問題裡有的不算', '門檻 85% [H#09]，查詢日 2026-09-30。\nSTATUS: ANSWER', ['H#09'], null, '門檻是 85% 嗎？\n2026-09-30');
one('超長數字不當掉', '共 ' + big + ' 筆 [H#08]。\nSTATUS: ANSWER', ['H#08']);
one('第 4 點不是時間', '第 4 點規定由風控通知 [H#03]。\nSTATUS: ANSWER', ['H#03']);
one('沒有可核對的內容', '依規定辦理 [H#09]。\nSTATUS: ANSWER', ['H#09']);
one('比例與 bp', '調整 25bp，比例 85% [H#07]。\nSTATUS: ANSWER', ['H#07']);
one('民國日期對西元', '2026-03-23 起施行 [H#10]。\nSTATUS: ANSWER', ['H#10']);
one('西元對民國日期', '民國115年3月23日起施行 [H#11]。\nSTATUS: ANSWER', ['H#11']);
one('民國斜線格式', '115/03/23 生效 [H#11]。\nSTATUS: ANSWER', ['H#11']);
one('錯的民國日期', '115年3月24日起施行 [H#10]。\nSTATUS: ANSWER', ['H#10']);
one('路徑後接全形逗號', '放在 D:\\DHC\\out，再上傳 [H#12]。\nSTATUS: ANSWER', ['H#12']);
one('路徑後直接接中文', '放在 D:\\DHC\\out資料夾 [H#12]。\nSTATUS: ANSWER', ['H#12']);
one('編出來的路徑', '改放 D:\\DHC\\archive，再上傳 [H#12]。\nSTATUS: ANSWER', ['H#12']);
one('主機 IP 目前不核對（已知限制）', '主機 10.255.0.15 [H#12]。\nSTATUS: ANSWER', ['H#12']);
fs.writeFileSync(path.join(__dirname, 'grounding-parity.json'), JSON.stringify({ generated_by: 'make-grounding-parity.cjs', texts, cases: out }, null, 1) + '\n');
const flagged = out.filter(x => x.red.length || x.yellow.length).length;
console.log(`cases=${out.length} (hand=${out.filter(x => x.name.startsWith('hand:')).length}) flagged=${flagged} texts=${Object.keys(texts).length}`);
for (const x of out.filter(x => x.name.startsWith('hand:'))) console.log(`  ${x.name} | 紅：${x.red.join('、') || '-'} | 黃：${x.yellow.join('、') || '-'}`);
