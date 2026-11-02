// 回合預算提醒（2026-10-31）：防止單一回合原地打轉、無上限燒 token（例：8bc8bbfa 一回合 165 次工具呼叫約 4.8M）。
// 只提醒不攔。UserPromptSubmit 歸零；PostToolUse／PostToolUseFailure 計數，子代理（agent_id）各自分開算。
// 提醒時機：工具呼叫第 CALLS 次與 2×CALLS 次；同一呼叫失敗第 3 次；同回合第 3 個會寫檔的子代理。
// 測試可用環境變數 TURN_BUDGET_CALLS 調低門檻；TURN_BUDGET_OFF=1 關閉。
const fs = require('fs'), path = require('path'), os = require('os')
const CALLS = Number(process.env.TURN_BUDGET_CALLS) || 60
const READONLY_AGENTS = /^(scout|Explore|verifier|plan-verifier|observer|security-reviewer|Plan|codex-scout|codex-verifier|statusline-setup)$/
let raw = ''
process.stdin.on('data', d => raw += d).on('end', () => {
  try {
    if (process.env.TURN_BUDGET_OFF === '1') return
    const j = JSON.parse(raw), ev = j.hook_event_name
    const file = path.join(os.tmpdir(), `turn-budget-${String(j.session_id || 'x').replace(/\W/g, '')}.json`)
    if (ev === 'UserPromptSubmit') { fs.writeFileSync(file, '{}'); return }
    let st = {}; try { st = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const key = j.agent_id || 'main', s = st[key] || (st[key] = { calls: 0, fails: {}, writers: 0 })
    const notes = []
    s.calls++
    if (s.calls === CALLS || s.calls === 2 * CALLS)
      notes.push(s.calls === CALLS
        ? `這一回合已經呼叫工具 ${s.calls} 次，改走這個方向：(1) 在工作資料夾寫一份 CHECKPOINT.md（目標／已完成／下一步／卡點，10 行內）；(2) 剩下的工作拆成 2–4 段，依序派子代理執行，每段把結果寫檔、只回路徑和 5 行摘要；(3) 給使用者一行進度。除非下一步只剩 5 次以內的呼叫就能收尾。`
        : `這一回合已經呼叫工具 ${s.calls} 次，現在停：更新 CHECKPOINT.md，回報使用者「做到哪、還差什麼、預估還要多少」，等下一則訊息再繼續。`)
    if (ev === 'PostToolUseFailure') {
      const { description, ...inp } = j.tool_input || {}   // description 每次措辭不同，不列入比對
      const sig = j.tool_name + ':' + JSON.stringify(inp).slice(0, 200)
      s.fails[sig] = (s.fails[sig] || 0) + 1
      if (s.fails[sig] === 3)
        notes.push(`同一個 ${j.tool_name} 呼叫已經失敗 3 次，換方向：不要再重試同一寫法；改用唯讀方式查真正原因（讀錯誤訊息全文、查版本／路徑／權限、找現成範例），定位後只做一次修正；還是不行就停下來回報卡點。`)
    }
    if (j.tool_name === 'Agent' && ev === 'PostToolUse' && !READONLY_AGENTS.test(String((j.tool_input || {}).subagent_type || 'general-purpose'))) {
      s.writers++
      if (s.writers === 3)
        notes.push('這一回合已經派出 3 個會寫檔的子代理，換方向：接下來的子代理一律依序跑（run_in_background: false，等前一個完成再派下一個），每個只負責一組不重疊的檔案。')
    }
    fs.writeFileSync(file, JSON.stringify(st))
    if (notes.length)
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: '【回合預算】' + notes.join(' ') } }))
  } catch {}
})
