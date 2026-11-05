// 常設授權單元測試：字首能不能存、指令會不會命中（只呼叫判斷函式，不執行任何指令、不寫 grants\）
const G = require('../grant.cjs');
const L = require('../lib.cjs');
const mk = (machine, prefix, extra = {}) => ({ id: 'abc123', machine, prefix, sha256: L.sha(machine, 'GRANT\n' + prefix), status: 'active',
  expires: new Date(Date.now() + 864e5).toISOString(), usesLeft: 5, ...extra });
const g = mk('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS');
let bad = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) bad++; console.log(ok ? 'OK ' : 'BAD', name, '→', got); };

// 字首能不能存成授權
for (const [p, want] of [
  ['D:\\TAS\\deploy\\push-page.cmd CBAS', true], ['schtasks /run /tn TAS-Report', true], ['copy /y D:\\a\\x.php', true],
  ['del /q D:\\x', false], ['rd /s D:\\x', false], ['schtasks /create /tn X', false], ['schtasks /delete /tn X', false],
  ['sqlcmd -Q "UPDATE t"', false], ['powershell -c x', false], ['net user a b', false], ['icacls D:\\x /grant', false],
  ['curl https://x', false], ['robocopy D:\\a D:\\b /MIR', false], ['setx A_PWD x', false], ['echo %DB_PWD%', false],
  ['copy D:\\a \\\\server\\share', false], ['x.cmd & del y', false], ['move D:\\a D:\\b', false],
]) t('字首 ' + p, !G.unsafe(p), want);

// 指令會不會命中
t('同台同字首＋參數', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS 202611', [g]), true);
t('剛好等於字首', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS', [g]), true);
t('不分大小寫', !!G.match('rag1', 'd:\\tas\\deploy\\PUSH-PAGE.cmd cbas', [g]), true);
t('別台', !!G.match('ragent', 'D:\\TAS\\deploy\\push-page.cmd CBAS', [g]), false);
t('字首後面黏字', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBASX', [g]), false);
t('夾帶串接', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS & del x', [g]), false);
t('夾帶變數', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS %X_PWD%', [g]), false);
t('參數裡有紅線字', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS del', [g]), false);
t('過期', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS', [mk('rag1', g.prefix, { expires: new Date(Date.now() - 1000).toISOString() })]), false);
t('次數用完', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS', [mk('rag1', g.prefix, { usesLeft: 0 })]), false);
// 引號包住的開關：Windows 會去掉引號，"/s" 就是 /s（11-05）
const sq = mk('rag1', 'schtasks /query'), tl = mk('rag1', 'tasklist'), dr = mk('rag1', 'dir');
t('引號開關 schtasks "/s"', !!G.match('rag1', 'schtasks /query "/s" evilhost "/u" admin', [sq]), false);
t('引號開關 tasklist "/S"', !!G.match('rag1', 'tasklist "/S" evil "/U" adm', [tl]), false);
t('引號開關 dir "/s"', !!G.match('rag1', 'dir "/s" C:\\', [dr]), false);
t('schtasks -s 連別台', !G.unsafe('schtasks /query -s evilhost'), false);
t('引號路徑參數照樣可用', !!G.match('rag1', 'dir "D:\\TAS\\out files"', [dr]), true);
t('已撤銷', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS', [mk('rag1', g.prefix, { status: 'revoked' })]), false);
t('授權檔字首被改（指紋不符）', !!G.match('rag1', 'D:\\TAS\\other.cmd CBAS', [{ ...g, prefix: 'D:\\TAS\\other.cmd CBAS' }]), false);

// 11-03 Astra 對抗找到的繞過
for (const [p, c] of [['git -C', 'git -C D:\\scratch clean -fdx'], ['robocopy D:\\src', 'robocopy D:\\src D:\\dst /mov'],
  ['schtasks /run /tn TAS-Report', 'schtasks /run /tn TAS-Report /s other-host /u demo /p example'],
  ['D:\\TAS\\deploy\\push-page.cmd CBAS', 'D:\\TAS\\deploy\\push-page.cmd CBAS /force'],
  ['D:\\TAS\\deploy\\push-page.cmd CBAS', 'D:\\TAS\\deploy\\push-page.cmd CBAS -y']]) t('繞過 ' + c, !!G.match('rag1', c, [mk('rag1', p)]), false);
t('參數是一般值仍放行', !!G.match('rag1', 'D:\\TAS\\deploy\\push-page.cmd CBAS D:\\out\\a-b.php 202611', [g]), true);
t('開關寫在字首裡放行', !!G.match('rag1', 'schtasks /run /tn TAS-Report', [mk('rag1', 'schtasks /run /tn TAS-Report')]), true);

// 並發：剩 3 次、8 個程序同時 consume → 剛好 3 個成功；撤銷與 consume 交錯後一定是 revoked
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const ID = 'fff0aa', F = path.join(G.GDIR, ID + '.json');
fs.mkdirSync(G.GDIR, { recursive: true });
const put = (uses) => fs.writeFileSync(F, JSON.stringify(mk('rag1', g.prefix, { id: ID, usesLeft: uses })), 'utf8');
const race = (n, extra = []) => Promise.all([...Array(n).keys()].map((i) => new Promise((res) => {
  const code = extra.includes(i) ? `require(${JSON.stringify(path.join(__dirname, '..', 'grant.cjs'))}).revoke('${ID}');console.log('R')`
    : `try{require(${JSON.stringify(path.join(__dirname, '..', 'grant.cjs'))}).consume({id:'${ID}'});console.log('OK')}catch(e){console.log('NO')}`;
  const p = spawn(process.execPath, ['-e', code]); let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => res(o.trim()));
})));
(async () => {
  put(3); const r1 = await race(8);
  t('8 個同時扣、剩 3 次 → 成功數', r1.filter((x) => x === 'OK').length, 3);
  t('扣完剩餘次數', JSON.parse(fs.readFileSync(F, 'utf8')).usesLeft, 0);
  let revokedOk = true;
  for (let k = 0; k < 5; k++) { put(50); await race(6, [2]); if (JSON.parse(fs.readFileSync(F, 'utf8')).status !== 'revoked') revokedOk = false; }
  t('撤銷和扣次交錯 5 輪都維持 revoked', revokedOk, true);
  fs.unlinkSync(F);
  console.log(bad ? `FAIL ${bad}` : 'ALL PASS'); process.exitCode = bad ? 1 : 0;
})();
