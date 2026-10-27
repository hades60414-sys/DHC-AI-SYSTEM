'use strict';
// 逐字核對的離線評估（不呼叫模型）：拿已經跑出來的答案（C# 最終版 37 題、Node 版 37 題、C# projects 3 題）套 lib/grounding.cjs，
// 看嚴重錯的答案有幾份被標紅、通過的答案有幾份被標紅（可能誤報），並列出被標的字，供人判斷。結果寫 grounding_eval.json。
//   node grounding_eval.cjs
const fs = require('fs'), path = require('path');
const { checkGrounding } = require('./lib/grounding.cjs');
const WS = path.resolve(__dirname, '../..');
const rd = f => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const bank = require(path.join(WS, 'experiments/task_design_20260926/rag/cases.json'));
const cases = Object.fromEntries((bank.cases || bank).map(c => [c.case_id, c]));
const asOfDefault = (bank.defaults || {}).as_of_date || '';

function chunkStore(indexFile) {
  const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));   // Node 索引是 { chunks: [...] }；C# 的 chunks.json 直接是陣列
  return Object.fromEntries((Array.isArray(idx) ? idx : idx.chunks).map(c => [c.chunk_id, c]));
}
// 和作答時模型看到的格式一樣（lib/prompts.cjs feed），再加章節名稱
const feed = c => { const m = c.metadata || {}; return `[${c.chunk_id}] ${m.title || c.doc_id} ${m.version || ''}｜${m.doc_type || ''}｜狀態:${m.status || '無'}｜公告:${m.publish_date || '無'}｜生效:${m.effective_date || '無'}｜廢止:${m.repealed_date || '無'}\n${c.section || ''}\n${c.text}`; };
const citedIds = t => [...new Set((String(t || '').match(/\[([^\[\]]+#\d+(?:-\d+)?)\]/g) || []).map(s => s.slice(1, -1)))];

function evalSet(name, rows, store, extraOf) {
  const out = { name, n: 0, answers_with_red: 0, severe: 0, severe_flagged: 0, pass: 0, pass_with_red: 0, details: [] };
  for (const r of rows) {
    const text = r.text ?? r.answer; if (!text) continue; out.n++;
    const visible = (r.visible_chunks || citedIds(text)).map(id => store[id]).filter(Boolean).map(feed);
    const cited = citedIds(text).map(id => store[id]).filter(Boolean).map(feed);
    if (!visible.length) { out.details.push({ id: r.case_id || r.question, verdict: r.score && r.score.verdict, severe: [], checked: 0, red: [], yellow: [], note: '沒有引用、也沒有檢索紀錄，無法核對' }); continue; }
    const g = checkGrounding(text, cited.length ? cited : visible, visible, extraOf(r));
    const a = r.score && r.score.answer, severe = !!(a && (a.severe_final || []).length), pass = !!(r.score && r.score.pass_auto);
    if (g.red.length) out.answers_with_red++;
    if (severe) { out.severe++; if (g.red.length) out.severe_flagged++; }
    if (pass) { out.pass++; if (g.red.length) out.pass_with_red++; }
    out.details.push({ id: r.case_id || r.question, verdict: r.score && r.score.verdict, severe: severe ? a.severe_final.map(s => s.type) : [], checked: g.checked, red: g.red.map(x => x.text), yellow: g.yellow.map(x => x.text) });
  }
  return out;
}

const synth = chunkStore(path.join(__dirname, 'indexes/synthetic/index.json'));
const extraBank = r => { const c = cases[r.case_id] || {}; return [c.question, c.as_of_date || asOfDefault, ...(c.history || []).map(h => h.content), ...(r.flags || []).map(f => f.text || '')].join('\n'); };
const sets = [
  evalSet('C# 最終版 37 題', rd(path.join(WS, 'deploy_docqa_v3_20260930/rehearsal/records-final.ndjson')), synth, extraBank),
  evalSet('Node 版 37 題', rd(path.join(__dirname, 'eval_runs/2026-09-29T162810852Z/records.ndjson')), synth, extraBank),
];
const projFile = path.join(WS, 'deploy_docqa_v3_20260930/rehearsal/projects-qa-results.json');
if (fs.existsSync(projFile)) {
  const proj = chunkStore(path.join(WS, 'deploy_docqa_v3_20260930/rehearsal/state/doc-index/projects/chunks.json'));
  const rows = [].concat(require(projFile).results || require(projFile)).map(x => { const a = typeof x.answer_json === 'string' ? JSON.parse(x.answer_json) : (x.result || x); return { question: x.question, text: a.answer }; });
  sets.push(evalSet('C# projects 3 題', rows, proj, r => r.question));
}
fs.writeFileSync(path.join(__dirname, 'grounding_eval.json'), JSON.stringify(sets, null, 1) + '\n');
for (const s of sets) {
  console.log(`\n== ${s.name}：${s.n} 份答案；有紅色標記 ${s.answers_with_red} 份；嚴重錯 ${s.severe} 份中被標紅 ${s.severe_flagged}；自動通過 ${s.pass} 份中被標紅 ${s.pass_with_red}`);
  for (const d of s.details) if (d.red.length || d.severe.length) console.log(`  ${d.id} ${d.verdict || ''}${d.severe.length ? ' 嚴重錯:' + d.severe.join('/') : ''} | 紅：${d.red.join('、') || '無'}${d.yellow.length ? ' | 黃：' + d.yellow.join('、') : ''}`);
}
