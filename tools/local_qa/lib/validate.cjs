'use strict';
// Output-format validator, copied from experiments/rag_e2e_bm25_20260927/src/run.cjs's validate().
const STATUS_RE = /^STATUS:\s*(ANSWER|NO_INFO|CONFLICT|DENIED)\s*$/;

function validate(text, visible) {
  const v = [];
  const lines = String(text || '').normalize('NFKC').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length || !STATUS_RE.test(lines.at(-1))) v.push('最後一行不是 STATUS 行（必須單獨一行，例如 STATUS: ANSWER）');
  const ids = [...new Set((String(text).match(/\[([^\[\]]+#\d+(?:-\d+)?)\]/g) || []).map(s => s.slice(1, -1)))];
  const bad = ids.filter(id => !visible.includes(id));
  if (bad.length) v.push('引用了不在資料片段中的 chunk_id：' + bad.join('、'));
  // 2026-09-30 晚上：「文件裡找不到」的答案不必附引用（第一次回答常寫得好好的，只因沒引用就被要求整題重寫）
  const last = STATUS_RE.exec(lines.at(-1) || '');
  if (!ids.length && !(last && last[1] === 'NO_INFO')) v.push('沒有任何 [chunk_id] 引用');
  if (/^\s*(thinking|思考|分析|let me|the user)/i.test(String(text))) v.push('開頭輸出了思考過程');
  return v;
}

function parseStatus(text) {
  const lines = String(text ?? '').normalize('NFKC').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const m = lines.length ? STATUS_RE.exec(lines.at(-1)) : null;
  return { format_ok: !!m, status: m ? m[1] : null };
}

module.exports = { validate, parseStatus, STATUS_RE };
