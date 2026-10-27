#!/usr/bin/env node
// 自建前先找現成：搜已知外掛市集、已裝外掛的技能、本機技能與 hooks，列出最相關的候選。
// 用法：node find-existing.cjs <關鍵字...> [--top N]
const fs = require('fs'), path = require('path'), os = require('os')
const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const args = process.argv.slice(2)
const ti = args.indexOf('--top'); const top = ti >= 0 ? +args.splice(ti, 2)[1] || 15 : 15
const terms = args.join(' ').toLowerCase().split(/[\s,，、/]+/).filter(Boolean)
if (!terms.length) { console.error('用法：node find-existing.cjs <關鍵字...> [--top N]'); process.exit(2) }

const read = f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(d, e.name)) } catch { return [] } }
const front = txt => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt); const o = {}
  if (m) for (const l of m[1].split(/\r?\n/)) { const k = /^(\w[\w-]*):\s*(.*)$/.exec(l); if (k) o[k[1]] = k[2].replace(/^["']|["']$/g, '') }
  return o
}
const installed = new Set(Object.keys((JSON.parse(read(path.join(home, 'plugins', 'installed_plugins.json')) || '{}').plugins) || {}))
const items = []

// 1. 已知市集裡的外掛（含沒裝的）
for (const mp of dirs(path.join(home, 'plugins', 'marketplaces'))) {
  const j = JSON.parse(read(path.join(mp, '.claude-plugin', 'marketplace.json')) || '{}')
  const mpName = j.name || path.basename(mp)
  for (const p of j.plugins || []) {
    const id = `${p.name}@${mpName}`
    items.push({ kind: installed.has(id) ? '外掛(已裝)' : '外掛(未裝)', name: id, desc: p.description || '', where: p.homepage || (typeof p.source === 'string' ? p.source : p.source?.url || p.source?.repo || '') })
  }
}
// 2. 本機技能（~/.claude/skills）與已裝外掛帶的技能
const skillDirs = [...dirs(path.join(home, 'skills'))]
for (const mp of dirs(path.join(home, 'plugins', 'cache'))) for (const pl of dirs(mp)) for (const ver of dirs(pl)) skillDirs.push(...dirs(path.join(ver, 'skills')))
for (const d of skillDirs) {
  const f = front(read(path.join(d, 'SKILL.md'))); if (!f.name && !f.description) continue
  items.push({ kind: d.includes(`${path.sep}cache${path.sep}`) ? '外掛技能' : '本機技能', name: f.name || path.basename(d), desc: f.description || '', where: d })
}
// 3. 本機 hooks（檔頭第一段註解當說明）
for (const f of (() => { try { return fs.readdirSync(path.join(home, 'hooks')) } catch { return [] } })()) {
  if (!/\.(c?js|mjs|ts|ps1|cmd)$/.test(f)) continue
  const p = path.join(home, 'hooks', f), head = read(p).split(/\r?\n/).slice(0, 8).filter(l => /^\s*(\/\/|#|::|rem )/i.test(l)).join(' ')
  items.push({ kind: '本機hook', name: f, desc: head, where: p })
}

const score = it => { const n = it.name.toLowerCase(), d = it.desc.toLowerCase(); let s = 0; for (const t of terms) { if (n.includes(t)) s += 3; if (d.includes(t)) s += 1 } return s }
const hits = items.map(it => ({ ...it, s: score(it) })).filter(it => it.s > 0).filter((it, i, a) => a.findIndex(x => x.kind === it.kind && x.name === it.name) === i).sort((a, b) => b.s - a.s).slice(0, top)
console.log(`搜尋：${terms.join(' ')}（共比對 ${items.length} 項）`)
if (!hits.length) console.log('沒有命中。換同義詞或英文再搜一次，再上網查 GitHub。')
for (const h of hits) console.log(`[${h.s}] ${h.kind}  ${h.name}\n     ${h.desc.slice(0, 160)}\n     ${h.where}`)
