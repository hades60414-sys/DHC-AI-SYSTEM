// 背景整理：套用 JSONL 動作、錨點、帶入新對話、壞行與金鑰過濾、工作區經驗檔
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { NOTE_TAG, composer, cmd, say, endTurn, stop, NOTES, distillNow, EXISTING, ALPHA, ALPHA_NOTES, repo, lastOf, actionsReply, ctl, world } from './test-world'

test('狀態列顯示整理進度：平常是再幾則整理，整理時顯示正在整理，整理完重算', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  await endTurn($)
  expect(w.statuses.at(-1)).toBe('再 25 則整理筆記')
  expect((await cmd($, '')).text).toContain('下次：再 25 則')
  await distillNow($)
  expect(w.statuses).toContain('正在整理筆記…')
  expect(w.get('distill:error:C--proj')).toBeUndefined()
  expect(w.statuses.at(-1)).toBe('再 30 則整理筆記')
  await cmd($, 'distill off')
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('閒置刷新順便整理：寫入專案經驗檔、濾掉疑似金鑰、差異排入下一則訊息，沒新訊息就只刷新', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  await $.prompt.submit({ text: '請幫我  整理\n這段對話', origin: composer, wait: false })
  await endTurn($)
  await w.clock.advance(55 * 60_000)
  // 刷新是只回 OK 的 fork，整理是另一個 complete 請求，附上這段對話
  expect(w.forks).toEqual(['只回覆 OK'])
  expect(w.completes.length).toBe(1)
  expect(w.completes[0]?.system).toContain('範圍：整段對話')
  expect(w.completes[0]?.prompt).toContain('【使用者】請幫我  整理\n這段對話')
  expect(w.completes[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
  const notes = w.files.get(NOTES) ?? ''
  expect(notes).toContain('## 記憶\n- [project] 使用者決定交接門檻維持 600k')
  expect(notes).not.toContain('api_key')
  expect(notes).toContain('### 先實測再下結論（1 次）')
  expect(notes).toContain('- 根據：1970-01-01 fork 能否讀寫靠實測才確定')
  const status = await cmd($, '')
  expect(status.text).toContain('新增記憶：[project] 使用者決定交接門檻維持 600k')
  // 第二次刷新：沒有新訊息，只回 OK
  await w.clock.advance(55 * 60_000)
  expect(w.forks).toEqual(['只回覆 OK', '只回覆 OK'])
  expect(w.completes.length).toBe(1)
  // 差異不用 session.append，而是跟著下一則送進對話的訊息
  await say($, '下一則')
  expect(w.contexts[1]?.[0]).toContain(NOTE_TAG)
  expect(w.contexts[1]?.[0]).toContain('新增記憶：[project] 使用者決定交接門檻維持 600k')
})

test('交接前整理一次，再 /clear', async ($, on) => {
  const w = world(on, 650_000, 1_000_000, {}, [], 5)
  await stop($)
  await w.clock.advance(0)
  expect(w.forks.length).toBe(1)
  expect(w.completes.length).toBe(1)
  expect(w.completes[0]?.system).toContain('=== ACTIONS ===')
  expect(w.commands).toEqual(['clear'])
  expect(w.files.get(NOTES) ?? '').toContain('600k')
})

test('依編號套用新增／更新／刪除／確認，超出範圍的忽略；錨點接續上次', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, { 'distill:S1': { turn: 3, anchor: '上次最後一則訊息' } }, [], 6)
  w.files.set(NOTES, EXISTING)
  ctl.distillReply = actionsReply(
    { op: 'update_memory', id: 'M1', type: 'feedback', title: '改過的 A', quote: '上次最後一則訊息' },
    { op: 'delete_memory', id: 'M2', reason: '已過時' },
    { op: 'add_memory', type: 'user', title: '新的偏好', how: '照做', evidence: '使用者提過', quote: '更早的…訊息' },
    { op: 'delete_memory', id: 'M9', reason: '超出範圍' },
    { op: 'confirm_rule', id: 'R1', evidence: '又被證實一次' },
    { op: 'delete_rule', id: 'R2', reason: '被推翻' },
    { op: 'confirm_rule', id: 'R9', evidence: '超出範圍' },
    { op: 'add_rule', name: '沒有規則內容的條目', evidence: '缺規則，應丟棄' },
  )
  w.rows.push(
    { role: 'user', text: '更早的訊息', toolUses: [] },
    { role: 'user', text: '上次最後一則訊息', toolUses: [] },
    { role: 'assistant', text: '好的', toolUses: [{ tool: 'Bash', input: { command: 'ls' }, text: 'a.ts' }] },
  )
  await distillNow($)
  expect(w.completes[0]?.system).toContain('使用者說「上次最後一則訊息」')
  // 只附上錨點之後的對話；工具呼叫留名稱、輸入與結果
  expect(w.completes[0]?.prompt).toContain('【助理】好的')
  expect(w.completes[0]?.prompt).toContain('〔工具 Bash〕{"command":"ls"} → a.ts')
  expect(w.completes[0]?.prompt).not.toContain('更早的訊息')
  expect(w.completes[0]?.system).toContain('M1 [feedback] 舊 A')
  expect(w.completes[0]?.system).toContain('R2 規則二｜出現 2 次｜做 Y')
  const notes = w.files.get(NOTES) ?? ''
  // 根據由程式補日期與 session；原話可用 … 省略中間
  expect(notes).toContain([
    '- [feedback] 改過的 A',
    '  - 根據：1970-01-01 S1｜使用者原話：「上次最後一則訊息」',
    '- [user] 新的偏好',
    '  - 做法：照做',
    '  - 根據：1970-01-01 S1｜使用者提過｜使用者原話：「更早的…訊息」',
  ].join('\n'))
  expect(notes).not.toContain('舊 B')
  expect(notes).toContain('### 規則一（2 次）\n- 規則：做 X\n- 根據：1970-01-01 第一次\n- 根據：1970-01-01 又被證實一次')
  expect(notes).not.toContain('規則二')
  expect(notes).not.toContain('沒有規則內容')
})

