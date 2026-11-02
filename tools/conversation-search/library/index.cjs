// 把 cards/ 底下的摘要卡整理成目錄：每個資料夾一份 README.md（日期、標題、目標第一條），總目錄 INDEX.md 列資料夾。
// 不叫模型。build.cjs 跑完後執行：node index.cjs
const fs = require('fs'), path = require('path')
const CARDS = path.join(__dirname, 'cards')
const folders = fs.existsSync(CARDS) ? fs.readdirSync(CARDS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : []
const top = []
for (const f of folders.sort()) {
  const dir = path.join(CARDS, f)
  const rows = fs.readdirSync(dir).filter(n => n.endsWith('.md') && n !== 'README.md').sort().reverse().map(n => {
    const t = fs.readFileSync(path.join(dir, n), 'utf8')
    const title = (t.match(/^# (.+)$/m) || [, '(無標題)'])[1].trim()
    const goal = ((t.split(/^## 目標\s*$/m)[1] || '').split(/^## /m)[0].match(/^\s*(?:\d+\.|[-*])\s*(.+)$/m) || [, ''])[1].replace(/\s*\[#[\d,#\s]+\]\s*$/, '').trim()
    return { n, title, goal }
  })
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${f}（${rows.length} 段對話）\n\n` + rows.map(r => `- ${r.n.slice(0, 10)} [${r.title}](${r.n})${r.goal ? ` — ${r.goal.slice(0, 80)}` : ''}`).join('\n') + '\n')
  top.push({ f, count: rows.length, latest: rows[0]?.n.slice(0, 10) || '', last: rows[0]?.title || '' })
}
top.sort((a, b) => b.latest.localeCompare(a.latest))
fs.writeFileSync(path.join(__dirname, 'INDEX.md'), `# 對話圖書館總目錄（${new Date().toISOString().slice(0, 10)} 產生，${top.reduce((a, b) => a + b.count, 0)} 張卡）\n\n` +
  '先看資料夾 → 讀該資料夾 README.md → 讀卡片 → 要細節用卡片 frontmatter 的 source 指令帶 #編號讀原文。\n\n' +
  top.map(t => `- [${t.f}](cards/${encodeURI(t.f)}/README.md)（${t.count}，最近 ${t.latest}：${t.last.slice(0, 40)}）`).join('\n') + '\n')
console.log(`目錄完成：${top.length} 個資料夾`)
