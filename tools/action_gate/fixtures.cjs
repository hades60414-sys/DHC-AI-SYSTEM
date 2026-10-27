'use strict';
// 讀兩套題庫的畫面資訊（visible）與 selftest 裡手寫的提案範例（[提案, 題庫評分類別]），只讀、不改原檔。
// 範例物件用 vm 在沙箱裡求值（只含 H、F 兩個常數），不會執行 selftest 本身。
const fs = require('fs'), path = require('path'), vm = require('vm');
const EXP = path.resolve(__dirname, '../../experiments');
const BANKS = { T: path.join(EXP, 'task_design_20260926/control'), Q: path.join(EXP, 'q2_blind_20260929/control') };

function literal(src, name) { // 取出 `const NAME = { ... };` 這一段物件字面值
  const i = src.indexOf(`const ${name} = {`); if (i < 0) return null;
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(j, k + 1); }
  return null;
}
function evalFixtures(file, name) {
  const src = fs.readFileSync(file, 'utf8'), lit = literal(src, name); if (!lit) return {};
  const ctx = { H: { action: 'HOLD', args: {}, reason: 'x' }, F: { action: 'FINISH', args: {}, reason: 'done' } };
  return vm.runInNewContext('(' + lit + ')', ctx, { timeout: 1000 });
}
function loadFixtures() {
  const cases = {}, oracle = {}, fixtures = {};
  for (const [tag, dir] of Object.entries(BANKS)) {
    const cs = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8')).cases, or = JSON.parse(fs.readFileSync(path.join(dir, 'oracle.json'), 'utf8')).cases;
    for (const c of cs) { cases[c.id] = c; oracle[c.id] = or[c.id]; }
    const fx = evalFixtures(path.join(dir, tag === 'T' ? 'selftest.cjs' : 'selftest_q2.cjs'), 'FX');
    for (const [k, list] of Object.entries(fx)) { const id = tag === 'T' ? (cs.find(c => c.meta?.design_key === k) || {}).id : k; if (id) fixtures[id] = list; }
  }
  return { cases, oracle, fixtures };
}
module.exports = { loadFixtures, BANKS };