test('新對話開頭帶入記憶與出現 2 次以上的規則', async ($, on) => {
  const w = world(on, 100_000)
  w.files.set(NOTES, EXISTING)
  const r = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
  const block = r.blocks.find(b => b.name === 'ctxHandoffProject')
  expect(r.blocks[0]?.name).toBe('currentDate')
  expect(block?.text).toContain('- [feedback] 舊 A')
  expect(block?.text).toContain('- 規則二（2 次）：做 Y')
  expect(block?.text).not.toContain('規則一')
})

test('沒有經驗檔：新對話開頭不帶入', async ($, on) => {
  world(on, 100_000)
  const r = await $.prompt.context({ blocks: [] })
  expect(r.blocks).toEqual([])
})

test('整理期間檔案被手動修改：不套用、不排入，下次重新整理同一段', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  w.files.set(NOTES, EXISTING)
  ctl.onComplete = () => { w.files.set(NOTES, `${EXISTING}\n- [user] 使用者剛手動加的\n`) }
  const r = await distillNow($)
  expect(r.text).toContain('整理期間經驗檔被修改')
  expect(w.files.get(NOTES) ?? '').toContain('使用者剛手動加的')
  await say($, '下一則')
  expect(w.contexts[0]).toBeUndefined()
  // 沒有推進進度：下次還會整理
  ctl.onComplete = undefined
  await distillNow($)
  expect(w.completes.length).toBe(2)
})

test('每 30 則訊息整理一次；不到 30 則不整理', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 30)
  await endTurn($)
  await w.clock.advance(0)
  expect(w.completes.length).toBe(1)
  // 再結束一個回合：上次已整理到第 30 則，不再觸發
  await endTurn($)
  await w.clock.advance(0)
  expect(w.completes.length).toBe(1)
})

