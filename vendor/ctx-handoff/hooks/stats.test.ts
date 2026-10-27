// 累計統計：交接、整理、離席選擇、攔下的訊息與守門命中都記進 stats:<工作區>，只記帳、不改行為
import { expect, test } from 'claude-code/testing'
import { DAY, cmd, ctl, distillNow, endTurn, pushGuard, resume, say, startSession, stop, world } from './test-world'
import type { Stats } from './records'
import { addBackgroundUsage } from './records'

const statsOf = (w: ReturnType<typeof world>) => w.get('stats:C--proj') as Stats | undefined

test('session用量沿30天清理，工作區累計與未完成retry端點保留', async ($, on) => {
  const stats = addBackgroundUsage(undefined, 0, 'C--proj')
  const retry = { fromTurn: 0, turn: 5, rowCount: 1, last: { role: 'user', text: '待重試' } }
  const w = world(on, 100_000, 1_000_000, {
    'stats:session:old': stats, 'stats:session:boundary': stats, 'stats:C--proj': stats,
    'distill:retry:old': retry,
  })
  await startSession($)
  expect((w.get('seen') as Record<string, number> | undefined)?.['stats:session:old']).toBe(0)
  await w.clock.set(DAY)
  w.put('stats:session:recent', stats)
  await startSession($)
  await w.clock.set(30 * DAY)
  await startSession($)
  expect(w.get('stats:session:boundary')).toEqual(stats)
  await w.clock.set(31 * DAY)
  await startSession($)
  expect(w.get('stats:session:old')).toBeUndefined()
  expect(w.get('stats:session:boundary')).toBeUndefined()
  expect(w.get('stats:session:recent')).toEqual(stats)
  expect(w.get('stats:C--proj')).toEqual(stats)
  expect(w.get('distill:retry:old')).toEqual(retry)
})

test('背景用量只累加實報數值，未知結果不冒充零成本', () => {
  const first = addBackgroundUsage(undefined, 10, 'P', { input: 2, cacheRead: 3, cacheCreation: 4, output: 5, ms: 6 })
  const second = addBackgroundUsage(first, 20, 'P')
  expect(second.background).toEqual({ since: 10, project: 'P', usage: { input: 2, cacheRead: 3, cacheCreation: 4, output: 5, ms: 6 }, unknownResults: 1 })
})

test('本session背景用量包含有usage的失敗，無usage失敗另記未知', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  ctl.completeAborts = true
  await distillNow($)
  ctl.failHandoff = true
  await cmd($, 'dry')
  const background = (w.get('stats:session:S1') as Stats).background
  expect(background).toMatchObject({ project: 'C--proj', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, unknownResults: 1 })
  expect((await cmd($, '')).text).toContain('1 次請求用量未知')
})

test('clear後背景用量仍歸原始來源session，不重複算handoff生成', async ($, on) => {
  const w = world(on, 650_000, 1_000_000, { distill: false })
  ctl.onClear = () => { ctl.curSid = 'S2' }
  await stop($)
  await w.clock.settle()
  expect((w.get('stats:session:S1') as Stats).background).toMatchObject({ usage: { input: 1, cacheRead: 650_000, output: 1 }, unknownResults: 0 })
  expect(w.get('stats:session:S2')).toBeUndefined()
})

test('統計：在場交接成功與交接期間攔下的訊息', async ($, on) => {
  const w = world(on, 650_000, 1_000_000, {}, [], 5)
  ctl.handoffGate = async () => { await say($, '中途訊息') }
  await stop($)
  await w.clock.settle()
  // 交接前整理也會記一次 distill.ok
  expect(statsOf(w)?.counts).toEqual({ 'handoff.present.ok': 1, held: 1, 'distill.ok': 1 })
})

test('統計：交接失敗記次數與原因；攔下的訊息送回舊對話不算遺失', async ($, on) => {
  const w = world(on, 650_000, 1_000_000, {}, [], 5)
  ctl.failHandoff = true
  ctl.handoffGate = async () => { await say($, '中途訊息') }
  await stop($)
  await w.clock.settle()
  const s = statsOf(w)
  expect(s?.counts).toEqual({ 'handoff.present.fail': 1, held: 1, 'distill.ok': 1 })
  expect(s?.failures.map(f => f.what)).toEqual(['handoff.present.fail'])
})

test('統計：離席交接過時刪掉、選 continue、選 resume 各記一次', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, { 'away:S1': { handoff: 'H' } })
  await endTurn($)
  w.put('away:S1', { handoff: 'H', held: '我回來了' })
  await cmd($, 'continue')
  w.put('away:S1', { handoff: 'H' })
  await resume($)
  await w.clock.advance(0)
  expect(statsOf(w)?.counts).toEqual({ 'away.stale': 1, 'away.continue': 1, 'away.resume': 1 })
})

test('統計：整理成功與失敗分開記，失敗留原因', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, {}, [], 5)
  // 失敗不推進進度，下一次整理同一段
  ctl.completeAborts = true
  await distillNow($)
  ctl.completeAborts = false
  await distillNow($)
  const s = statsOf(w)
  expect(s?.counts['distill.ok']).toBe(1)
  expect(s?.counts['distill.fail']).toBe(1)
  expect(s?.failures[0]?.detail).toContain('timeout')
})

test('統計：守門命中留下指令片段給評估判斷擋得對不對；疑似金鑰不記內容', async ($, on) => {
  const w = world(on, 1000, 1_000_000, { 'guards:C--proj': [pushGuard('on')] })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.tool.call({ tool: 'Bash', command: 'GH=ghp_abc git push' })
  const s = statsOf(w)
  expect(s?.counts['guard.hit.1']).toBe(2)
  expect(s?.hits.map(h => h.detail)).toEqual(['#1 Bash: git push origin main', '疑似金鑰'])
})
