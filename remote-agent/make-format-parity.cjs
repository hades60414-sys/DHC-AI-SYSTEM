'use strict';
// 產生 format-fix-parity.json：C# DocQa.FixFormat／StatusFromReply 要和 Node tools\local_qa\lib\format_fix.cjs 逐題相同。
// 來源：本機第一次回答原文（deploy_docqa_v3_20260930\opt\first_pass.ndjson，先照 qa.cjs 把 [chunk_id: X] 換成 [X]）＋手寫案例。
//   node make-format-parity.cjs
const fs = require('fs'), path = require('path');
const WS = path.resolve(__dirname, '../..');
const { fixFormat, statusFromReply } = require(path.join(WS, 'tools/local_qa/lib/format_fix.cjs'));
const tidy = s => String(s ?? '').replace(/\[\s*chunk_id\s*[:：]\s*([^\[\]]+?)\s*\]/gi, '[$1]');
const cases = [];
const fp = path.join(WS, 'deploy_docqa_v3_20260930/opt/first_pass.ndjson');
if (fs.existsSync(fp)) for (const r of fs.readFileSync(fp, 'utf8').trim().split('\n').map(JSON.parse)) cases.push({ name: 'first:' + r.case_id, text: tidy(r.raw), visible: r.visible });
const V = ['A#01', 'B#02', 'POL-X-v2#03'];
for (const [name, text] of [
  ['全形括號', '見（A#01）與【B#02】。\nSTATUS: ANSWER'], ['半形括號', '見 (POL-X-v2#03)。\nSTATUS: ANSWER'], ['不在可見段落的括號不動', '見 (Z#09)。\nSTATUS: ANSWER'],
  ['MAP 接段落編號', '依 [MAP:A#01] 辦理。\nSTATUS: ANSWER'], ['MAP 接文件代碼不動', '依 [MAP:POL-X] 辦理。\nSTATUS: ANSWER'], ['MAP 全形冒號', '依 [MAP：B#02]。\nSTATUS: ANSWER'],
  ['一個括號多個編號', '見 [A#01, B#02]、[A#01；POL-X-v2#03]。\nSTATUS: ANSWER'], ['多個編號含未知不動', '見 [A#01、Z#09]。\nSTATUS: ANSWER'],
  ['STATUS 粗體小寫句點', '答案 [A#01]\n**STATUS: answer**。'], ['STATUS 在中間', 'STATUS: NO_INFO\n答案 [A#01]\n\n[B#02]'], ['兩行 STATUS 不動', 'STATUS: ANSWER\n答案 [A#01]\nSTATUS: NO_INFO'],
  ['已經正確不動', '答案 [A#01]。\nSTATUS: ANSWER'], ['結尾空行不動', '答案 [A#01]。\nSTATUS: ANSWER\n\n'], ['CRLF', '答案 [A#01]。\r\n**STATUS：CONFLICT**\r\n'], ['沒有 STATUS', '答案 [A#01]。'],
]) cases.push({ name: 'hand:' + name, text, visible: V });
for (const c of cases) c.expected = fixFormat(c.text, c.visible);
const replies = ['STATUS: NO_INFO', 'status：answer', '**CONFLICT**', 'DENIED。', '我覺得是 ANSWER', '', 'STATUS: MAYBE', ' STATUS : denied '].map(reply => ({ reply, expected: statusFromReply(reply) }));
fs.writeFileSync(path.join(__dirname, 'format-fix-parity.json'), JSON.stringify({ generated_by: 'make-format-parity.cjs', cases, replies }, null, 1) + '\n');
console.log(`cases=${cases.length} changed=${cases.filter(c => c.expected !== c.text).length} replies=${replies.length}`);
