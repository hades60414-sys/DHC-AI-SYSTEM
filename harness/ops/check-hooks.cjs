// 健康檢查用：settings.json 裡每條 `node "<路徑>"` hook 指令指到的檔案都要存在。
// repo 搬家或刪掉後，tools/ 底下就地執行的 hook（提示詞注入警示、對話搜尋）會 MODULE_NOT_FOUND，
// Claude Code 把它當非阻擋錯誤略過，守門就這樣靜默失效；這支把它變成看得到的 FAIL。
//   node check-hooks.cjs        （讀 $CLAUDE_CONFIG_DIR 或 ~/.claude 的 settings.json）
const fs = require('fs'), os = require('os'), path = require('path');
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const file = path.join(dir, 'settings.json');
let s;
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
  console.log(fs.existsSync(file) ? `FAIL: ${file} 不是有效的 JSON（${e.message}）` : `INFO: ${file} 不存在，略過 hook 檢查`);
  process.exit(fs.existsSync(file) ? 1 : 0);
}
const seen = new Set(), missing = [];
for (const groups of Object.values(s.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) {
  for (const m of String(h.command || '').matchAll(/\bnode(?:\.exe)?\s+"([^"]+\.(?:c?js|mjs))"/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    if (!fs.existsSync(m[1])) missing.push(m[1]);
  }
}
for (const p of missing) console.log(`FAIL: hook 指到不存在的檔案 ${p}（repo 搬家後請在新位置重跑 install-hooks.cjs）`);
if (!missing.length) console.log(`OK hooks: ${seen.size} 個 hook 檔案都在`);
process.exit(missing.length ? 1 : 0);