test('設定 distill_every：改成每 10 則就整理，狀態列倒數跟著它', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 10)
  ctl.panelSettings = { distill_every: 10 }
  await endTurn($)
  await w.clock.advance(0)
  expect(w.completes.length).toBe(1)
  expect((await cmd($, '')).text).toContain('每 10 則')
})

test('重複整理：同一條記憶不會重複寫入，沒有變動就不排入', async ($, on) => {
  let n = 5
  const w = world(on, 100_000, 1_000_000, {}, [], () => n)
  await distillNow($)
  n = 9
  ctl.distillReply = actionsReply({ op: 'add_memory', type: 'project', text: '使用者決定交接門檻維持 600k' })
  await distillNow($)
  const notes = w.files.get(NOTES) ?? ''
  expect(notes.split('使用者決定交接門檻維持 600k').length).toBe(2)
  expect(notes.split('## 記憶').length).toBe(2)
  // 只有第一次的變動被排入：帶入一次，內容不重複
  await say($, '下一則')
  expect((w.contexts[0]?.[0] ?? '').split('新增記憶').length).toBe(2)
})

test('錨點：記下使用者最後一則訊息，下次整理從它之後開始', async ($, on) => {
  let n = 5
  const w = world(on, 100_000, 1_000_000, {}, [], () => n)
  await $.prompt.submit({ text: '請幫我  整理\n這段對話', origin: composer, wait: false })
  await $.prompt.submit({ text: '/handoff', origin: composer, wait: false })
  await distillNow($)
  expect(w.completes[0]?.system).toContain('範圍：整段對話')
  n = 9
  await distillNow($)
  expect(w.completes[1]?.system).toContain('使用者說「請幫我 整理 這段對話」')
})

// ---------- JSONL 動作與工作區經驗檔 ----------

const read = ($: Engine, file: string) => $.tool.call({ tool: 'Read', file_path: file })

test('JSONL 一行壞掉、一個不認得的 op：有效的照套用，記下丟棄 2 行與樣本，狀態看得到', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  ctl.distillReply = actionsReply(
    { op: 'add_memory', type: 'project', title: '有效的一條', evidence: 'x' },
    '{這不是 JSON',
    { op: 'explode', text: '不認得的 op' },
    '',
    { op: 'add_rule', name: '有效規則', rule: '做 Z', applies: 'a', not_applies: 'b', evidence: 'c' },
  )
  const r = await distillNow($)
  const notes = w.files.get(NOTES) ?? ''
  expect(notes).toContain('- [project] 有效的一條')
  expect(notes).toContain('### 有效規則（1 次）\n- 規則：做 Z\n- 適用：a｜不適用：b\n- 根據：1970-01-01 c')
  const last = lastOf(w)
  expect(last.rejected.count).toBe(2)
  // 樣本帶丟棄原因，事後查得出是哪一種
  expect(last.rejected.samples[0]).toStartWith('JSON 格式錯誤（')
  expect(last.rejected.samples[0]).toEndWith('）：{這不是 JSON')
  expect(last.rejected.samples[1]).toBe('不認得的 op（explode）：{"op":"explode","text":"不認得的 op"}')
  expect(r.text).toContain('丟棄 2 行無效輸出')
})

test('JSONL 樣本最多 3 個；長的行保留頭 100 字與尾 50 字', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  ctl.distillReply = actionsReply('x'.repeat(300), 'b', 'c', 'd')
  await distillNow($)
  const { rejected } = lastOf(w)
  expect(rejected.count).toBe(4)
  expect(rejected.samples.length).toBe(3)
  expect(rejected.samples[0]).toEndWith(`：${'x'.repeat(100)}…${'x'.repeat(50)}`)
  expect(rejected.samples[0]?.length).toBeLessThan(260)
  expect(rejected.samples[2]).toEndWith('：c')
})

