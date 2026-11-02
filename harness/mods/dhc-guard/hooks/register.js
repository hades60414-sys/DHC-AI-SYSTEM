import { findAllRisky, inputText, isConfirm, commandHash, CONFIRM_WORD } from './rules.js'

// 被攔下的那一筆記下雜湊與類別；使用者整句回「確認執行」後，這一回合內放行同一工具、同一類的危險指令（10-28 起，
// 避免一批同類刪除要確認好幾次）；換一類或回合結束就要重新確認
// 網頁版（CloudCLI SDK）每則訊息可能換一個 claude 程序，所以待確認的雜湊存進 $.store（依 session、15 分鐘失效）
let approved = null // { h, tool, labels }
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
  return p && Date.now() - p.at <= PENDING_TTL_MS ? p : null
}

const SHELL = ['Bash', 'PowerShell', 'Monitor']
const shellText = (e) => (SHELL.includes(e.tool) ? e.command || '' : inputText(e))

export function register(on) {
  // 只信 Claude Code 本身送進來的使用者訊息；其他 mod 用 $.prompt.submit 送的不算
  on('prompt.submit', async ($, e, next) => {
    if (next.origin.tier === 'core' && isConfirm(e.text)) {
      const p = await takePending($)
      if (p) approved = { h: p.h, tool: p.tool, labels: p.labels || [] }
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
    const labels = findAllRisky(text)
    if (!labels.length) return next(e)
    const risky = labels.join('、')
    const h = await commandHash(e.tool, text)
    // 同類放行：同一工具，而且這筆命中的每一類都在確認過的類別裡（不能夾帶別類）
    if (approved && (approved.h === h || (approved.tool === e.tool && labels.every((l) => approved.labels.includes(l))))) return next(e)
    await setPending($, await pendingKey($), { h, tool: e.tool, labels, at: Date.now() })
    return {
      deny:
        'dhc-guard：這是危險指令（' + risky + '，指紋 ' + h.slice(0, 8) + '），已攔下沒有執行。' +
        '先用一兩句話告訴使用者要刪／改什麼、影響範圍；這一批還要做的同類操作一次列完，' +
        '請使用者整句只回覆「' + CONFIRM_WORD + '」。使用者回覆後再送一次「一字不差」的同一筆指令就會放行，' +
        '同一回合內同一工具、同一類（' + risky + '）的其他指令也會放行，不用再問；換一類或回合結束要重新確認。不要換寫法繞過。',
    }
  }).catch(async () => ({ deny: 'dhc-guard：危險指令守門出錯，這筆指令沒有執行。請回報使用者。' }))
}
