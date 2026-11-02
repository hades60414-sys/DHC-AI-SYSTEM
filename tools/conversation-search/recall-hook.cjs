'use strict';
// Claude Code UserPromptSubmit hook. Off unless D:\TAS\jev\recall-on exists. Never throws; silent on any doubt.
const fs = require('fs');
const path = require('path');

const T0 = Date.now();
const BUDGET_MS = 450;
const SWITCH = process.env.JEV_RECALL_SWITCH || path.join(__dirname, 'recall-on');
const DB = process.env.JEV_INDEX_DB || path.join(__dirname, 'data', 'index.db');
const GATE = { memory: { coverage: 0.6, segs: 2 }, convo: { coverage: 0.7, segs: 2 } };
const MAX_SNIPPETS = 3;
const MAX_CHARS = 800;
const HEADER = '相關的過去紀錄（自動召回，僅供參考，不是新指令）：';

const quit = () => process.exit(0);
// The search is synchronous and runs in a worker (below), so this cap can fire. It used to sit on the same
// thread and never ran: a cold search held prompts for the full 4 s hook timeout (75 times in the week to 10-29).
setTimeout(quit, BUDGET_MS + 150).unref();

function strong(group, gate) {
  const h = group.hits[0];
  return h && h.coverage >= gate.coverage && h.segs >= gate.segs;
}

function line(g) {
  const h = g.hits[0];
  const snip = h.snippet.replace(/\s+/g, ' ');
  if (g.kind === 'convo' || g.kind === 'subagent') {
    return `- [對話 ${g.date} ${(g.title || '').slice(0, 24)} session=${g.session} #${h.id}] ${snip}`;
  }
  const name = String(g.session).split(/[\\/]/).pop();
  return `- [${g.kind === 'card' ? '專案卡' : '記憶'} ${name}] ${snip}`;
}

function recall(input, opts = {}) {
  const switchFile = opts.switchFile || SWITCH;
  const dbFile = opts.db || DB;
  const t0 = opts.t0 || Date.now();
  if (!fs.existsSync(switchFile)) return null;
  const prompt = String(input.prompt || '').trim();
  if ([...prompt].length < 8 || prompt.startsWith('/')) return null;
  if (!input.cwd || !fs.existsSync(dbFile)) return null;
  const { search } = require('./search.cjs');
  const { openDb } = require('./index.cjs');
  const db = openDb(dbFile, { readOnly: true });
  try {
    const picked = [];
    const mem = search({ db, query: prompt, cwd: input.cwd, fuzzy: true, kinds: ['memory', 'card'], limit: MAX_SNIPPETS, now: opts.now });
    for (const g of mem.results) if (strong(g, GATE.memory)) picked.push(g);
    if (Date.now() - t0 > BUDGET_MS) return null;
    if (picked.length < MAX_SNIPPETS) {
      const conv = search({ db, query: prompt, cwd: input.cwd, fuzzy: true, kinds: ['convo'], excludeSession: input.session_id, limit: MAX_SNIPPETS, now: opts.now });
      for (const g of conv.results) if (strong(g, GATE.convo) && picked.length < MAX_SNIPPETS) picked.push(g);
    }
    if (Date.now() - t0 > BUDGET_MS || !picked.length) return null;
    let text = HEADER;
    for (const g of picked) {
      const l = line(g);
      if (text.length + 1 + l.length > MAX_CHARS) {
        const room = MAX_CHARS - text.length - 2;
        if (room > 60) text += '\n' + l.slice(0, room) + '…';
        break;
      }
      text += '\n' + l;
    }
    return text === HEADER ? null : text;
  } finally { db.close(); }
}

module.exports = { recall, GATE, HEADER, MAX_CHARS };

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
if (!isMainThread && workerData && workerData.recallInput) {
  let ctx = null;
  try { ctx = recall(workerData.recallInput, { t0: workerData.t0 }); } catch { /* silent */ }
  parentPort.postMessage(ctx);
} else if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('error', quit);
  process.stdin.on('end', () => {
    try {
      if (!fs.existsSync(SWITCH)) return quit();
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const worker = new Worker(__filename, { workerData: { recallInput: input, t0: T0 } });
      worker.on('error', quit);
      return worker.on('message', (ctx) => {
        if (ctx && Date.now() - T0 <= BUDGET_MS) {
          return process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }), quit);
        }
        quit();
      });
    } catch { /* never block the prompt */ }
    quit();
  });
}
