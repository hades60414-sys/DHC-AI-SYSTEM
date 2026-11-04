// secret-guard 正反例：node harness/hooks/test/secret-guard.test.cjs（只餵字串，不執行任何指令）
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOOK = path.join(__dirname, '..', 'secret-guard.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-home-'));

function run(input) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: 'utf8',
  });
  return r.status;
}
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
// 假 token 用拼接產生，免得 repo 的敏感字掃描（scripts/scan-sensitive.mjs）把測試樣本當成外洩
const SK = 'sk' + '-abcdefghijklmnopqrstuvwx1234';
const SK_ANT = 'ant-api03-ABCDEFGHIJKLMNOPQRSTUV';
const GHP = 'gh' + 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123';
const BASIC = 'dXNlcjpw' + 'YXNzd29yZDEyMzQ1Ng==';

const BLOCK = [
  bash('echo ' + SK),
  bash('cat <<EOF\n' + SK + '\nEOF'),          // 行首（舊版 JSON.stringify 後漏掉）
  bash('printf "a\t' + SK + '"'),               // tab 後
  bash('cat <<EOF\nA123456789\nEOF'),                                // 身分證在行首
  bash('echo sk-""' + SK_ANT),                // 引號拆字
  bash('echo SK-' + SK_ANT),
  bash('echo ' + GHP),
  bash('echo AKIAABCDEFGHIJKLMNOP'),
  bash('curl -H "Authorization: Basic ' + BASIC + '"'),
  bash('echo A１23456789'),                                          // 全形數字
  bash('echo 4111 1111 1111 1111'),
  bash('echo 4111.1111.1111.1111'),
  bash('echo 4111111111111111'),
  { tool_name: 'mcp__x__send', tool_input: { body: { nested: ['token ' + SK] } } },
  { tool_name: 'Write', tool_input: { file_path: '/x/a.env', content: 'KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } },
];
const ALLOW = [
  bash('ls -la'),
  bash('printf "%s" 2026 11 04 18 30 00 1'),                         // 數字參數不是卡號
  bash('echo order 1234567890123452'),                               // 無發卡機構開頭
  bash('docker pull node@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
  bash('echo "first line\nsecond line"'),
  { tool_name: 'Bash', tool_input: null },                            // 舊版 TypeError
  'null',
];

let fail = 0;
// 效能：200 KB 一長串英數字（舊版 Email 規則是平方時間，要 47 秒）
{
  const t0 = Date.now();
  const st = run(bash('echo ' + 'a'.repeat(200000)));
  const ms = Date.now() - t0;
  if (st !== 0 || ms > 3000) { fail++; console.log(`  FAIL 200KB 長字串：status ${st}、${ms} ms`); }
}
// Email 仍是提醒（exit 0 + systemMessage），不攔下
{
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(bash('mail a.b+c@example.org')), env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: 'utf8' });
  if (r.status !== 0 || !/Email/.test(r.stdout)) { fail++; console.log('  FAIL Email 提醒', r.status, r.stdout); }
}
for (const c of BLOCK) if (run(c) !== 2) { fail++; console.log('  FAIL 應攔下:', JSON.stringify(c)); }
for (const c of ALLOW) if (run(c) !== 0) { fail++; console.log('  FAIL 應放行:', JSON.stringify(c)); }
console.log(`secret-guard 攔下 ${BLOCK.length}、放行 ${ALLOW.length}：` + (fail ? `FAILED ${fail}` : 'ALL PASS'));
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