test('疑似金鑰的動作整行丟棄（任何欄位），樣本不記內容', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  ctl.distillReply = actionsReply(
    { op: 'add_memory', type: 'project', title: '正常的一條', evidence: 'x' },
    { op: 'add_memory', type: 'project', title: '金鑰 ghp_abcdefghijklmnop', evidence: 'x' },
    { op: 'add_rule', name: '規則', rule: '做事', applies: 'a', not_applies: 'b', evidence: 'password=hunter2' },
    { op: 'delete_memory', id: 'M1', reason: 'token: abc' },
    '這行不是 JSON 但有 api_key=zzz',
  )
  w.files.set(NOTES, EXISTING)
  await distillNow($)
  const notes = w.files.get(NOTES) ?? ''
  expect(notes).toContain('- [project] 正常的一條')
  expect(notes).toContain('舊 A')
  expect(notes).not.toMatch(/ghp_|hunter2|api_key/)
  const { rejected } = lastOf(w)
  expect(rejected.count).toBe(4)
  expect(JSON.stringify(rejected.samples)).not.toMatch(/ghp_|hunter2|api_key|token/)
})

test('欄位裡的換行會收成一個空格，不會寫出多行或新標題', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  ctl.distillReply = actionsReply({ op: 'add_memory', type: 'project', title: '第一行\n## 假標題\n第三行', evidence: 'x' })
  await distillNow($)
  const notes = w.files.get(NOTES) ?? ''
  expect(notes).toContain('- [project] 第一行 ## 假標題 第三行')
  expect(notes.match(/^## 記憶/gm)?.length).toBe(1)
})

test('動作的 type 不在 user|feedback|project|reference、缺必要欄位：丟棄', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  ctl.distillReply = actionsReply(
    { op: 'add_memory', type: 'bogus', text: '類型不對' },
    { op: 'add_memory', text: '沒有類型' },
    { op: 'add_memory', type: 'user' },
    { op: 'add_rule', name: '缺欄位', rule: 'r', applies: 'a', evidence: 'e' },
    { op: 'delete_rule', id: 'R1' },
  )
  w.files.set(NOTES, EXISTING)
  await distillNow($)
  expect(lastOf(w).rejected.count).toBe(5)
  expect(w.files.get(NOTES) ?? '').toBe(EXISTING)
})

test('整理提示：繁體中文指示、只有這個工作區的記憶與規則編號、JSONL 輸出格式；別的 repo 的經驗不列入', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  w.files.set(NOTES, EXISTING)
  w.files.set(ALPHA_NOTES, '# x\n\n## 記憶\n- [user] alpha 的記憶\n\n## 規則\n\n### alpha 規則（3 次）\n- 規則：做 A\n')
  repo(w, ALPHA)
  await read($, `${ALPHA}/a.ts`)
  await distillNow($)
  const p = w.completes[0]?.system ?? ''
  expect(p).toContain('用使用者在對話裡使用的語言撰寫（使用者寫中文就用繁體中文（台灣））；程式碼、指令、路徑、錯誤訊息與專有名詞維持原文')
  expect(p).toContain('不要用他、她等代名詞猜性別')
  expect(p).toContain('M2 [project] 舊 B')
  expect(p).toContain('R1 規則一｜出現 1 次｜做 X')
  expect(p).not.toContain('alpha')
  expect(p).not.toContain('P2')
  expect(p).toContain('=== ACTIONS ===')
  expect(p).toContain('=== END ===')
  expect(p).toContain('{"op":"add_memory","type":"feedback","title":"…","how":"…","why":"…","evidence":"…","quote":"…"}')
  expect(p).toContain('{"op":"delete_rule","id":"R4","reason":"…"}')
  expect(p).toContain('{"op":"add_procedure","name":"…","when":"…","steps":["…","…","…"],"evidence":"…"}')
  expect(p).toContain('目前的流程：')
  expect(p).toContain('只收同一種工作在這段對話裡被做了不只一次')
  // 碰過別的 repo 也只寫這個工作區的經驗檔
  expect(w.files.get(ALPHA_NOTES) ?? '').not.toContain('使用者決定交接門檻維持 600k')
  expect(w.files.get(NOTES) ?? '').toContain('使用者決定交接門檻維持 600k')
})

