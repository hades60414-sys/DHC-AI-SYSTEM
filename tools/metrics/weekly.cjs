// 每週量一次「AI 有沒有少耗使用者的決策力」（11-03 觀察者提案、使用者同意），結果加一列到 history.tsv。
//   node weekly.cjs [--no-judge]      （--no-judge 只跑不花模型額度的那項）
// ① 只回一句好的比例（assent-baseline.cjs，規則固定）：越低代表越少問了沒資訊量的問題。
// ③ 不返工收下率（rw-data.cjs＋rw-judge.cjs，sonnet 判讀最近 14 天「宣稱完成→下一則」）：越高代表交出去的東西越少被打回。
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const run = (f, env = {}) => execFileSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 1800000 });
const lastJson = (s) => { const l = s.trim().split('\n').reverse().find((x) => x.startsWith('{')); return l ? JSON.parse(l) : {}; };
const a = JSON.parse(run('assent-baseline.cjs').trim().split('\n')[0]);
const r = process.argv.includes('--no-judge') ? {} : lastJson(run('rw-judge.cjs'));
const row = [new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), a.after.assentPct, a.after.itemizedPct, a.after.msgs,
  r.pairs ?? '', r.A ?? '', r.C ?? '', r.strictAccepted ?? '', r.acceptedNoChange ?? ''];
const H = path.join(__dirname, 'history.tsv');
if (!fs.existsSync(H)) fs.writeFileSync(H, '日期\t只回一句好\t逐項回答\t訊息數(hook後)\t完成次數(14天)\t返工A\t小調整C\t不返工收下率\t不用調整收下率\n', 'utf8');
fs.appendFileSync(H, row.join('\t') + '\n', 'utf8');
console.log(row.join('\t'));
