// 白名單判斷離線測試（只呼叫 check()，不執行任何指令）：該放行的要放行、帶串接／寫入的要開單。node test\whitelist-unit.cjs
const { check } = require('../whitelist.cjs');
const pass = ['hostname', 'HOSTNAME', 'whoami', 'dir C:\\Users', 'dir "C:\\Program Files" /s', 'type C:\\logs\\a.log', 'tasklist /fi "imagename eq node.exe"',
  'netstat -ano', 'findstr /i "error" C:\\logs\\a.log', 'reg query HKLM\\Software\\Microsoft', 'sqlcmd -S . -E -Q "SELECT TOP 5 name FROM sys.databases"'];
const block = ['hostname & del x', 'hostname && shutdown /s', 'dir | findstr a', 'dir > out.txt', 'type a.txt >> b', 'hostname; del x', 'echo %PATH%',
  'dir ^& del', 'dir (x)', 'del x', 'rm -rf x', 'format c:', 'shutdown /r', 'setx A 1', 'reg add HKCU\\x', 'reg delete HKCU\\x', 'sc stop x', 'net user a b /add',
  'regedit', 'hostnamex', 'C:\\evil\\hostname', 'dir\nde l', 'echo !x!', 'sqlcmd -Q "DELETE FROM t"', 'sqlcmd -Q "SELECT * INTO t2 FROM t"',
  'sqlcmd -Q "SELECT 1" -o out.txt', 'sqlcmd -i x.sql', 'sqlcmd -Q "SELECT 1 EXEC xp_cmdshell \'dir\'"', 'sqlcmd -S . -E', 'sqlcmd -Q "SELECT 1" -Q "SELECT 2"',
  'sqlcmd -Q "SELECT 1', 'powershell -c Get-Process', 'cmd /c del x', 'start del',
  // 10-28 verifier 找到的繞過：帶引號的命令字接 \..\ 會執行任意程式
  '"dir"\\..\\..\\..\\..\\..\\..\\Windows\\System32\\cmd.exe /c echo PWNED', '"type"\\..\\..\\..\\..\\..\\..\\Windows\\System32\\chcp.com',
  '"reg" "query"\\..\\..\\..\\..\\..\\Windows\\System32\\cmd.exe', '"sqlcmd"\\..\\..\\..\\..\\..\\..\\Windows\\System32\\cmd.exe /c echo x -Q "SELECT 1"',
  'dir\\..\\..\\Windows\\System32\\cmd.exe', 'dir.exe', 'dir=x', 'dir,x', '@dir', 'reg  query HKCU',
  'sqlcmd -S . -E -Q "SELECT 1 BEGIN DISABLE TRIGGER ALL ON DATABASE END"', 'sqlcmd -S . -E -Q "SELECT 1 BEGIN RECEIVE * FROM dbo.Q END"',
  'sqlcmd -S . -E -Q "SELECT NEXT VALUE FOR dbo.Seq1"', 'sqlcmd -S . -E -Q "SELECT 1 WHILE 1=1 SELECT 1"', 'sqlcmd -S evilhost -E -Q "SELECT 1"',
  'sqlcmd -Sevilhost -E -Q "SELECT 1"', 'dir \\\\1.2.3.4\\share', 'type \\\\evil@80\\x\\y.txt', 'dir //evil/share', 'tasklist /s otherhost',
  // Unicode 空白：JS 當空白、cmd.exe 不當分隔
  'dir \\..\\..\\Windows\\System32\\cmd.exe', 'dir　\\..\\cmd.exe', 'dir x', 'dir​x', 'type\u000bx', 'dir x\u0000'];
pass.push('dir\tC:\\Users');
// 10-28 第二輪：findstr 清單檔、sqlcmd 旗標大小寫與 --、四段式名稱
block.push('findstr pat /f:C:\\temp\\list.txt', 'findstr pat /F:list.txt', 'sqlcmd -S . -E -Q "SELECT 1" -Ox', 'sqlcmd -S . -E -Q "SELECT 1" --output f',
  'sqlcmd -S . -E -Q "select * from [REMOTESRV].master.sys.objects"', 'sqlcmd -S . -E -Q "select * from srv.db.dbo.t"', 'sqlcmd -S . -E -Q "select * from srv..dbo.t"');
pass.push('sqlcmd -S . -E -Q "SELECT name FROM master.sys.databases"', 'findstr /g:pats.txt C:\\logs\\a.log');
pass.push('sqlcmd -S localhost\\SQLEXPRESS -E -Q "SELECT name FROM sys.databases"', 'dir "D:\\TAS\\logs"', 'reg query "HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName');
let bad = 0;
for (const c of pass) { const r = check(c); if (!r.ok) { bad++; console.log('應放行卻擋：', c, r.reason); } }
for (const c of block) { const r = check(c); if (r.ok) { bad++; console.log('應開單卻放行：', c, r.rule); } }
console.log(`放行 ${pass.length} 筆、開單 ${block.length} 筆，錯 ${bad} 筆 → ${bad ? 'RESULT FAIL' : 'RESULT OK'}`);
