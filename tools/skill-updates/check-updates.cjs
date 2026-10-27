// 每週檢查第三方技能／外掛有沒有新版（2026-10-25）。只讀 GitHub 公開 API，不下載、不安裝、不叫模型。
//   node check-updates.cjs          檢查 sources.json 每個來源，有新版就貼一則到小助手私聊（同一個新版只提醒一次）
//   加 --dry 只印不貼、不記狀態；加 --force 已提醒過的也重貼。
// 安裝仍由人在對話裡說「更新技能」，照 scan-before-install 審過才裝。
// 狀態：state.json；紀錄：check-updates.log；關掉：建立同資料夾的 off 檔。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = __dirname;
const SOURCES = path.join(DIR, 'sources.json');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'check-updates.log');
const BASE = process.env.NUDGE_BASE || 'http://127.0.0.1:3001';
const ASSISTANT = 'dhc-assistant';
const PROJECT = process.env.SKILL_UPDATE_PROJECT || '00000000-0000-0000-0000-000000000000'; // Harness優化
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');

const log = (line) => { if (DRY) return console.log(`(dry) ${line}`); try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

/** Which kind of change a file is, for the reviewer: hooks and runnable code matter most. */
function kind(file) {
  if (/(^|\/)hooks?(\/|\.json$)/i.test(file)) return 'hook';
  if (/(^|\/)(package(-lock)?\.json|bun\.lock|bunfig\.toml|plugin\.json|marketplace\.json|requirements.*\.txt|pyproject\.toml)$/i.test(file)) return '設定';
  if (/\.(sh|ps1|cmd|bat|js|cjs|mjs|ts|tsx|py|awk)$/i.test(file)) return '程式';
  return '文件';
}

async function github(url) {
  const res = await fetch(`https://api.github.com${url}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tas-skill-update-check' } });
  if (!res.ok) throw new Error(`GitHub ${url} → ${res.status}`);
  return res.json();
}

function pinOf(src) {
  if (!src.clone) return src.pin;
  return execFileSync('git', ['-C', src.clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** null when nothing new under the watched paths; otherwise a summary of what changed. */
async function check(src) {
  const pin = pinOf(src);
  const cmp = await github(`/repos/${src.repo}/compare/${pin}...HEAD`);
  if (cmp.ahead_by === 0) return null;
  const files = (cmp.files ?? []).filter((f) => !src.paths?.length || src.paths.some((p) => f.filename.startsWith(p)));
  if (src.paths?.length && files.length === 0) return null;
  const head = cmp.commits?.at(-1)?.sha ?? cmp.merge_base_commit?.sha;
  const counts = {};
  for (const f of files) counts[kind(f.filename)] = (counts[kind(f.filename)] ?? 0) + 1;
  const order = { hook: 0, 設定: 1, 程式: 2 };
  const risky = files
    .filter((f) => f.status === 'added' && kind(f.filename) in order && !/(^|\/)(tests?|benchmarks?|__tests__)\/|\.test\.|(^|\/)test_/i.test(f.filename))
    .sort((a, b) => order[kind(a.filename)] - order[kind(b.filename)])
    .map((f) => f.filename);
  return { pin: pin.slice(0, 7), head: head.slice(0, 7), headSha: head, commits: cmp.ahead_by, files: files.length, truncated: (cmp.files ?? []).length >= 300, counts, risky, date: cmp.commits?.at(-1)?.commit?.committer?.date?.slice(0, 10) };
}

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.json();
};

/** Same message shape and read-modify-write as assistant-nudge.cjs postDm. */
async function postDm(text) {
  const key = `dhc.chat:dm:${[PROJECT, ASSISTANT].sort().join('~')}`;
  if (DRY) return console.log(`\n[${key}]\n${text}`);
  const msgs = (await api('GET', '/api/user/preferences'))?.preferences?.[key]?.msgs ?? [];
  const lastAt = msgs.reduce((m, x) => (x.at > m ? x.at : m), '');
  const at = new Date(Math.max(Date.now(), lastAt ? Date.parse(lastAt) + 1 : 0)).toISOString();
  const message = { id: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, by: ASSISTANT, text, at, refs: [] };
  await api('PATCH', '/api/user/preferences', { [key]: { msgs: [...msgs, message].sort((a, b) => a.at.localeCompare(b.at)).slice(-300) } });
}

async function main() {
  if (fs.existsSync(path.join(DIR, 'off'))) return log('off 檔存在，跳過');
  const { sources } = readJson(SOURCES, { sources: [] });
  const state = readJson(STATE, {});
  const lines = [];
  const errors = [];
  for (const src of sources) {
    try {
      const r = await check(src);
      if (!r) { log(`無新版 ${src.repo}`); continue; }
      log(`新版 ${src.repo} ${r.pin}..${r.head} ${r.commits} commits ${r.files} files`);
      if (!FORCE && state[src.repo] === r.headSha) continue;
      const parts = Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join('、');
      let line = `・${src.name}：${r.pin} → ${r.head}（${r.date}，${r.commits} 次提交，改 ${r.files} 檔${parts ? `：${parts}` : ''}${r.truncated ? '，檔案清單被截斷' : ''}）`;
      if (r.risky.length) line += `\n　新增要細看：${r.risky.slice(0, 6).join('、')}${r.risky.length > 6 ? ` 等 ${r.risky.length} 個` : ''}`;
      lines.push(line);
      state[src.repo] = r.headSha;
    } catch (e) {
      errors.push(`${src.name}：${e.message}`);
      log(`錯誤 ${src.repo} ${e.message}`);
    }
  }
  if (!lines.length && !errors.length) return log('本週沒有要提醒的新版');
  const text = [
    lines.length ? `技能／外掛有新版（${lines.length} 個）：` : '技能更新檢查有錯誤：',
    ...lines,
    ...(errors.length ? ['檢查失敗：', ...errors.map((e) => `・${e}`)] : []),
    lines.length ? '要升級就在 Harness優化 的對話說「更新技能」，會先掃描再裝。' : '',
  ].filter(Boolean).join('\n');
  await postDm(text);
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  log(`已貼私聊 ${lines.length} 個新版 ${errors.length} 個錯誤`);
}

main().catch((e) => { log(`失敗 ${e.stack || e.message}`); process.exitCode = 1; });
