// PreToolUse（全部工具）：計畫性維護時讓每個對話在下一個工具呼叫前暫停，寫好 checkpoint 再結束這回合。
// 只有已配置的服務根目錄下 drain.json 存在、未滿 3 小時、而且不是 except 名單裡的對話才攔。
// 被攔的對話記一筆到 drain/paused/<session>.json，重啟後由 drain.cjs resume 逐一叫回來。
const fs = require('fs'), path = require('path')
const ROOT = process.env.DRAIN_ROOT || require('./das-config.js').load().drainRoot
const DIR = `${ROOT}/drain`, FLAG = `${ROOT}/drain.json`, MAX_AGE = 3 * 3600e3
let raw = ''
process.stdin.on('data', d => raw += d).on('end', () => {
  try {
    if (!ROOT) return // 未配置維護服務就不啟用
    if (!fs.existsSync(FLAG)) return
    const flag = JSON.parse(fs.readFileSync(FLAG, 'utf8'))
    if (Date.now() - Date.parse(flag.since) > MAX_AGE) return
    const j = JSON.parse(raw), sid = String(j.session_id || '')
    if (!sid || (flag.except || []).includes(sid)) return
    const ckpt = `${DIR}/${sid}.md`
    const target = String(j.tool_input?.file_path || '').replace(/\\/g, '/').toLowerCase()
    if (['Write', 'Edit'].includes(j.tool_name) && target === ckpt.toLowerCase()) return // 寫 checkpoint 本身放行
    fs.mkdirSync(`${DIR}/paused`, { recursive: true })
    const rec = `${DIR}/paused/${sid}.json`
    if (!fs.existsSync(rec)) fs.writeFileSync(rec, JSON.stringify({ sessionId: sid, cwd: j.cwd, permissionMode: j.permission_mode, at: new Date().toISOString() }))
    const reason = j.agent_id
      ? `【計畫性維護暫停】TAS 即將重啟（${flag.reason || '維護'}）。你是子代理：不要再呼叫工具，直接把目前進度（做完什麼、做到哪、還差什麼）當最後回覆交回主對話，然後結束。`
      : `【計畫性維護暫停】TAS 即將重啟（${flag.reason || '維護'}）。不要再執行其他工具，照下面做：\n1. 用 Write 把 checkpoint 寫到 ${ckpt}：目標、已完成、進行中的步驟做到哪（含只做一半的檔案或子代理）、下一步、注意事項。\n2. 寫完就結束這回合，只回一句「已暫停，維護完成後會自動續跑」。\n重啟後系統會叫你讀這份 checkpoint 接著做。`
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  } catch {}
})
