// 純判斷函式，不碰 mods API，方便測試

// ---- 本機 Python 偵測：切成 token，只看「指令位置」的字 ----
const PY_NAME = /^(python[\d.]*|pythonw|py|pip[\d.]*|uv|uvx|ipython[\d.]*|conda|poetry|pipx|jupyter(?:-[\w-]+)?)(?:\.exe|\.cmd|\.bat|\.com)?$/i

// 把指令切成簡單指令（字的陣列）；引號內不切，但雙引號裡的 $( ) 與反引號另外收進 subs 再檢查
function split(cmd, subs) {
  const out = []
  let words = [], cur = null, q = null
  const flushWord = () => { if (cur) words.push(cur); cur = null }
  const flushCmd = () => { flushWord(); if (words.length) out.push(words); words = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (q === "'") { if (c === "'") q = null; else cur.text += c; continue }
    if (q === '"') {
      if (c === '"') { q = null; continue }
      if (c === '$' && cmd[i + 1] === '(') {
        let d = 0, j = i + 1
        for (; j < cmd.length; j++) { if (cmd[j] === '(') d++; else if (cmd[j] === ')' && --d === 0) break }
        subs.push(cmd.slice(i + 2, j)); cur.text += cmd.slice(i, j + 1); i = j; continue
      }
      if (c === '`') {
        const j = cmd.indexOf('`', i + 1)
        if (j > i) { subs.push(cmd.slice(i + 1, j)); i = j; continue }
      }
      cur.text += c; continue
    }
    if (c === "'" || c === '"') { if (!cur) cur = { text: '', quoted: false }; cur.quoted = true; q = c; continue }
    if (/[;&|(){}\n`]/.test(c)) { flushCmd(); continue }
    if (/\s/.test(c)) { flushWord(); continue }
    if (!cur) cur = { text: '', quoted: false }
    cur.text += c
  }
  flushCmd()
  return out
}

const base = (w) => w.replace(/^.*[\\/]/, '')
const PREFIX = new Set(['env', 'nohup', 'time', 'exec', 'sudo', 'nice', 'xargs', 'timeout', 'command', 'builtin', 'call', 'stdbuf', 'doas'])
const VALUE_OPT = /^-(?:u|g|C|n|I|P|L|d|a|s|E|ExecutionPolicy|ep|WindowStyle|w)$/i

function checkWords(ws, depth) {
  let i = 0
  while (i < ws.length) {
    const w = ws[i].text
    if (/^[A-Za-z_]\w*=/.test(w)) { i++; continue } // VAR=x 前綴
    const b = base(w).toLowerCase()
    const m = PY_NAME.exec(base(w))
    if (m) return m[1].toLowerCase()
    const rest = ws.slice(i + 1)
    if (PREFIX.has(b)) {
      i++
      while (i < ws.length && (/^-/.test(ws[i].text) || (b === 'timeout' && /^\d/.test(ws[i].text)))) {
        if (VALUE_OPT.test(ws[i].text)) i++
        i++
      }
      continue
    }
    if (b === 'start' || b === 'start-process' || b === 'saps') {
      for (const x of rest.filter((x) => !/^[-/]/.test(x.text)).slice(0, 2)) {
        const r = PY_NAME.exec(base(x.text)) || null
        if (r) return r[1].toLowerCase()
      }
      return null
    }
    if (b === 'cmd' || b === 'cmd.exe') {
      const k = rest.findIndex((x) => /^\/\/?[ck]$/i.test(x.text))
      return k < 0 ? null : nested(rest.slice(k + 1), depth)
    }
    if (/^(?:ba|z|da|k)?sh(?:\.exe)?$/.test(b)) {
      const k = rest.findIndex((x) => /^-[a-z]*c[a-z]*$/i.test(x.text))
      return k < 0 || !rest[k + 1] ? null : scan(rest[k + 1].text, depth + 1)
    }
    if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(b)) {
      let k = rest.findIndex((x) => /^[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(x.text))
      if (k >= 0) return nested(rest.slice(k + 1), depth)
      if (rest.some((x) => /^[-/](?:f|file)$/i.test(x.text))) return null
      const args = []
      for (let j = 0; j < rest.length; j++) {
        if (/^-/.test(rest[j].text)) { if (VALUE_OPT.test(rest[j].text)) j++; continue }
        args.push(rest[j])
      }
      return nested(args, depth)
    }
    if (b === 'iex' || b === 'invoke-expression') return nested(rest, depth)
    return null
  }
  return null
}

function nested(ws, depth) {
  if (!ws.length || depth > 5) return null
  return checkWords(ws, depth + 1) || scan(ws.map((x) => x.text).join(' '), depth + 1)
}

// node -e "execSync('python …')" 這類：字串常值裡的子程序呼叫
const CHILD = /\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(\s*(['"`])((?:(?!\1)[\s\S])*)\1/g

function scan(cmd, depth) {
  if (depth > 5) return null
  const subs = []
  for (const ws of split(cmd, subs)) {
    const r = checkWords(ws, depth)
    if (r) return r
  }
  for (const s of subs) { const r = scan(s, depth + 1); if (r) return r }
  for (const m of cmd.matchAll(CHILD)) { const r = scan(m[2], depth + 1); if (r) return r }
  return null
}

export function findLocalPython(command) {
  return scan(String(command || ''), 0)
}

// ---- 危險指令 ----
// /f/s/q 這種連寫旗標拆成 /f /s /q（只拆整個 token 都是 /x 的情況，路徑不動）
const splitFlags = (s) => s.replace(/(^|\s)((?:\/[a-z])+)(?=\s|$)/gim, (m, p, f) => p + f.match(/\/[a-z]/gi).join(' '))
// 去掉 SQL 註解；-- 只在後面接空白或行尾時才算註解（避免吃掉 --force 這類旗標）
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--(?=\s|$).*$/gm, ' ')

const RECURSE = String.raw`-(?:r|re|rec|recu|recur|recurs|recurse)(?=\s|$|:)`
const SHELL_RISKY = [
  [/\brm\s+(?:-\w*\s+)*-[a-z]*r[a-z]*\b/i, 'rm -r'],
  [/\brm\b[^;&|\n]*\s--recursive\b/i, 'rm --recursive'],
  [/\bgit\s+push\b[^;&|\n]*\s(?:--force(?:-with-lease|-if-includes)?|-[a-z]*f[a-z]*)(?=\s|$|=)/i, 'git push --force'],
  [/\bgit\s+push\b[^;&|\n]*\s\+\S/i, 'git push +ref'],
  [/\bgit\s+reset\b[^;&|\n]*\s--hard\b/i, 'git reset --hard'],
  [/\bgit\s+clean\b[^;&|\n]*\s(?:-[a-z]*f[a-z]*|--force)(?=\s|$)/i, 'git clean -f'],
  [/\bgit\s+branch\b[^;&|\n]*\s-D\b/, 'git branch -D'],
  [/\bgit\s+branch\b[^;&|\n]*\s(?:-d|--delete)\b[^;&|\n]*\s(?:-f|--force)\b/i, 'git branch -D'],
  [/\bgit\s+checkout\s+(?:--\s+)?\.(?=\s|$|[;&|])/i, 'git checkout -- .'],
  [new RegExp(String.raw`\b(?:Remove-Item|ri|rm|del|erase|rd|rmdir)\b[^;&|\n]*\s` + RECURSE, 'i'), 'Remove-Item -Recurse'],
  [/\b(?:rd|rmdir)\b[^;&|\n]*\s\/s\b/i, 'rmdir /s'],
  [/\b(?:del|erase)\b[^;&|\n]*\s\/s\b/i, 'del /s'],
  [/\brobocopy\b[^;&|\n]*\s\/MIR\b/i, 'robocopy /MIR'],
]

// 繞寫正規化：去引號與反斜線跳脫（"rm"、r''m、r\m 在 shell 裡都是 rm）、
// 拿掉 git 的全域選項（git -C dir / -c k=v push …）、rd/s/q 這種黏在指令名後的旗標拆開。
// 只多產生一份文字一起比對，原文照樣比對，所以不會少擋。
const GIT_GLOBAL = /\bgit((?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|-P|-p))+)(?=\s)/gi
function normalizeShell(s) {
  return s
    .replace(/\\(?=[A-Za-z])/g, '')
    .replace(/(['"])([^'"\n]*?)\1/g, '$2')
    .replace(/\$\(\s*echo\s+([\w.-]+)\s*\)/gi, '$1')
    .replace(GIT_GLOBAL, 'git')
    .replace(/\b(rd|rmdir|del|erase)(\/[a-z])/gi, '$1 $2')
}
const SQL_RISKY = [
  [/\bDROP\s+(?:TABLE|DATABASE|SCHEMA|VIEW|PROCEDURE|PROC|FUNCTION|INDEX)\b/i, 'DROP'],
  [/\bTRUNCATE\s+TABLE\b/i, 'TRUNCATE TABLE'],
  [/^\s*["']?TRUNCATE\s+(?!TABLE\b)[\w\[\]."`]+\s*(?:;|$)/im, 'TRUNCATE TABLE'],
]
const TARGET = String.raw`(?!\w+:\/\/)[\w\[\].#@"'\x60]+`
const DEL_FROM = /\bDELETE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?FROM\b/i
const DEL_NOFROM_UPPER = new RegExp(String.raw`\bDELETE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?` + TARGET)
const DEL_NOFROM_START = new RegExp(String.raw`^\s*["']?DELETE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?` + TARGET, 'i')
const UPD = new RegExp(String.raw`\bUPDATE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?` + TARGET + String.raw`\s+SET\b`, 'i')

// WHERE 要在最外層才算：字串常值（SET a='WHERE'）與括號子查詢（SET a=(SELECT … WHERE …)）裡的不算
function topLevel(stmt) {
  let t = stmt.replace(/N?'(?:[^']|'')*'/g, "''")
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/\([^()]*\)/g, '()') }
  return t
}

function sqlRisky(s, out) {
  for (const [re, label] of SQL_RISKY) if (re.test(s)) out.add(label)
  for (const stmt of s.split(/;|^\s*GO\s*$/im)) {
    if (/\bWHERE\b/i.test(topLevel(stmt))) continue
    if (DEL_FROM.test(stmt) || DEL_NOFROM_UPPER.test(stmt) || DEL_NOFROM_START.test(stmt)) out.add('DELETE 沒有 WHERE')
    if (UPD.test(stmt)) out.add('UPDATE 沒有 WHERE')
  }
}

// 一筆指令命中的所有類別（同類放行時要確認沒有夾帶別類）
export function findAllRisky(text) {
  const s = String(text || '')
  const sh = splitFlags(s)
  const out = new Set()
  const shn = normalizeShell(sh)
  for (const [re, label] of SHELL_RISKY) if (re.test(sh) || re.test(shn)) out.add(label)
  // 原文與去註解版各查一次，任一命中就擋（DROP/**/TABLE、WHERE 只在註解裡）
  sqlRisky(s, out)
  sqlRisky(stripSql(s), out)
  return [...out]
}

export function findRisky(text) {
  return findAllRisky(text)[0] || null
}

// MCP 工具的參數名稱不固定，也可能包在物件／陣列裡：遞迴把所有字串值串起來檢查
export function inputText(e) {
  const out = []
  const walk = (v, d) => {
    if (d > 20 || v == null) return
    if (typeof v === 'string') out.push(v)
    else if (typeof v === 'object') for (const x of Object.values(v)) walk(x, d + 1)
  }
  for (const [k, v] of Object.entries(e)) if (k !== 'tool') walk(v, 0)
  return out.join('\n')
}

export const CONFIRM_WORD = '確認執行'

// 使用者訊息整句（去頭尾空白）剛好等於確認字才算；網頁版會在開頭自動加「【名字】」，先拿掉這一個標籤再比（20261029）
export function isConfirm(text) {
  return String(text || '').trim().replace(/^【[^【】\s]{1,20}】\s*/, '').trim() === CONFIRM_WORD
}

// 指令雜湊：工具名＋指令全文的 SHA-256（mods 環境有 crypto.subtle）
export async function commandHash(tool, text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(tool) + '\n' + String(text || '')))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}
