#!/usr/bin/env node
'use strict';
// Ingest the synthetic policy corpus and grade all 37 questions from rag/cases.json against it, using
// this tool's own local retrieval (dense top-30 -> rerank -> top-6) and local chat model, but reusing the
// canonical grading/precheck/validator code (read-only requires, never modified) so scores are directly
// comparable to tonight's experiments:
//   experiments/round2_arch_eval_20260926/src/{common,prompts,grade_rag}.cjs
//   experiments/rag_e2e_bm25_20260927/src/run.cjs (precheck + validate)
// Usage: node eval.cjs [--limit N]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./lib/index_store.cjs');
const servers = require('./lib/servers.cjs');
const mc = require('./lib/model_client.cjs');
const P = require('./lib/paths.cjs');

const R2 = path.join(P.WS, 'experiments', 'round2_arch_eval_20260926', 'src');
const CORPUS = path.join(P.WS, 'experiments', 'task_design_20260926', 'rag', 'corpus');
const C = require(path.join(R2, 'common.cjs'));
const Pr = require(path.join(R2, 'prompts.cjs'));
const GR = require(path.join(R2, 'grade_rag.cjs'));
const { precheck, validate } = require(path.join(P.WS, 'experiments', 'rag_e2e_bm25_20260927', 'src', 'run.cjs'));

const sha = b => crypto.createHash('sha256').update(b).digest('hex');

async function retrieveIds(idx, byId, question, history) {
  const q = mc.queryFor(question, history);
  const qv = await mc.embedQuery(q);
  const scored = idx.chunks.map((c, i) => ({ i, s: mc.dot(qv, idx.vectors[i]) })).sort((a, b) => b.s - a.s);
  const top30 = scored.slice(0, 30);
  const docs = top30.map(x => store.docText(idx.chunks[x.i]));
  const rr = await mc.rerank(q, docs, top30.length);
  // Keep only ids that also exist in the canonical bank (defends against stray chunks, e.g. from
  // non-front-matter files in the corpus folder that a generic ingest would otherwise pick up).
  return rr.map(r => idx.chunks[top30[r.index].i].chunk_id).filter(id => byId[id]);
}

async function callChat(messages) {
  const t0 = Date.now();
  try {
    const r = await mc.chatComplete(messages);
    return { error: null, content: r.content, finish: r.finish_reason, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { error: e.message, content: null, finish: null, latency_ms: Date.now() - t0 };
  }
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

  const runId = new Date().toISOString().replace(/[:.]/g, '');
  const dir = path.join(P.EVAL_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, 'records.ndjson'), 'ax');

  console.log('[eval] ingesting synthetic corpus...');
  const idx = await store.ingest(CORPUS, 'synthetic', { log: m => console.log('[eval] ' + m) });
  await servers.ensureAll();

  const B = C.loadBanks();
  const byId = B.rag.byId;
  const cases = B.rag.cases.slice(0, Number.isFinite(limit) ? limit : B.rag.cases.length);
  const asOfDefault = B.rag.defaults.as_of_date;

  const t0 = Date.now();
  const records = [];
  let consec = 0, stop = 'complete';
  for (let i = 0; i < cases.length; i++) {
    if (consec >= 3) { stop = 'transport'; break; }
    const c = cases[i];
    const caseT0 = Date.now();
    const ids = await retrieveIds(idx, byId, c.question, c.history).then(all => all.slice(0, 6));
    const asOf = c.as_of_date || asOfDefault;
    const view = precheck(B, ids, asOf);
    const Bc = { ...B, rag: { ...B.rag, precheck: { ...B.rag.precheck, [c.case_id]: { annotate: view } } } };
    const { request, visible } = Pr.ragAnswerRequest(c, 'Q/L+precheck', C.SEED0 + i, Bc);
    const gradeIt = text => GR.gradeAnswer(B.rag.oracle[c.case_id], text, {
      visibleChunks: visible, visibleDocs: visible.map(id => byId[id].doc_id), mapOnly: false,
      sourceText: Pr.requestText(request), headings: visible.map(id => byId[id].section),
    });
    const a1 = await callChat(request.body.messages);
    consec = a1.error ? consec + 1 : 0;
    const g1 = a1.error ? null : gradeIt(a1.content);
    const viol = a1.error ? ['transport'] : validate(a1.content, visible);
    let a2 = null, text = a1.content, g = g1;
    if (!a1.error && viol.length) {
      const messages2 = [...request.body.messages, { role: 'assistant', content: a1.content },
        { role: 'user', content: '你的回答不符合輸出規則：' + viol.join('；') + '。請依規則重寫完整答案（不要解釋修改過程），最後一行只寫 STATUS 行。' }];
      a2 = await callChat(messages2);
      if (!a2.error) { text = a2.content; g = gradeIt(text); }
    }
    const row = {
      case_id: c.case_id, case_index: i, retrieved: ids, dropped: view.dropped, flags: view.flags,
      visible_chunks: visible, repaired: !!a2, text, latency_ms: Date.now() - caseT0,
      score: g && { verdict: g.verdict, pass_auto: g.pass_auto, answer: g }, error: a1.error,
    };
    records.push(row);
    fs.writeSync(fd, JSON.stringify(row) + '\n');
    console.log(JSON.stringify({ i, case: c.case_id, verdict: g?.verdict, repaired: !!a2, ms: row.latency_ms, error: a1.error }));
  }
  fs.closeSync(fd);

  const graded = records.filter(r => r.score);
  const summary = {
    run_id: runId, total: records.length, graded: graded.length, stop,
    pass_auto: graded.filter(r => r.score.pass_auto).length,
    verdicts: graded.reduce((m, r) => { m[r.score.verdict] = (m[r.score.verdict] || 0) + 1; return m; }, {}),
    repaired: records.filter(r => r.repaired).length,
    transport_errors: records.filter(r => r.error).length,
    latency_ms: { total: Date.now() - t0, avg: Math.round(records.reduce((s, r) => s + r.latency_ms, 0) / (records.length || 1)) },
    elapsed_ms: Date.now() - t0,
  };
  fs.writeFileSync(path.join(dir, 'SUMMARY.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log('run dir: ' + dir);
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
