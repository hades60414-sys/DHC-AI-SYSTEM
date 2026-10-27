#!/usr/bin/env node
'use strict';
// Local document QA CLI. No cloud, no network calls beyond 127.0.0.1, no Python.
//   node qa.cjs serve
//   node qa.cjs status
//   node qa.cjs stop
//   node qa.cjs ingest <folder> [--name <index>] [--force]
//   node qa.cjs ask "<question>" [--index <name>] [--json] [--history <json>] [--user <json>] [--as-of <YYYY-MM-DD>] [--queries <json 陣列>]
const fs = require('node:fs');
const path = require('node:path');
const P = require('./lib/paths.cjs');
const servers = require('./lib/servers.cjs');
const store = require('./lib/index_store.cjs');
const mc = require('./lib/model_client.cjs');
const pre = require('./lib/precheck.cjs');
const prompts = require('./lib/prompts.cjs');
const validate = require('./lib/validate.cjs');
const grounding = require('./lib/grounding.cjs');
const fmt = require('./lib/format_fix.cjs');
const MAX_ANSWER_TOKENS = 1024;
const STATUS_MISSING = '最後一行不是 STATUS 行';   // lib/validate.cjs 的違規訊息開頭

function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const key = a.slice(2); const next = argv[i + 1]; if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true; }
    else pos.push(a);
  }
  return { flags, pos };
}

async function cmdServe() {
  const state = await servers.ensureAll();
  console.log('servers up:');
  for (const s of state) console.log(`  ${s.name.padEnd(7)} pid=${s.pid} port=${s.port}`);
}
async function cmdStatus() {
  const rows = await servers.statusAll();
  for (const r of rows) console.log(`${r.name.padEnd(7)} port=${r.port} pid=${r.recorded_pid ?? '-'} healthy=${r.healthy}`);
}
async function cmdStop() {
  const rows = await servers.stopAll();
  if (!rows.length) { console.log('no servers were recorded as running'); return; }
  for (const r of rows) console.log(`${r.name.padEnd(7)} pid=${r.pid} killed=${r.killed}`);
}

async function cmdIngest(pos, flags) {
  const folder = pos[0];
  if (!folder) throw Error('usage: node qa.cjs ingest <folder> [--name <index>] [--force]');
  const name = flags.name || 'default';
  const idx = await store.ingest(folder, name, { force: !!flags.force, log: m => console.log('[ingest] ' + m) });
  console.log(`index "${name}": ${idx.chunk_count} chunk(s) from ${idx.files.length} file(s)`);
}

async function retrieve(idx, question, history, queries = []) {
  await servers.ensureAll();
  const q = mc.queryFor(question, history);
  const qv = await mc.embedQuery(q);
  const scored = idx.chunks.map((c, i) => ({ i, s: mc.dot(qv, idx.vectors[i]) })).sort((a, b) => b.s - a.s);
  const top30 = scored.slice(0, 30);
  const docs = top30.map(x => store.docText(idx.chunks[x.i]));
  const rr = await mc.rerank(q, docs, top30.length);
  let top6 = rr.slice(0, 6).map(r => idx.chunks[top30[r.index].i]);
  if (queries.length) {
    // 2026-09-30 晚上（和 srv-db v3.1 相同）：大腦附的檢索查詢各取向量前 10、對自己重排，和原題清單輪流取、湊滿 6 段；作答仍用原題
    const lists = [rr.map(r => top30[r.index].i)];
    for (const sq of queries.slice(0, 3)) {
      const sv = await mc.embedQuery(sq);
      const top10 = idx.chunks.map((c, i) => ({ i, s: mc.dot(sv, idx.vectors[i]) })).sort((a, b) => b.s - a.s).slice(0, 10).map(x => x.i);
      const r2 = await mc.rerank(sq, top10.map(i => store.docText(idx.chunks[i])), top10.length);
      lists.push(r2.map(r => top10[r.index]));
    }
    const merged = [];
    for (let k = 0; merged.length < 6 && k < 30; k++) for (const L of lists) if (L[k] !== undefined && !merged.includes(L[k]) && merged.length < 6) merged.push(L[k]);
    top6 = merged.map(i => idx.chunks[i]);
  }
  return { top6, retrieved_ids: top30.map(x => idx.chunks[x.i].chunk_id) };
}

