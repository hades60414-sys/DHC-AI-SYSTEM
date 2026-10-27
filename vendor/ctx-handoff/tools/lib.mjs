// 工具共用：Claude 設定目錄、經驗檔解析（記憶、規則、流程）與帶入量估算（和 hooks/notes.ts 的 parseNotes／contextText 同規則）
import { homedir } from 'node:os'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const claudeDir = () => (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).replace(/\\/g, '/')

export const NOTES_NAME = 'ctx-handoff.md'

export function parseNotes(text) {
  const notes = { memory: [], rules: [], procedures: [], extra: [] }
  let section, rule, inItem = false
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('## ')) {
      section = line.startsWith('## 記憶') ? 'memory' : line.startsWith('## 規則') ? 'rules' : line.startsWith('## 流程') ? 'procedures' : 'extra'
      rule = undefined
      inItem = false
      if (section === 'extra') notes.extra.push(line)
      continue
    }
    if (section === 'extra') { notes.extra.push(line); continue }
    if (section === 'memory') {
      if (line.startsWith('- ')) { notes.memory.push(line); inItem = true }
      else if (inItem && line.trim() && !line.startsWith('#')) notes.memory[notes.memory.length - 1] += `\n${line}`
      else inItem = false
    }
    if (section !== 'rules' && section !== 'procedures') continue
    const list = section === 'rules' ? notes.rules : notes.procedures
    const head = /^### (.+?)（(\d+) 次）\s*$/.exec(line)
    if (head) { rule = { name: head[1], count: Number(head[2]), body: [] }; list.push(rule) }
    else if (line.startsWith('### ')) { rule = { name: line.slice(4).trim(), count: 1, body: [] }; list.push(rule) }
    else if (rule && line.trim()) rule.body.push(line)
  }
  while (notes.extra.at(-1) === '') notes.extra.pop()
  return notes
}

// 新對話開頭帶入的字數：偏好與修正（user／feedback）在 14 天內或根據 ≥ 2 筆時整條帶入，否則退為只帶標題；
// 事實與位置（project／reference）與單次 feedback 超過 30 天封存；加上出現 2 次以上且尚未放進專案的前 15 條規則
export function injectedChars(notes, day = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)) {
  const ruleText = r => (r.body.find(l => l.startsWith('- 規則：')) ?? r.body[0] ?? '').replace(/^- 規則：/, '').trim()
  const inProj = r => r.body.some(l => l.startsWith('- 專案：已在 '))
  const rules = notes.rules.filter(r => r.count >= 2 && !inProj(r)).sort((a, b) => b.count - a.count).slice(0, 15)
  let memChars = 0
  for (const raw of notes.memory) {
    const lines = raw.split('\n')
    const head = lines[0] ?? ''
    const isFact = /^- \[(?:project|reference)\] /.test(head)
    const isFeedback = /^- \[feedback\] /.test(head)
    const evLines = lines.slice(1).filter(l => /^\s+- 根據：/.test(l))
    const dates = evLines.map(l => /^\s+- 根據：(\d{4}-\d{2}-\d{2})/.exec(l)?.[1]).filter(Boolean).sort()
    const seen = dates.at(-1)
    const age = seen ? Date.parse(day) - Date.parse(seen) : undefined
    if ((isFact || (isFeedback && evLines.length < 2)) && age !== undefined && age > 30 * 24 * 60 * 60_000) continue
    if (!isFact && (age === undefined || evLines.length >= 2 || age <= 14 * 24 * 60 * 60_000)) {
      const kept = lines.filter(l => !/^\s+- 根據：/.test(l))
      memChars += kept.join('\n').length + 1
    } else {
      memChars += head.length + 1
    }
  }
  return memChars + rules.map(r => `- ${r.name}（${r.count} 次）：${ruleText(r)}`).join('\n').length
}

// 所有專案的經驗檔：{ dir, file }
export function notesFiles() {
  const base = `${claudeDir()}/projects`
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(`${base}/${d.name}/memory/${NOTES_NAME}`))
    .map(d => ({ dir: d.name, file: `${base}/${d.name}/memory/${NOTES_NAME}` }))
}

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

// 本地時間「MM-DD HH:mm」
export const local = ms => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(5, 16).replace('T', ' ')
}
