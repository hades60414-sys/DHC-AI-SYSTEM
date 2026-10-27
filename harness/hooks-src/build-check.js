// PreToolUse(Write)：要新建 skill、hook、mod、外掛或 MCP 設定檔時，提醒先跑 reuse-before-build 找現成。
// 只提醒不攔；同一個對話只提醒一次（記號檔放暫存資料夾）。改既有檔不提醒。
const fs = require('fs'), path = require('path'), os = require('os')
let raw = ''
process.stdin.on('data', d => raw += d).on('end', () => {
  try {
    const j = JSON.parse(raw), p = String(j.tool_input?.file_path || '').split(path.sep).join('/').replace(/\\/g, '/')
    if (!p || fs.existsSync(p)) return
    if (!/(\/skills\/[^/]+\/SKILL\.md$|\/hooks\/[^/]+\.(c?js|mjs|ts|ps1|cmd)$|\/\.claude-plugin\/(plugin|marketplace)\.json$|\/mods\/[^/]+\/|\/\.mcp\.json$)/i.test(p)) return
    const mark = path.join(os.tmpdir(), `build-check-${String(j.session_id || 'x').replace(/\W/g, '')}`)
    if (fs.existsSync(mark)) return
    fs.writeFileSync(mark, p)
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext:
      '你正要新建一個 skill／hook／mod／外掛檔。若這個對話還沒做過，先照 reuse-before-build 技能搜現成（node ~/.claude/skills/reuse-before-build/scripts/find-existing.cjs <關鍵字>），在回覆寫一行「搜了什麼、為何仍自建」。已搜過就繼續。' } }))
  } catch {}
})