test('沒有 ACTIONS 標記的輸出：不套用，記一行丟棄；空的 ACTIONS 區塊視為沒有變動', async ($, on) => {
  let n = 5
  const w = world(on, 100_000, 1_000_000, {}, [], () => n)
  ctl.distillReply = '我覺得沒什麼好整理的'
  await distillNow($)
  expect(w.files.has(NOTES)).toBe(false)
  expect(lastOf(w).rejected.count).toBe(1)
  n = 9
  ctl.distillReply = actionsReply()
  await distillNow($)
  expect(w.files.has(NOTES)).toBe(false)
  expect(lastOf(w).rejected.count).toBe(0)
})

for (const reply of ['', '沒有變動', '=== ACTIONS ===', actionsReply('{broken'), actionsReply({ op: 'unknown' })]) {
  test(`無法使用的整理輸出不消耗這段對話：${reply.slice(0, 30)}`, async ($, on) => {
    const w = world(on, 100_000, 1_000_000, {}, [], 5)
    ctl.distillReply = reply
    const result = await distillNow($)
    expect(result.text).not.toContain('整理完成')
    expect(w.get('distill:S1')).toBeUndefined()
    expect(w.get('distill:error:C--proj')).toMatchObject({ reason: '整理輸出沒有可採用的動作；已保留這段對話供下次重試' })
    expect(w.get('stats:C--proj')).toMatchObject({ counts: { 'distill.fail': 1 } })
    expect(w.files.has(NOTES)).toBe(false)
    ctl.distillReply = actionsReply()
    await distillNow($)
    expect(w.completes.length).toBe(2)
    expect(w.get('distill:S1')).toMatchObject({ turn: 5 })
  })
}

test('墓碑不能靠已整理過的使用者原話復活；壓縮後找不到舊錨點時也不能靠全對話原話復活', async ($, on) => {
  let turns = 6
  const w = world(on, 100_000, 1_000_000, {
    'distill:S1': { turn: 3, anchor: '之前要求保留舊 B' },
    'tombstones:C--proj': { known: [], dead: [{ title: '舊 B', at: 0 }] },
  }, [], () => turns)
  w.rows.push({ role: 'user', text: '之前要求保留舊 B', toolUses: [] }, { role: 'user', text: '現在改做另一件事', toolUses: [] })
  ctl.distillReply = actionsReply(
    { op: 'add_memory', type: 'project', title: '舊 B', evidence: '又談到了', quote: '之前要求保留舊 B' },
    { op: 'add_memory', type: 'project', title: '本批新事實', evidence: '新內容' },
  )
  await distillNow($)
  expect(w.files.get(NOTES) ?? '').not.toContain('舊 B')
  expect(lastOf(w).rejected.samples.join('\n')).toContain('使用者刪過「舊 B」')
  // 送出一則訊息讓 last:S1 設好錨點並整理推進，接著模擬對話被壓縮重組（找不到該錨點且最後一則改變）
  await say($, '壓縮前最後一則訊息')
  turns = 8
  ctl.distillReply = actionsReply()
  await distillNow($)
  w.rows.length = 0
  w.rows.push({ role: 'user', text: '壓縮摘要裡保留了舊 B 的字樣', toolUses: [] })
  turns = 11
  ctl.distillReply = actionsReply(
    { op: 'add_memory', type: 'project', title: '舊 B', evidence: '壓縮後提到', quote: '壓縮摘要裡保留了舊 B 的字樣' },
    { op: 'add_memory', type: 'project', title: '壓縮後另一件新事實', evidence: '新內容' },
  )
  await distillNow($)
  expect(w.files.get(NOTES) ?? '').not.toContain('舊 B')
  expect(w.files.get(NOTES) ?? '').toContain('壓縮後另一件新事實')
  expect(w.get('distill:S1')).toMatchObject({ turn: 11 })
})

