'use strict';
// Thin HTTP clients for the three local llama-server endpoints. No cloud calls: URLs are always 127.0.0.1.
const P = require('./paths.cjs');

const INSTRUCT = 'Instruct: Given a question about internal company rules, retrieve the passages that answer it\nQuery: ';

async function post(port, route, body, timeoutMs = 300000) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await r.text();
  if (r.status !== 200) throw Error(`http_${r.status}:${route}:${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

const norm = v => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// texts: array of passage strings (no instruct prefix). Returns L2-normalised vectors in input order.
async function embedPassages(texts) {
  const vs = [];
  for (let i = 0; i < texts.length; i += 8) {
    const r = await post(P.PORTS.embed, '/v1/embeddings', { input: texts.slice(i, i + 8) });
    vs.push(...r.data.sort((a, b) => a.index - b.index).map(d => norm(d.embedding)));
  }
  return vs;
}
async function embedQuery(question) {
  const r = await post(P.PORTS.embed, '/v1/embeddings', { input: [INSTRUCT + question] });
  return norm(r.data[0].embedding);
}

// Retrieval query text: prior user turns + current question (same construction as
// experiments/rag_e2e_bm25_20260927/src/bm25.cjs's queryFor()).
function queryFor(question, history) {
  return [...(history || []).filter(h => h.role === 'user').map(h => h.content), question].join('\n');
}

async function rerank(query, documents, topN) {
  const r = await post(P.PORTS.rerank, '/v1/rerank', { query, documents, top_n: topN ?? documents.length });
  return r.results.map(x => ({ index: x.index, score: x.relevance_score })).sort((a, b) => b.score - a.score);
}

async function chatComplete(messages, { seed = 20260930, temperature = 0, max_tokens = 512 } = {}) {
  const body = { model: 'local-chat', messages, temperature, max_tokens, seed, stream: false };
  const r = await post(P.PORTS.chat, '/v1/chat/completions', body, 180000);
  return { content: r.choices[0].message.content, finish_reason: r.choices[0].finish_reason, usage: r.usage };
}

module.exports = { INSTRUCT, norm, dot, embedPassages, embedQuery, queryFor, rerank, chatComplete, post };
