'use strict';
// 讀最新一次 eval_runs 的紀錄（不改紀錄，結果另寫到該次 run 資料夾的 ANALYSIS.json）：自動通過數、失敗原因、檢索有沒有撈到必要段落，
// 並逐題對照 9/29 的 R4（混合檢索＋重排，同一個 4B）。
// RAG-036 的評分規則少一個反斜線（9000000 也會命中），這題自動通過時另外用正確規則複查。
//   node analyze_eval.cjs [eval_runs\<run>]
const fs = require('fs'), path = require('path');
const P = require('./lib/paths.cjs'), EXP = path.join(P.WS, 'experiments');
const readRows = f => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const run = process.argv[2] ? path.resolve(process.argv[2]) : path.join(P.EVAL_DIR, fs.readdirSync(P.EVAL_DIR).sort().pop());
const rows = readRows(path.join(run, 'records.ndjson'));
const oracle = Object.fromEntries(Object.values(require(path.join(EXP, 'task_design_20260926/rag/oracle.json')).cases || {}).map(o => [o.case_id, o]));
const r4dir = path.join(EXP, 'arch_followup_20260929/e2e_R4'), r4run = JSON.parse(fs.readFileSync(path.join(r4dir, 'RESULT_INDEX.json'), 'utf8')).run_id;
const r4 = Object.fromEntries(readRows(path.join(r4dir, 'runs', r4run, 'records.ndjson')).map(r => [r.case_id, r]));

const out = { run: path.basename(run), n: rows.length, pass_auto: 0, retrieval_ok: 0, fail_reasons: {}, vs_r4: { both: 0, only_now: [], only_r4: [], neither: 0 }, rag036: null, cases: [] };
for (const r of rows) {
  const o = oracle[r.case_id], a = r.score?.answer || {}, pass = !!r.score?.pass_auto;
  const sets = o?.required_citation_sets || [], vis = new Set(r.visible_chunks || []);
  const retrieval_ok = sets.length ? sets.some(s => s.every(id => vis.has(id))) : null;
  const tags = pass ? [] : [!r.score && 'no_answer', a.format_ok === false && 'format', a.status_ok === false && 'status', a.key_fact_coverage < 1 && 'key_fact',
    a.citation_sufficient === false && 'citation', a.fabricated_citation && 'fabricated_cite', (a.severe_final || []).length && 'severe'].filter(Boolean);
  for (const t of tags) out.fail_reasons[t] = (out.fail_reasons[t] || 0) + 1;
  if (pass) out.pass_auto++; if (retrieval_ok) out.retrieval_ok++;
  const p4 = !!r4[r.case_id]?.score?.pass_auto;
  if (pass && p4) out.vs_r4.both++; else if (pass) out.vs_r4.only_now.push(r.case_id); else if (p4) out.vs_r4.only_r4.push(r.case_id); else out.vs_r4.neither++;
  out.cases.push({ id: r.case_id, pass, verdict: r.score?.verdict, retrieval_ok, fail: tags, r4_pass: p4, repaired: r.repaired, latency_ms: r.latency_ms });
  if (r.case_id === 'RAG-036') { // 正確規則：900000 前後不能再接數字或小數點
    const hit = /(?<![\d.])900000(?![\d])/.test(String(r.text || ''));
    out.rag036 = { auto_pass: pass, correct_rule_hit: hit, text_has_9000000: /9000000/.test(String(r.text || '')) };
  }
}
out.retrieval_ok_rate = `${out.retrieval_ok}/${rows.filter(r => (oracle[r.case_id]?.required_citation_sets || []).length).length}`;
fs.writeFileSync(path.join(run, 'ANALYSIS.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ run: out.run, n: out.n, pass_auto: out.pass_auto, retrieval_ok: out.retrieval_ok_rate, fail_reasons: out.fail_reasons, vs_r4: out.vs_r4, rag036: out.rag036 }, null, 1));