for (const when of ['before', 'after']) {
  test(`必要經驗檔讀取失敗不覆寫、不推進：${when}`, async ($, on) => {
    const w = world(on, 100_000, 1_000_000, {}, [], 5)
    w.files.set(NOTES, EXISTING)
    const deny = () => { ctl.failRead = { path: NOTES, reason: 'EACCES: permission denied opening /tmp/ENOENT: notes' } }
    if (when === 'before') deny()
    else ctl.onComplete = deny
    await distillNow($)
    expect(w.files.get(NOTES)).toBe(EXISTING)
    expect(w.writes).not.toContain(NOTES)
    expect(w.get('distill:S1')).toBeUndefined()
    expect((w.get('distill:error:C--proj') as { reason: string }).reason).toContain('EACCES')
    expect(w.completes.length).toBe(when === 'before' ? 0 : 1)
  })
}

test('經驗檔寫成後 store 失敗，同一片段重試不重複增加規則與流程次數', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  w.files.set(NOTES, `${EXISTING}\n## 流程\n\n### 發版（1 次）\n- 時機：發版\n- 步驟：\n  1. 測試\n  2. 發布\n`)
  ctl.onComplete = () => { ctl.failStore = { key: 'tombstones:C--proj', remaining: 1 } }
  ctl.distillReply = actionsReply({ op: 'confirm_rule', id: 'R1', evidence: '使用者又要求一次' }, { op: 'confirm_procedure', id: 'P1', evidence: '再次發版' })
  await distillNow($)
  expect(w.files.get(NOTES)).toContain('### 規則一（2 次）')
  expect(w.files.get(NOTES)).toContain('### 發版（2 次）')
  expect(w.get('distill:S1')).toBeUndefined()
  ctl.onComplete = undefined
  ctl.distillReply = actionsReply({ op: 'confirm_rule', id: 'R1', evidence: '同一段使用者重申' }, { op: 'confirm_procedure', id: 'P1', evidence: '同一次再次執行發版' })
  await distillNow($)
  expect(w.files.get(NOTES)).toContain('### 規則一（2 次）')
  expect(w.files.get(NOTES)).toContain('### 發版（2 次）')
  expect(w.get('distill:S1')).toMatchObject({ turn: 5 })
})

test('部分寫入重試凍結原片段，新來的相同要求留給下一批', async ($, on) => {
  let turns = 5
  const w = world(on, 100_000, 1_000_000, {}, [], () => turns)
  w.files.set(NOTES, EXISTING)
  await say($, '使用者再次要求做 X')
  ctl.distillReply = actionsReply({ op: 'confirm_rule', id: 'R1', evidence: '使用者再次要求做 X' }, { op: 'update_rule', id: 'R1', rule: '改做 X' })
  ctl.onComplete = () => { ctl.failStore = { key: 'tombstones:C--proj', remaining: 1 } }
  await distillNow($)
  expect(w.files.get(NOTES)).toContain('### 規則一（2 次）')
  ctl.onComplete = undefined
  turns = 6
  await say($, '下一批的新工作，使用者再次要求做 X')
  ctl.distillReply = actionsReply({ op: 'confirm_rule', id: 'R1', evidence: '換句話重述同一要求' })
  await distillNow($)
  expect(w.completes[1]?.prompt).not.toContain('下一批的新工作')
  expect(w.files.get(NOTES)).toContain('### 規則一（2 次）')
  expect(w.get('distill:S1')).toMatchObject({ turn: 5 })
  await distillNow($)
  expect(w.completes[2]?.prompt).toContain('下一批的新工作')
  expect(w.files.get(NOTES)).toContain('### 規則一（3 次）')
  expect(w.get('distill:S1')).toMatchObject({ turn: 6 })
})

test('完成後重試終點清理失敗不重播或回退checkpoint', async ($, on) => {
  let turns = 5
  const w = world(on, 100_000, 1_000_000, {}, [], () => turns)
  w.files.set(NOTES, EXISTING)
  ctl.failDelete = 'distill:retry:S1'
  ctl.distillReply = actionsReply({ op: 'confirm_rule', id: 'R1', evidence: '再講一次' })
  expect((await distillNow($)).text).toContain('整理完成')
  expect(w.get('distill:S1')).toMatchObject({ turn: 5 })
  expect(w.get('distill:retry:S1')).toBeDefined()
  await distillNow($)
  expect(w.completes.length).toBe(1)
  turns = 6
  await distillNow($)
  expect(w.files.get(NOTES)).toContain('### 規則一（3 次）')
  expect(w.get('distill:S1')).toMatchObject({ turn: 6 })
})

