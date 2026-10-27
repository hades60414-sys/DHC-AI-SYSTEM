'use strict';
// Generic precheck: same P1-P3 rules as experiments/rag_e2e_bm25_20260927/src/run.cjs's precheck(),
// applied to whatever metadata a chunk actually has (docs without version/status/dates just pass through).
// P4 (curated cross-document conflict register) is corpus-specific and not available for arbitrary
// document folders, so it is intentionally not reproduced here.
const banners = {
  repealed: '【已廢止：{repealed_date} 起不再適用；僅適用於該日前發生之事件】',
  not_yet_effective: '【尚未生效：{effective_date} 起適用】',
};
const fill = (t, m) => t.replace(/\{(\w+)\}/g, (_, k) => m[k]);

function precheck(chunks, asOf) {
  const context = [], dropped = [], flags = [];
  for (const c of chunks) {
    const m = c.metadata || {};
    if (m.level === 9 || m.status === '未核定') { dropped.push({ chunk_id: c.chunk_id, rule: 'P1' }); continue; }
    let banner = null;
    if (m.repealed_date && m.repealed_date <= asOf) banner = fill(banners.repealed, m);
    else if (m.effective_date && m.effective_date > asOf) banner = fill(banners.not_yet_effective, m);
    context.push({ chunk_id: c.chunk_id, banner, chunk: c });
  }
  const kept = new Set(context.map(x => x.chunk_id));
  const versions = {};
  for (const x of context) {
    const m = x.chunk.metadata || {};
    if (!m.doc_no) continue;
    (versions[m.doc_no] ??= new Set()).add(x.chunk.doc_id);
  }
  for (const [docNo, s] of Object.entries(versions)) if (s.size > 1) flags.push({ rule: 'P3', text: `${docNo} 有多個版本並存：${[...s].join('、')}` });
  return { context, dropped, flags };
}

module.exports = { precheck };
