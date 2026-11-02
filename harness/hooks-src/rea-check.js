// UserPromptSubmit：使用者要「抄／仿／複刻」別人的產品或功能時，提醒先用 REA（reverse-engineer-anything）拆解再做。
// 只提醒不攔；同一個對話只提醒一次（記號檔放暫存資料夾）。
const fs = require('fs'), path = require('path'), os = require('os')
const HIT = /(抄|仿照|仿製|仿做|模仿|複刻|山寨|照著做|借鏡|\bclone\b|\bcopy\b.{0,20}\b(feature|app|ui)\b|像\s*\S{1,20}\s*(那樣|一樣)|參考\s*\S{1,20}\s*的?\s*(功能|做法|設計|概念|介面|UI|UX))/i
let raw = ''
process.stdin.on('data', d => raw += d).on('end', () => {
  try {
    const j = JSON.parse(raw), prompt = String(j.prompt || '')
    if (!HIT.test(prompt)) return
    const mark = path.join(os.tmpdir(), `rea-check-${String(j.session_id || 'x').replace(/\W/g, '')}`)
    if (fs.existsSync(mark)) return
    fs.writeFileSync(mark, prompt.slice(0, 200))
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
      '使用者要抄／仿別人的產品或功能。動手設計前先用 reverse-engineer-anything（REA）技能拆解對方怎麼做：'
      + '目標是拿得到的成品（桌面程式、Electron、npm 套件、瀏覽器外掛、可下載的網頁 bundle）就跑 REA 靜態分析；'
      + '有原始碼就直接讀碼；目標是條款禁止反組譯的線上服務（Google／Gemini、ChatGPT、Microsoft 等）就只看公開文件與實際操作行為，並在回覆說明為何沒拆程式碼。'
      + '在回覆寫一行「拆了什麼、用什麼方法、學到的關鍵做法」。' } }))
  } catch {}
})
