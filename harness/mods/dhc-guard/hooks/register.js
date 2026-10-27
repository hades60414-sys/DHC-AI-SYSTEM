import { findRisky, inputText, isConfirm, commandHash, CONFIRM_WORD } from './rules.js'

// 被攔下的那一筆記下雜湊；使用者整句回「確認執行」後只放行同一雜湊的那一筆（只放一次，回合結束就清掉）
// 網頁版（CloudCLI SDK）每則訊息可能換一個 claude 程序，所以待確認的雜湊存進 $.store（依 session、15 分鐘失效）
let approved = null
const PENDING_TTL_MS = 15 * 60 * 1000
async function pendingKey($) {
  try { return 'pending:' + (await $.session.id()) } catch { return 'pending:default' }
}

// $.store 不可用時（例如測試環境）退回這個程序內的記憶
const local = new Map()
async function getPending($, key) {
  try { return await $.store.get(key) } catch { return local.get(key) }
}
async function setPending($, key, value) {
  local.set(key, value)
  try { await $.store.set(key, value) } catch {}
}
async function takePending($) {
  const key = await pendingKey($)
  const p = await getPending($, key)
  local.delete(key)
  try { await $.store.delete(key) } catch {}
  return p && Date.now() - p.at <= PENDING_TTL_MS ? p.h : null
}

const SHELL = ['Bash', 'PowerShell', 'Monitor']
const shellText = (e) => (SHELL.includes(e.tool) ? e.command || '' : inputText(e))

export function register(on) {
  // 只信 Claude Code 本身送進來的使用者訊息；其他 mod 用 $.prompt.submit 送的不算
  on('prompt.submit', async ($, e, next) => {
    if (next.origin.tier === 'core' && isConfirm(e.text)) {
      const h = await takePending($)
      if (h) approved = h
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) approved = null
    return next(e)
  })

  // 10-27 起 srv-main 可跑 Python，不再擋（舊規則只適用 srv-old 的 EndpointGuard）

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Monitor', /^mcp__\w+__ragent_(?:sql|cmd)$/] }, async ($, e, next) => {
    const text = shellText(e)
    const risky = findRisky(text)
    if (!risky) return next(e)
    const h = await commandHash(e.tool, text)
    if (approved && approved === h) {
      approved = null
      return next(e)
    }
    await setPending($, await pendingKey($), { h, at: Date.now() })
    return {
      deny:
        'dhc-guard：這是危險指令（' + risky + '，指紋 ' + h.slice(0, 8) + '），已攔下沒有執行。' +
        '先用一兩句話告訴使用者要刪／改什麼、影響範圍，請使用者整句只回覆「' + CONFIRM_WORD + '」；' +
        '使用者回覆後再送一次「一字不差」的同一筆指令才會放行（只放行這一筆、一次）。不要換寫法繞過。',
    }
  }).catch(async () => ({ deny: 'dhc-guard：危險指令守門出錯，這筆指令沒有執行。請回報使用者。' }))
}