for (const action of [
  { op: 'add_memory', type: 'project', title: '舊 B', evidence: '重試同一條事實' },
  { op: 'approve_guard', id: 'G1', quote: '同意採用守門' },
  { op: 'in_project', id: 'R1', where: 'CLAUDE.md' },
  { op: 'in_project', id: 'G1', where: 'C:/proj/AGENTS.md' },
]) {
  test(`部分成功重試已達成的狀態是合法no-op：${action.op}:${'id' in action ? action.id : action.title}`, async ($, on) => {
    const guardState = action.op === 'in_project' ? 'on' : 'proposed'
    const w = world(on, 100_000, 1_000_000, { 'guards:C--proj': [{ id: 1, state: guardState, rule: '測試守門', tool: 'Bash', match: 'push', message: '提醒', mode: 'remind', at: 0 }] }, [], 5)
    w.files.set(NOTES, EXISTING.replace('規則一（1 次）', '規則一（3 次）'))
    w.files.set('C:/proj/CLAUDE.md', '規則已在此')
    w.files.set('C:/proj/AGENTS.md', '守門已在此')
    await say($, '同意採用守門')
    ctl.distillReply = actionsReply({ op: 'add_memory', type: 'project', title: '本次事實', evidence: '測試' }, action)
    ctl.failStore = { key: 'distill:last:C--proj', remaining: 1 }
    await distillNow($)
    expect(w.get('distill:S1')).toBeUndefined()
    ctl.distillReply = actionsReply(action)
    expect((await distillNow($)).text).toContain('整理完成')
    expect(w.get('distill:S1')).toMatchObject({ turn: 5 })
    expect(lastOf(w).changes).toEqual([])
  })
}

test('只輸出缺檔的 in_project 時整批視為無法使用，不推進進度', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  w.files.set(NOTES, EXISTING.replace('規則一（1 次）', '規則一（3 次）'))
  ctl.distillReply = actionsReply({ op: 'in_project', id: 'R1', where: 'MISSING.md' })
  const r = await distillNow($)
  expect(r.text).not.toContain('整理完成')
  expect(w.get('distill:S1')).toBeUndefined()
  expect(lastOf(w).rejected.count).toBe(1)
  expect(w.get('distill:error:C--proj')).toMatchObject({ reason: '整理輸出沒有可採用的動作；已保留這段對話供下次重試' })
})

test('原片段終點已消失時停止重試，不猜位置或推進', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, { 'distill:retry:S1': { fromTurn: 0, turn: 5, rowCount: 1, last: { role: 'user', text: '原始訊息' } } }, [], 6)
  w.files.set(NOTES, EXISTING)
  w.rows.push({ role: 'user', text: '壓縮後不同訊息', toolUses: [] })
  await distillNow($)
  expect(w.completes).toEqual([])
  expect(w.files.get(NOTES)).toBe(EXISTING)
  expect(w.get('distill:S1')).toBeUndefined()
  expect(w.get('distill:error:C--proj')).toMatchObject({ reason: '找不到上次部分寫入的對話終點；停止整理，未覆寫筆記或推進進度' })
})

