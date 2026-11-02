import { expect, test } from 'claude-code/testing'
import { findLocalPython, findRisky } from '../hooks/rules.js'

test('本機 python 的各種寫法都抓得到', async () => {
  for (const c of [
    'python -c "print(1)"',
    'pythonw x.py',
    'py -3 x.py',
    'C:\\Python312\\python.exe x.py',
    'cd foo && python3 run.py',
    'pip install pandas',
    '& python x.py',
    'cmd /c python x.py',
    'uv run x.py',
  ]) expect(findLocalPython(c)).not.toBe(null)
  for (const c of ['node x.js', 'grep -r python .', 'cat a.py', 'echo pip', 'ls ~/python-stuff', 'git log --grep=py']) {
    expect(findLocalPython(c)).toBe(null)
  }
})

test('危險指令清單', async () => {
  for (const c of [
    'rm -rf build',
    'rm -r build',
    'rm -fr build',
    'git push --force origin main',
    'git push -f',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'Remove-Item C:\\x -Recurse -Force',
    'rmdir /s /q x',
    'DROP TABLE dbo.Pos',
    'truncate table t',
    'DELETE FROM dbo.Pos',
  ]) expect(findRisky(c)).not.toBe(null)
  for (const c of ['rm a.txt', 'git push origin main', 'git reset HEAD', 'DELETE FROM t WHERE id=1', 'SELECT * FROM t', 'Remove-Item a.txt']) {
    expect(findRisky(c)).toBe(null)
  }
})

test('Bash 跑 python 與 node 都照常', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  const py = await $.tool.call({ tool: 'Bash', command: 'python -c "print(1)"' })
  expect(py).toEqual({ result: 'ran' })
  const ok = await $.tool.call({ tool: 'Bash', command: 'node -e "1"' })
  expect(ok).toEqual({ result: 'ran' })
})

test('MCP 遠端指令不受 Python 禁令影響', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  const out = await $.tool.call({ tool: 'mcp__ragent__ragent_cmd', command: 'python x.py' })
  expect(out).toEqual({ result: 'ran' })
})

test('危險指令要使用者整句說「確認執行」；確認後同回合同工具同類都放行，別類照擋', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))

  const first = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(first.deny).toContain('確認執行')

  await $.prompt.submit({ text: '好，確認執行' })
  const notExact = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(notExact.deny).toContain('確認執行')

  await $.prompt.submit({ text: ' 確認執行 ' })
  const same = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(same).toEqual({ result: 'ran' })
  const sameKind = await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  expect(sameKind).toEqual({ result: 'ran' })

  const otherKind = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })
  expect(otherKind.deny).toContain('git reset --hard')
  const otherTool = await $.tool.call({ tool: 'PowerShell', command: 'rm -rf dist' })
  expect(otherTool.deny).toContain('確認執行')
})

test('同類放行不能夾帶別類：組合指令裡有沒確認過的類別照擋', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await $.prompt.submit({ text: '確認執行' })
  const mixed = await $.tool.call({ tool: 'Bash', command: 'rm -rf dist && git reset --hard HEAD~1' })
  expect(mixed.deny).toContain('git reset --hard')
  const sql = await $.tool.call({ tool: 'Bash', command: 'sqlcmd -Q "DROP TABLE x" && rm -rf x' })
  expect(sql.deny).toContain('DROP')
  const pure = await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  expect(pure).toEqual({ result: 'ran' })
})

test('沒有待確認的指令時，說「確認執行」不會放行任何東西', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.prompt.submit({ text: '確認執行' })
  const out = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(out.deny).toContain('確認執行')
})

test('Monitor 受危險指令守門，Python 放行', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  const py = await $.tool.call({ tool: 'Monitor', command: 'env python x.py', description: 'x', timeout_ms: 1000 })
  expect(py).toEqual({ result: 'ran' })
  const rk = await $.tool.call({ tool: 'Monitor', command: 'rd /q /s x', description: 'x', timeout_ms: 1000 })
  expect(rk.deny).toContain('rmdir /s')
  const ok = await $.tool.call({ tool: 'Monitor', command: 'tail -f log.txt', description: 'x', timeout_ms: 1000 })
  expect(ok).toEqual({ result: 'ran' })
})

test('確認在回合結束後失效', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Bash', command: 'git push --force' })
  await $.prompt.submit({ text: '確認執行' })
  const ok = await $.tool.call({ tool: 'Bash', command: 'git push --force' })
  expect(ok).toEqual({ result: 'ran' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null })
  const out = await $.tool.call({ tool: 'Bash', command: 'git push --force' })
  expect(out.deny).toContain('確認執行')
})

test('MCP SQL 工具的 DROP 也會擋', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  const out = await $.tool.call({ tool: 'mcp__rag1__ragent_sql', sql: 'DROP TABLE x' })
  expect(out.deny).toContain('DROP')
})
