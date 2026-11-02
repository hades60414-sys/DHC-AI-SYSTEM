// 對話圖書館（借 Librarian Agents，arXiv 2026-10）：替每段對話預先寫一張摘要卡，每條都標回原文的訊息編號，
// 再依專案資料夾分層，查舊事時先翻目錄、需要細節再用 search.cjs --session <id> --around <#編號> 讀原文。
// 用法：node build.cjs [--limit N] [--session <id>] [--min-chars 1500] [--dry]
// 只讀 index.db；卡片寫在 library/cards/<資料夾>/<日期>-<session前8碼>.md；已有卡且對話沒變長就略過。
const fs = require('fs'), path = require('path')
const { DatabaseSync } = require('node:sqlite')
const { claudeRunner } = require('../judge.cjs')

const ROOT = __dirname, CARDS = path.join(ROOT, 'cards'), LOG = path.join(ROOT, 'build-log.jsonl')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1] }
const LIMIT = +arg('--limit', 1e9), ONLY = arg('--session'), MIN = +arg('--min-chars', 1500), DRY = process.argv.includes('--dry')
const MAX_CHARS = 60000, PER_MSG = 600

const db = new DatabaseSync(path.join(ROOT, '..', 'data', 'index.db'), { readOnly: true })
const sessions = db.prepare(`select d.session, max(d.cwd) cwd, min(d.ts) t0, max(d.ts) t1, count(*) n, sum(length(d.text)) c, max(t.title) title
  from docs d left join titles t on t.session = d.session where d.kind = 'convo' and d.role in ('user','assistant','compact')
  group by d.session having c >= ? order by t1 desc`).all(MIN).filter(s => !ONLY || s.session.startsWith(ONLY))
const rowsOf = db.prepare(`select id, role, text from docs where session = ? and kind = 'convo' and role in ('user','assistant','compact') order by ts, id`)

const SYSTEM = `你是圖書館員，替一段工作對話寫一張摘要卡，給日後的人找舊事用。只能用給你的對話內容，不准猜、不准補外部知識。
每一行開頭是 #編號，代表那則訊息。卡片格式（繁體中文、Markdown，沒有的段落寫「無」）：
# <一行標題：做了什麼事>
## 目標
## 決定與理由
## 產出（檔案路徑、指令、上線的東西）
## 結果與驗證
## 沒做完或待決
規則：每一條項目結尾都要標出處，例如 [#123] 或 [#123,#130]，只能用對話裡出現過的編號；使用者的要求盡量照原話；路徑、指令、數字照原文；每段最多 6 條；全卡不超過 2500 字。只輸出卡片本身。`

const folderOf = cwd => (String(cwd || '_unknown').split(/[\\/]/).filter(Boolean).pop() || '_unknown').replace(/[<>:"|?*]/g, '_')
const day = ts => new Date(ts).toISOString().slice(0, 10)
const cardPath = s => path.join(CARDS, folderOf(s.cwd), `${day(s.t0)}-${s.session.slice(0, 8)}.md`)

function transcript(rows) {
  const lines = rows.map(r => `#${r.id} [${r.role === 'user' ? '使用者' : r.role === 'compact' ? '壓縮摘要' : '助手'}] ${r.text.replace(/\s+/g, ' ').slice(0, r.role === 'user' ? PER_MSG * 2 : PER_MSG)}`)
  let total = lines.reduce((a, l) => a + l.length, 0)
  if (total <= MAX_CHARS) return lines.join('\n')
  // 太長：保留頭尾，中間只留使用者訊息，再不夠就從中間丟
  const keep = lines.map((l, i) => i < 30 || i >= lines.length - 60 || l.includes('] [使用者]') || / \[使用者\] /.test(l) ? l : null)
  let out = keep.filter(Boolean); total = out.reduce((a, l) => a + l.length, 0)
  while (total > MAX_CHARS && out.length > 100) { const m = Math.floor(out.length / 2); total -= out[m].length; out.splice(m, 1) }
  return out.join('\n')
}

// 檢查出處：引用的編號必須在這段對話裡；沒標出處的項目數記下來
function check(card, ids) {
  const cited = [...card.matchAll(/#(\d+)/g)].map(m => +m[1])
  const bad = cited.filter(i => !ids.has(i))
  const items = card.split(/\r?\n/).filter(l => /^\s*[-*\d]/.test(l) && !/無\s*$/.test(l))
  const uncited = items.filter(l => !/\[#\d+/.test(l)).length
  return { cited: cited.length, bad: [...new Set(bad)], items: items.length, uncited }
}

;(async () => {
  let done = 0
  for (const s of sessions) {
    if (done >= LIMIT) break
    const out = cardPath(s)
    if (fs.existsSync(out) && (fs.readFileSync(out, 'utf8').match(/^chars: (\d+)$/m) || [])[1] >= s.c) continue
    const rows = rowsOf.all(s.session), ids = new Set(rows.map(r => r.id))
    const text = transcript(rows)
    if (DRY) { console.log(`[dry] ${out}  ${s.n} 則 ${s.c} 字 → 送 ${text.length} 字`); done++; continue }
    const t = Date.now()
    const r = await claudeRunner({ system: SYSTEM, prompt: `對話標題：${s.title || '無'}\n資料夾：${s.cwd}\n\n${text}`, model: 'haiku', timeoutMs: 180000 })
    let env = {}; try { env = JSON.parse(r.stdout) } catch {}
    const card = String(env.result || '').trim()
    const usage = env.usage || {}
    const rec = { ts: new Date().toISOString(), session: s.session, ms: Date.now() - t, sent: text.length, ok: !!card && !env.is_error, in: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0), out: usage.output_tokens || 0 }
    if (!rec.ok) { rec.err = String(env.result || r.stderr || 'no-output').slice(0, 200); fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); console.log(`失敗 ${s.session.slice(0, 8)} ${rec.err}`); continue }
    Object.assign(rec, check(card, ids))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, `---\nsession: ${s.session}\ncwd: ${s.cwd}\nfrom: ${new Date(s.t0).toISOString()}\nto: ${new Date(s.t1).toISOString()}\nmessages: ${s.n}\nchars: ${s.c}\nsource: node D:/TAS/jev/search.cjs --session ${s.session} --around <#編號>\nbad_citations: ${rec.bad.join(',') || 'none'}\nuncited_items: ${rec.uncited}\n---\n\n${card}\n`)
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
    console.log(`${out}  ${rec.ms}ms in=${rec.in} out=${rec.out} 出處 ${rec.cited} 錯 ${rec.bad.length} 無出處 ${rec.uncited}/${rec.items}`)
    done++
  }
  console.log(`完成 ${done} 張（候選 ${sessions.length} 段，門檻 ${MIN} 字）`)
})()
