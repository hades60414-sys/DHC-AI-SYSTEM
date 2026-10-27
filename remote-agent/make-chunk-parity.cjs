#!/usr/bin/env node
'use strict';
// 2026-10-01：沒有標題的 .txt／.docx 依「第X條」切段、依行打包——C#（DocQa.ChunkGeneric）與 Node（tools/local_qa/lib/chunk.cjs）要一致。
// 這支用 Node 產生 chunk-parity.json，Test-V3.ps1 的 C# 測試逐題比對 chunk_id、段名、內文。
//   node make-chunk-parity.cjs
const fs = require('fs'), path = require('path');
const { chunkGeneric } = require(path.resolve(__dirname, '..', '..', 'tools', 'local_qa', 'lib', 'chunk.cjs'));
const long = '部位限額之計算，應以前一營業日收盤價格為準，並由風險管理部每日檢核，檢核結果應於次一營業日上午十時前陳報總經理。'.repeat(12);
const cases = [
  { name: 'regulation (docx-like, single newlines)', docId: 'rules-a', title: '自營部位限額管理辦法',
    text: ['自營部位限額管理辦法', '民國一一五年三月十五日董事會通過', '第一章　總則', '第一條（目的）', '為健全自營部位之風險管理，特訂定本辦法。',
      '第二條　適用範圍', '本辦法適用於自營部全體人員。', '第三條 本辦法所稱限額，係指單一個股部位、總部位及風險值之上限，依附表辦理。',
      '第七條規定之例外情形，不在此限。', '第二章 限額', '第 4 條 單一個股', '單一個股部位不得超過淨值百分之五。', '第四條之一 例外核准',
      '經總經理核准者不在此限。', '第１０條：本辦法經董事會通過後施行，修正時亦同。', '第五條　計算', long].join('\n') },
  { name: 'only one article -> whole text under the title', docId: 'one', title: '單條說明', text: '說明文字\n第一條 只有一條\n內容。' },
  { name: 'plain text with blank lines, no articles', docId: 'plain', title: '作業說明',
    text: '第一段第一行\n第一段第二行\n\n第二段\n\n\n第三段很短' },
  { name: 'markdown headings keep the old paragraph packing', docId: 'md', title: 'md',
    text: '# 標題一\n第一段\n\n第二段\n## 標題二\n第三條 在標題下不切' },
  { name: 'colon after the number, CRLF line endings, trailing chapter', docId: 'crlf', title: 'CRLF 規章',
    text: '第一條：本辦法依法訂定。\r\n第二條：主管機關為金管會。\r\n內容第二行\r\n第三章 附則' },
  { name: 'one very long line is cut every 450 characters', docId: 'longline', title: '長行', text: '甲'.repeat(1000) },
  { name: 'law-database numbering 第 2-1 條 and a body line starting with 第七條、', docId: 'lawdb', title: '法規',
    text: '第 1 條 目的\n為規範…訂定本辦法。\n第 2 條 定義\n本辦法用詞定義如下。\n第 2-1 條 例外\n第七條、第八條之規定，於本條準用之。\n第 3 條 施行\n本辦法自發布日施行。' },
];
// docx 內文轉文字（表格一列一行、儲存格用 " | "）：C# 把同一段 XML 包成 docx 後比對 ExtractDocxText 的結果
const { xmlToText } = require(path.resolve(__dirname, '..', '..', 'tools', 'local_qa', 'lib', 'docx.cjs'));
const cell = (...ps) => '<w:tc><w:tcPr/>' + ps.map(p => '<w:p><w:r><w:t>' + p + '</w:t></w:r></w:p>').join('') + '</w:tc>';
const docxCases = [
  { name: 'table rows stay on one line', xml: '<w:document><w:body><w:p><w:r><w:t>前言</w:t></w:r></w:p><w:tbl><w:tr>' + cell('項目') + cell('限額') + '</w:tr><w:tr>' + cell('單一個股') + cell('5%', '（淨值）') + '</w:tr></w:tbl><w:p><w:r><w:t>後記&amp;附則</w:t></w:r></w:p></w:body></w:document>' },
  { name: 'articles with tabs and an empty paragraph', xml: '<w:document><w:body><w:p><w:r><w:t>第一條</w:t></w:r><w:r><w:tab/><w:t>目的</w:t></w:r></w:p><w:p/><w:p><w:r><w:t xml:space="preserve">第二條 範圍 </w:t></w:r></w:p></w:body></w:document>' },
];
const out = { generated_by: 'make-chunk-parity.cjs', cases: cases.map(c => ({ ...c, chunks: chunkGeneric(c.text, c.docId, c.title).map(k => ({ chunk_id: k.chunk_id, section: k.section, text: k.text })) })),
  docx_cases: docxCases.map(d => ({ ...d, text: xmlToText(d.xml) })) };
for (const d of out.docx_cases) console.log('docx:', d.name, '->', JSON.stringify(d.text));
fs.writeFileSync(path.join(__dirname, 'chunk-parity.json'), JSON.stringify(out, null, 1) + '\n');
for (const c of out.cases) console.log(c.name, '->', c.chunks.map(k => k.section + '(' + k.text.length + ')').join(' | '));