test('新增規則與流程部分寫入後改輸出confirm，不把同一事件算兩次', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  ctl.distillReply = actionsReply(
    { op: 'add_rule', name: '先測試', rule: '先測試', applies: '改程式', not_applies: '改文件', evidence: '本次要求' },
    { op: 'add_procedure', name: '驗收', when: '改完程式', steps: ['測試', '檢查'], evidence: '本次流程' },
  )
  ctl.onComplete = () => { ctl.failStore = { key: 'tombstones:C--proj', remaining: 1 } }
  await distillNow($)
  ctl.onComplete = undefined
  ctl.distillReply = actionsReply({ op: 'confirm_rule', id: 'R1', evidence: '改寫同一要求' }, { op: 'confirm_procedure', id: 'P1', evidence: '改寫同一流程' })
  await distillNow($)
  expect(w.files.get(NOTES)).toContain('### 先測試（1 次）')
  expect(w.files.get(NOTES)).toContain('### 驗收（1 次）')
  expect(w.get('distill:S1')).toMatchObject({ turn: 5 })
})

for (const errno of ['ENOENT', 'EACCES', 'ENOTDIR']) {
  test(`真實fs.read錯誤形狀只將缺檔視為空筆記：${errno}`, async ($, on) => {
    const w = world(on, 100_000, 1_000_000, {}, [], 5)
    if (errno !== 'ENOENT') w.files.set(NOTES, EXISTING)
    ctl.failRead = { path: NOTES, reason: `ctx-handoff: $.fs.read(C:\\notes(with parentheses)\\ctx-handoff.md) failed: ${errno}` }
    const result = await distillNow($)
    if (errno === 'ENOENT') {
      expect(result.text).toContain('整理完成')
      expect(w.get('distill:S1')).toMatchObject({ turn: 5 })
    } else {
      expect(result.text).toContain('指令失敗')
      expect(w.files.get(NOTES)).toBe(EXISTING)
      expect(w.writes).not.toContain(NOTES)
      expect(w.get('distill:S1')).toBeUndefined()
    }
  })
}

// 事故（2026-10-14，issue #3）：使用者手動整理掉的記憶，整理不知道刪過，同一段對話還在談那些主題就會加回來
test('墓碑：直接改檔刪掉的記憶，整理加不回來；使用者又提起（附原話）才加回', async ($, on) => {
  let n = 5
  const w = world(on, 100_000, 1_000_000, {}, [], () => n)
  w.files.set(NOTES, EXISTING)
  await distillNow($)
  // 使用者自己改檔刪掉「舊 B」
  w.files.set(NOTES, (w.files.get(NOTES) ?? '').replace('- [project] 舊 B\n', ''))
  n = 9
  ctl.distillReply = actionsReply({ op: 'add_memory', type: 'project', title: '舊 B', evidence: '又談到了' })
  await distillNow($)
  expect(w.completes[1]?.system).toContain('使用者刪掉的記憶')
  expect(w.completes[1]?.system).toContain('- 舊 B')
  expect(w.files.get(NOTES) ?? '').not.toContain('舊 B')
  expect(lastOf(w).rejected.samples.join('\n')).toContain('使用者刪過「舊 B」')
  n = 13
  w.rows.push({ role: 'user', text: '舊 B 其實還是要記著', toolUses: [] })
  ctl.distillReply = actionsReply({ op: 'add_memory', type: 'project', title: '舊 B', evidence: '使用者要求', quote: '舊 B 其實還是要記著' })
  await distillNow($)
  expect(w.files.get(NOTES) ?? '').toContain('- [project] 舊 B')
  // 加回來之後墓碑拿掉，提示也不再列
  n = 17
  ctl.distillReply = actionsReply()
  await distillNow($)
  expect(w.completes[3]?.system).not.toContain('使用者刪掉的記憶')
})

test('墓碑：第一次整理沒有比對對象，不記墓碑；整理自己刪的（被推翻、合併）不算使用者刪的', async ($, on) => {
  let n = 5
  const w = world(on, 100_000, 1_000_000, {}, [], () => n)
  w.files.set(NOTES, EXISTING)
  ctl.distillReply = actionsReply({ op: 'delete_memory', id: 'M2', reason: '被推翻' })
  await distillNow($)
  expect(w.completes[0]?.system).not.toContain('使用者刪掉的記憶')
  n = 9
  ctl.distillReply = actionsReply()
  await distillNow($)
  expect(w.completes[1]?.system).not.toContain('使用者刪掉的記憶')
})
