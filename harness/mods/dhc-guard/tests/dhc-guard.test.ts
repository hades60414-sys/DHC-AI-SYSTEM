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

test('危險指令要使用者說「確認執行」，而且只放行一次', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))

  const first = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(first.deny).toContain('確認執行')

  await $.prompt.submit({ text: '好，確認執行' })
  const notExact = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(notExact.deny).toContain('確認執行')

  await $.prompt.submit({ text: ' 確認執行 ' })
  const other = await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  expect(other.deny).toContain('確認執行')
  // 換成別筆指令被擋後，原本確認的那筆也不再放行；要重新確認同一筆
  await $.prompt.submit({ text: '確認執行' })
  const second = await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  expect(second).toEqual({ result: 'ran' })

  const third = await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  expect(third.deny).toContain('確認執行')
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

  await $.prompt.submit({ text: '確認執行' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null })
  const out = await $.tool.call({ tool: 'Bash', command: 'git push --force' })
  expect(out.deny).toContain('確認執行')
})

test('MCP SQL 工具的 DROP 也會擋', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  const out = await $.tool.call({ tool: 'mcp__rag1__ragent_sql', sql: 'DROP TABLE x' })
  expect(out.deny).toContain('DROP')
})