async function askOnce(idx, { question, asOf, userContext, history, queries }) {
  const { top6, retrieved_ids } = await retrieve(idx, question, history, queries || []);
  const view = pre.precheck(top6, asOf);
  const built = prompts.buildAnswerRequest({ question, asOf, userContext, history, contextItems: view.context, flags: view.flags });
  const t0 = Date.now();
  // 模型常把引用寫成 [chunk_id: X]，統一成 [X]；其他確定意思的寫法錯誤用 fixFormat 修（只改寫法，不改內容）
  const tidy = s => fmt.fixFormat(String(s ?? '').replace(/\[\s*chunk_id\s*[:：]\s*([^\[\]]+?)\s*\]/gi, '[$1]'), built.visible);
  // 2026-09-30 晚上：上限 512 字詞時，長答案常被截斷、寫不到 STATUS 行而整題重寫 → 放寬到 1024
  const first = await mc.chatComplete(built.messages, { max_tokens: MAX_ANSWER_TOKENS });
  let text = tidy(first.content), repaired = false, repair_kind = null;
  let viol = validate.validate(text, built.visible);
  // 答案完整、只漏了 STATUS 行：只補問一行（伺服器有前文快取，幾秒就好），不整題重寫
  if (viol.length && first.finish_reason === 'stop' && viol.every(v => v.startsWith(STATUS_MISSING))) {
    const st = await mc.chatComplete([...built.messages, { role: 'assistant', content: text }, { role: 'user', content: fmt.STATUS_ONLY_PROMPT }], { max_tokens: 16 });
    const line = fmt.statusFromReply(st.content);
    if (line) { text = text.trimEnd() + '\n\n' + line; repaired = true; repair_kind = 'status_line'; viol = validate.validate(text, built.visible); }
  }
  if (viol.length) {
    repaired = true; repair_kind = 'rewrite';
    const messages2 = [...built.messages, { role: 'assistant', content: text }, { role: 'user', content: '你的回答不符合輸出規則：' + viol.join('；') + '。請依規則重寫完整答案（不要解釋修改過程），最後一行只寫 STATUS 行。' }];
    const second = await mc.chatComplete(messages2, { max_tokens: MAX_ANSWER_TOKENS });
    text = tidy(second.content);
  }
  const remaining_issues = validate.validate(text, built.visible);
  const { status, format_ok } = validate.parseStatus(text);
  const citedIds = [...new Set((text.match(/\[([^\[\]]+#\d+(?:-\d+)?)\]/g) || []).map(s => s.slice(1, -1)))];
  const byId = Object.fromEntries(idx.chunks.map(c => [c.chunk_id, c]));
  const sources = citedIds.map(id => ({ chunk_id: id, source_file: byId[id] ? byId[id].source_file : '(unknown)', section: byId[id] ? byId[id].section : '(unknown)' }));
  // 逐字核對：答案裡的日期、時間、數量、代碼／表名／路徑、條號，要在引用段落（加上問題、日期、對話紀錄）找得到
  const text2 = c => [prompts.feed(c, null), c.section || ''].join('\n');
  const citedChunks = citedIds.map(id => byId[id]).filter(Boolean), visibleChunks = built.visible.map(id => byId[id]).filter(Boolean);
  const g = grounding.checkGrounding(text, (citedChunks.length ? citedChunks : visibleChunks).map(text2), visibleChunks.map(text2), [question, asOf, ...(history || []).map(h => h.content), ...(view.flags || []).map(f => f.text || '')].join('\n'));
  return { question, answer: text, status, format_ok, repaired, repair_kind, remaining_issues, unsupported: g.red.map(x => x.text), cited_elsewhere: g.yellow.map(x => x.text), visible: built.visible, retrieved: retrieved_ids, dropped: view.dropped, flags: view.flags, sources, latency_ms: Date.now() - t0 };
}

async function cmdAsk(pos, flags) {
  const question = pos[0];
  if (!question) throw Error('usage: node qa.cjs ask "<question>" [--index <name>] [--json] [--history <json>] [--user <json>] [--as-of <date>]');
  const all = fs.existsSync(P.INDEX_DIR) ? fs.readdirSync(P.INDEX_DIR).filter(n => fs.existsSync(store.indexPath(n))) : [];
  const name = flags.index || (all.length === 1 ? all[0] : 'default'); // 只有一個索引時不用指定
  const idx = store.load(name);
  const asOf = flags['as-of'] || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); // 本機日期（台北凌晨不會變成前一天）
  const userContext = flags.user ? JSON.parse(flags.user) : {};
  const history = flags.history ? JSON.parse(flags.history) : [];
  const queries = flags.queries ? JSON.parse(flags.queries) : [];   // 大腦附的檢索查詢（1–3 個）
  if (!Array.isArray(queries) || queries.length > 3 || queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 200)) throw Error('--queries 要是 1–3 個、每個 1–200 字的字串陣列');
  const result = await askOnce(idx, { question, asOf, userContext, history, queries });
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(result.answer);
  console.log('');
  console.log('來源：');
  if (!result.sources.length) console.log('  （回答未引用任何來源）');
  for (const s of result.sources) console.log(`  [${s.chunk_id}] ${s.source_file} ｜ ${s.section}`);
  if (result.repaired) console.log('\n（註：第一次回答不符格式，已自動重寫一次）');
  if (result.remaining_issues.length) console.log('（註：最後的回答格式仍不符：' + result.remaining_issues.join('；') + '，請自己核對來源）');
  if (result.unsupported.length) console.log('⚠ 核對：這些數字／名稱在檢索到的段落裡找不到（可能是推算、常識或模型自己加的），請核對：' + result.unsupported.join('、'));
  if (result.cited_elsewhere.length) console.log('△ 核對：這些數字／名稱不在引用的段落，而在其他檢索段落裡（出處可能引錯）：' + result.cited_elsewhere.join('、'));
  console.log(`\n耗時：${(result.latency_ms / 1000).toFixed(1)} 秒`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, pos } = parseArgs(rest);
  try {
    if (cmd === 'serve') await cmdServe();
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'stop') await cmdStop();
    else if (cmd === 'ingest') await cmdIngest(pos, flags);
    else if (cmd === 'ask') await cmdAsk(pos, flags);
    else { console.error('usage: node qa.cjs <serve|status|stop|ingest|ask> ...'); process.exitCode = 1; }
  } catch (e) {
    console.error('error: ' + e.message);
    process.exitCode = 1;
  }
}
main();
