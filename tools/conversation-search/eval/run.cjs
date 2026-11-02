'use strict';
// node eval/run.cjs [--task=session-model] [--only=N,M]   Runs every labeled case through judge with real Haiku calls, no cache.
// Cases: cases.json for assistant-route, <task>-cases.json for any other task.
const fs = require('node:fs');
const path = require('node:path');
const { judge, tasks, claudeRunner } = require('../judge.cjs');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const TASK = tasks[arg('task') || 'assistant-route'];
const PROD_TIMEOUT = TASK.timeoutMs;
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, TASK.id === 'assistant-route' ? 'cases.json' : `${TASK.id}-cases.json`), 'utf8'));
const only = arg('only').split(',').filter(Boolean).map(Number);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const rank = (c) => TASK.choices.indexOf(c);

(async () => {
  const rows = [];
  for (const [i, c] of cases.entries()) {
    if (only.length && !only.includes(i)) continue;
    const { expect, why, tags, ...input } = c;
    let called = false;
    const runner = (a) => { called = true; return claudeRunner(a); };
    const r = await judge(TASK.id, input, { cache: false, timeoutMs: 45000, runner });
    rows.push({ i, c, r, called });
    console.log(`${String(i).padStart(2)} ${r.choice === c.expect ? 'ok  ' : 'MISS'} ${c.expect.padEnd(7)} -> ${r.choice.padEnd(7)} ${r.source.padEnd(7)} ${String(r.ms).padStart(6)}ms ${(c.text ?? c.lastAssistant).slice(0, 30)}`);
  }
  const hit = rows.filter((x) => x.r.choice === x.c.expect).length;
  const money = rows.filter((x) => x.c.tags.includes('money'));
  const moneyOk = money.filter((x) => rank(x.r.choice) >= rank('opus')).length;
  const under = rows.filter((x) => rank(x.r.choice) < rank(x.c.expect));
  const called = rows.filter((x) => x.called);
  const haikuMs = called.map((x) => x.r.ms);
  const cold = haikuMs[0];
  const warm = haikuMs.slice(1);
  const fallback = rows.filter((x) => x.r.err).length;
  const wouldFallback = rows.filter((x) => x.r.err || x.r.ms > PROD_TIMEOUT).length;

  const matrix = TASK.choices.map((e) => [e, ...TASK.choices.map((p) => rows.filter((x) => x.c.expect === e && x.r.choice === p).length)]);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const md = [
    `# ${TASK.id} eval ${ts}`, '',
    `- cases ${rows.length}; accuracy ${hit}/${rows.length} = ${(100 * hit / rows.length).toFixed(1)}%`,
    `- money-recall (money cases routed to opus/handoff) ${moneyOk}/${money.length}`,
    `- under-routed (picked a weaker route than the label) ${under.length}: ${under.map((x) => x.i).join(', ') || 'none'}`,
    `- over-routed (picked a stronger route than the label) ${rows.filter((x) => rank(x.r.choice) > rank(x.c.expect)).map((x) => x.i).join(', ') || 'none'}`,
    `- fallback (error/timeout/low confidence, eval timeout 45s) ${fallback}/${rows.length}; would fall back at production timeout ${PROD_TIMEOUT}ms: ${wouldFallback}/${rows.length}`,
    `- latency of calls that reached Haiku: first (cold) ${cold}ms; rest p50 ${pct(warm, 0.5)}ms p90 ${pct(warm, 0.9)}ms max ${Math.max(0, ...warm)}ms (n=${warm.length})`,
    `- rule-only answers (no Haiku call) ${rows.length - called.length}`, '',
    '## Confusion (rows = label, columns = judged)', '',
    `| label | ${TASK.choices.join(' | ')} |`, `|---|${TASK.choices.map(() => '---').join('|')}|`,
    ...matrix.map((r) => `| ${r.join(' | ')} |`), '',
    '## Cases', '', '| # | label | judged | source | conf | ms | text | why | reason |', '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(({ i, c, r }) => `| ${i} | ${c.expect} | ${r.choice === c.expect ? r.choice : '**' + r.choice + '**'} | ${r.source} | ${r.confidence} | ${r.ms} | ${(c.text ?? c.lastAssistant).slice(0, 40).replace(/\|/g, '/')} | ${c.why} | ${String(r.reason).replace(/\|/g, '/').slice(0, 60)} |`),
  ].join('\n');
  const out = path.join(__dirname, `results-${TASK.id === 'assistant-route' ? '' : TASK.id + '-'}${ts}.md`);
  fs.writeFileSync(out, md + '\n');
  console.log('\n' + md.split('\n').slice(2, 8).join('\n') + '\n' + out);
})();
