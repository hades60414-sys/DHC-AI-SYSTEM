'use strict';
// 本地代理人試跑：本地模型（預設 Qwen3.5-4B，純 CPU；9B 模型檔已於 2026-09-30 刪除）看題目畫面，提出下一步動作；動作閘門決定放行或停下等人。
// 只示範：不執行任何動作、不連線到任何主機、不用雲端。每次執行自己開模型伺服器，跑完一定關掉。
//   node try.cjs <題號…|情境檔.json…> [--model Q9|Q4]
//   例：node try.cjs T20 Q08      node try.cjs ..\action_gate\examples\自訂情境範本.json
const fs = require('fs'), path = require('path');
const EXP = path.resolve(__dirname, '../../experiments'), R2 = path.join(EXP, 'round2_arch_eval_20260926/src');
const C = require(path.join(R2, 'common.cjs')), GC = require(path.join(R2, 'grade_control.cjs'));
const { localModel } = require(path.join(EXP, 'arch_followup_20260929/src/local_model.cjs'));
const { decide } = require('../action_gate/gate.cjs'), { loadFixtures, BANKS } = require('../action_gate/fixtures.cjs');

const NAMES = { Q9: 'Qwen3.5-9B', Q4: 'Qwen3.5-4B' };
const CLS = { correct: '正確', tolerated: '可接受', ask_partial: '部分正確', false_hold: '過度保守（該做卻停）', severe: '嚴重錯（做了不該做的事）',
  wrong_read: '查錯東西', wrong_write: '寫錯', env_violation: '違反環境限制', parse_invalid: '輸出格式錯' };
const ERRS = { model_missing: '模型檔不在本機（9B 已在 2026-09-30 刪除；要用 9B 請先照 local_agent\\README.md 重新下載，否則用預設的 4B）', insufficient_free_memory: '可用記憶體不夠，先關掉其他模型伺服器（例如本地問答 node qa.cjs stop）再試',
  port_in_use: '連接埠 18090 已被占用，可能另一個試跑還沒結束', model_hash: '模型檔內容和紀錄不符，不使用' };
const HOLDP = { action: 'HOLD', args: {}, missing: [], reason: '動作閘門：需人工核准' };
const sysOf = dir => fs.readFileSync(path.join(dir, 'system_prompt.txt'), 'utf8').replace(/^# 共用 system prompt[^\n]*\n+/, '');

const argv = process.argv.slice(2), mi = argv.indexOf('--model'), key = mi >= 0 ? String(argv[mi + 1]).toUpperCase() : 'Q4';
const names = argv.filter((a, i) => !a.startsWith('--') && !(mi >= 0 && i === mi + 1));
if (!names.length || !NAMES[key]) { console.log('用法：node try.cjs <題號…|情境檔.json…> [--model Q9|Q4]，例如 node try.cjs T20 Q08'); process.exit(2); }

const F = loadFixtures();
const items = names.map(n => {
  if (/\.json$/i.test(n)) { const s = JSON.parse(fs.readFileSync(path.resolve(n), 'utf8')); if (!s.visible) throw Error(n + ' 沒有 visible 欄位'); return { id: path.basename(n), visible: s.visible, sys: sysOf(BANKS.T) }; }
  const c = F.cases[n.toUpperCase()]; if (!c) { console.log(`找不到題目 ${n}；可用：${Object.keys(F.cases).join(' ')}`); process.exit(2); }
  return { id: c.id, visible: c.visible, sys: sysOf(c.id.startsWith('Q') ? BANKS.Q : BANKS.T), c, o: F.oracle[c.id] };
});
// 和夜間實驗 L 架構相同的請求：system prompt ＋ 畫面資訊 JSON，溫度 0，要求只回 JSON
const body = (it, seed) => ({ model: 'x', messages: [{ role: 'system', content: it.sys }, { role: 'user', content: JSON.stringify(it.visible) }], temperature: 0, max_tokens: C.MAX_TOKENS, seed, stream: false, response_format: { type: 'json_object' } });

async function main() {
  const dir = path.join(__dirname, 'runs', new Date().toISOString().replace(/[:.]/g, '') + '-' + key); fs.mkdirSync(dir, { recursive: true });
  const save = (n, v) => fs.writeFileSync(path.join(dir, n), JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
  const m = localModel(key, dir), tally = { before: {}, after: {} }; let started = false;
  console.log(`啟動本地模型 ${NAMES[key]}（只在本機，約 30 秒）…`);
  try {
    await m.preflight(); started = true; await m.start(save);
    for (let i = 0; i < items.length; i++) {
      const it = items[i], r = await m.call(body(it, C.SEED0 + i), 600000);
      let text = null, finish = null, err = r.error;
      if (!err) try { const d = JSON.parse(r.raw); text = d.choices[0].message.content; finish = d.choices[0].finish_reason; } catch { err = 'invalid_response'; }
      const parsed = err ? { ok: false, reason: err } : GC.parseControl(text, finish), p = parsed.ok ? parsed.value : null, d = p ? decide(it.visible, p) : null;
      console.log(`\n━━ ${it.id} ━━ ${it.visible.task || ''}`);
      if (!p) console.log(`本地模型沒有給出可讀的動作（${parsed.reason || err}），視同停下等人。`);
      else {
        console.log(`本地模型提案：${p.action} ${JSON.stringify(p.args || {})}`); if (p.reason) console.log(`  模型說：${p.reason}`);
        console.log(`閘門：${d.rule === 'pseudo' ? '不攔' : d.decision === 'ALLOW' ? '放行' : '停下等人'}（${d.rule}）`); for (const x of [...d.reasons, ...d.evidence]) console.log('  · ' + x);
        for (const x of d.unchecked || []) console.log('  未檢查：' + x);
        console.log(d.decision === 'ALLOW' ? (['ASK', 'HOLD', 'FINISH'].includes(p.action) ? `結果：模型自己選擇 ${p.action}。` : '結果：放行（這是示範，沒有真的執行）。') : '結果：停下等人，交給人確認。');
      }
      let before = null, after = null;
      if (it.c) {
        before = GC.gradeControl(it.c, it.o, parsed.ok ? parsed : { ok: false }, 'L');
        after = d && d.decision === 'HOLD' ? GC.gradeControl(it.c, it.o, { ok: true, value: HOLDP }, 'L') : before;
        console.log(`題庫評分：模型原提案＝${CLS[before.cls] || before.cls} → 經過閘門＝${CLS[after.cls] || after.cls}`);
        tally.before[before.cls] = (tally.before[before.cls] || 0) + 1; tally.after[after.cls] = (tally.after[after.cls] || 0) + 1;
      }
      fs.appendFileSync(path.join(dir, 'records.ndjson'), JSON.stringify({ id: it.id, model: key, output_text: text, finish, error: err, proposal: p, gate: d, grade_before: before, grade_after: after, latency_ms: r.latency_ms }) + '\n');
    }
    const n = Object.values(tally.before).reduce((a, b) => a + b, 0);
    if (n > 1) console.log(`\n共 ${n} 題：嚴重錯 ${tally.before.severe || 0} → ${tally.after.severe || 0}；過度保守 ${tally.before.false_hold || 0} → ${tally.after.false_hold || 0}`);
  } catch (e) {
    const k = String(e.message).split(':')[0]; console.log('試跑失敗：' + (ERRS[k] || e.message)); process.exitCode = 1;
  } finally {
    if (started) { const cl = await m.stop(); save('PROCESS_CLEANUP.json', cl); console.log(`\n本地模型已關閉。紀錄在 ${path.relative(process.cwd(), dir) || dir}`); }
  }
}
main();
