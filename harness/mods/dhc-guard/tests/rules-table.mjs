// 正反例表：node mods/dhc-guard/tests/rules-table.mjs（只比對字串，不執行任何指令）
import { findLocalPython, findRisky, isConfirm, commandHash } from '../hooks/rules.js'

const PY_BLOCK = [
  'python -c "print(1)"', 'pythonw x.py', 'py -3 x.py', 'C:\\Python312\\python.exe x.py',
  'cd foo && python3 run.py', 'pip install pandas', '& python x.py', 'cmd /c python x.py', 'uv run x.py',
  'env python x.py', 'env -i PATH=/x python x.py', 'nohup python x.py', 'FOO=1 python x.py', 'FOO=1 BAR=2 py x.py',
  'bash -c "python a.py"', 'sh -lc \'pip list\'', 'powershell -c "python a.py"', 'powershell -NoProfile -Command "python a.py"',
  'pwsh -c "& python a.py"', 'Start-Process python -ArgumentList a.py', 'Start-Process -FilePath python.exe',
  'start "" python a.py', '"C:/Program Files/Python312/python.exe" x.py', '& "C:\\Program Files\\Python312\\python.exe" x.py',
  'ipython', 'conda run -n base python x.py', 'poetry run pytest', 'pipx run black .', 'echo $(python -V)',
  'git commit -m "$(python gen.py)"', 'cat a | xargs python', 'node -e "require(\'child_process\').execSync(\'python x.py\')"',
  'cmd //c python x.py', 'iex "python x.py"', 'timeout 10 python x.py', 'python3.12.exe x.py', 'pip.cmd install x',
]
const PY_ALLOW = [
  'node x.js', 'grep -r python .', 'cat a.py', 'echo pip', 'ls ~/python-stuff', 'git log --grep=py',
  'node scripts/python-check.js', 'node -e "fs.readFileSync(\'python.txt\')"', 'node -e "console.log(\'python\')"',
  'cat "C:/Program Files/Python312/README.txt"', 'where python', 'Get-Command python', 'rg "python" -g "*.js"',
  'git commit -m "remove python usage"', 'echo "python x.py"', 'npm i python-shell', 'Get-Content C:\\tools\\python\\notes.txt',
  'ls C:/Python312', 'node tools/pip-audit-report.cjs', 'type requirements.txt',
]

const RISKY_BLOCK = [
  'rm -rf build', 'rm -r build', 'git push --force origin main', 'git push -f', 'git reset --hard HEAD~1', 'git clean -fd',
  'Remove-Item C:\\x -Recurse -Force', 'rmdir /s /q x', 'DROP TABLE dbo.Pos', 'truncate table t', 'DELETE FROM dbo.Pos',
  'rd /q /s x', 'rd x /q /s', 'del /f/s/q x', 'del /s /q *.tmp', 'Remove-Item x -r', 'Remove-Item x -Rec', 'ri x -Recurse',
  'git push origin +main', 'git push origin +HEAD:main', 'git branch -D feat', 'git branch --delete --force feat',
  'git checkout -- .', 'git checkout .', 'robocopy a b /MIR', 'robocopy a b /mir /R:1', 'DELETE dbo.Pos',
  'delete t', 'sqlcmd -Q "DELETE t"', 'UPDATE t SET x=1', 'update dbo.Pos set qty=0', 'DROP/**/TABLE t',
  'DELETE FROM t -- WHERE id=1', 'UPDATE t SET x=1 /* WHERE id=1 */', 'DELETE TOP (10) FROM t',
]
const RISKY_ALLOW = [
  'rm a.txt', 'git push origin main', 'git reset HEAD', 'DELETE FROM t WHERE id=1', 'SELECT * FROM t', 'Remove-Item a.txt',
  'del a.txt', 'del /q a.txt', 'rd emptydir', 'rd C:/a/s/b', 'git branch -d feat', 'git checkout -- src/a.js',
  'git checkout main', 'robocopy a b /E', 'UPDATE t SET x=1 WHERE id=2', 'npm update', 'apt update', 'git push origin main:main',
  'echo "delete me"', 'curl -X DELETE https://api.example/x', 'Get-ChildItem -Recurse', 'dir /s', 'findstr /s foo *.txt',
  'git log --oneline; sqlcmd -Q "DELETE FROM t WHERE id=1"', 'Remove-Item x -Force', 'git diff -- .',
  'DELETE FROM t WHERE a = 1 -- note',
]

let fail = 0
const check = (name, list, fn, wantHit) => {
  let ok = 0
  for (const c of list) {
    const r = fn(c)
    if (!!r === wantHit) ok++
    else { fail++; console.log('  FAIL [' + name + '] ' + JSON.stringify(c) + ' -> ' + r) }
  }
  console.log(name + ': ' + ok + '/' + list.length)
}
check('python 擋', PY_BLOCK, findLocalPython, true)
check('python 不擋', PY_ALLOW, findLocalPython, false)
check('危險 擋', RISKY_BLOCK, findRisky, true)
check('危險 不擋', RISKY_ALLOW, findRisky, false)

const conf = [['確認執行', true], ['  確認執行\n', true], ['　確認執行　', true], ['好，確認執行', false], ['確認執行吧', false], ['請貼 SOP：確認執行後…', false], ['', false]]
let cok = 0
for (const [t, want] of conf) { if (isConfirm(t) === want) cok++; else { fail++; console.log('  FAIL [confirm] ' + JSON.stringify(t)) } }
console.log('確認字整句比對: ' + cok + '/' + conf.length)

const h1 = await commandHash('Bash', 'rm -rf build'), h2 = await commandHash('Bash', 'rm -rf build '), h3 = await commandHash('PowerShell', 'rm -rf build')
if (h1 === (await commandHash('Bash', 'rm -rf build')) && h1 !== h2 && h1 !== h3 && h1.length === 64) console.log('雜湊: ok')
else { fail++; console.log('  FAIL [hash]') }

console.log(fail ? 'FAILED ' + fail : 'ALL PASS')
process.exit(fail ? 1 : 0)
