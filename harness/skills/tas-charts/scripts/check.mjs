// 交付前檢查。用法：node check.mjs <成品.html> [--render] [--shot 截圖.png]
// 靜態：沒有外部資源、chartkit 已內嵌、只呼叫一次 CK.use、script 語法正確、卡片有標題/副標/來源、標題不是圖型名。
// --render：用本機 Edge/Chrome 無頭開啟，讀 body 的 data-ck-charts / data-ck-errors，確認每張圖都畫出來。
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !a.endsWith('.png'));
const render = args.includes('--render');
const shot = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;
if (!file) { console.error('用法：node check.mjs <成品.html> [--render] [--shot 截圖.png]'); process.exit(2); }
const html = readFileSync(file, 'utf8');
const fail = [], warn = [];
// 頁面自己的程式（扣掉內嵌的 chartkit），計算呼叫次數用
const pageJs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(js => !/root\.CK\s*=\s*CK/.test(js)).join('\n');

// 1. 外部資源（SVG 命名空間字串不算）
const ext = [...html.matchAll(/(?:src|href)\s*=\s*["']\s*(https?:|\/\/)[^"']*|@import[^;]*|url\(\s*["']?(?:https?:|\/\/)[^)]*\)|fetch\(\s*["']https?:[^"']*/gi)].map(m => m[0]);
if (ext.length) fail.push('引用外部資源（內網打不開）：' + ext.slice(0, 5).join(' | '));
// 2. chartkit 內嵌
if (html.includes('/*CHARTKIT*/')) fail.push('還沒打包：先跑 build.mjs 把 chartkit 內嵌');
if (!/root\.CK\s*=\s*CK/.test(html)) fail.push('找不到內嵌的 chartkit');
// 3. 色系只鎖一次
const uses = [...pageJs.matchAll(/CK\.use\(/g)].length;
if (uses !== 1) fail.push(`CK.use 要剛好呼叫一次，現在 ${uses} 次`);
// 4. script 語法
[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) => {
  try { new vm.Script(m[1], { filename: `script#${i}` }); } catch (e) { fail.push(`script#${i} 語法錯誤：${e.message}`); }
});
// 5. 卡片四件套與標題
const cards = [...html.matchAll(/<div class="ck-card[^"]*"[^>]*>([\s\S]*?)<div class="ck-src"/g)];
const cardOpen = (html.match(/<div class="ck-card/g) || []).length;
if (cards.length !== cardOpen) fail.push(`有 ${cardOpen - cards.length} 張卡片缺來源行 .ck-src`);
const typeWords = /^(長條圖|直條圖|橫條圖|折線圖|面積圖|圓餅圖|圓環圖|散佈圖|散點圖|熱力圖|瀑布圖|堆疊圖|bar chart|line chart|pie chart|chart)$/i;
cards.forEach((c, i) => {
  const h2 = (c[1].match(/<h2>([\s\S]*?)<\/h2>/) || [])[1];
  if (!h2) fail.push(`第 ${i + 1} 張卡片沒有 <h2> 標題`);
  else if (typeWords.test(h2.trim())) fail.push(`第 ${i + 1} 張卡片標題只寫圖型名「${h2.trim()}」，要寫結論`);
  if (!/class="ck-sub"/.test(c[1])) fail.push(`第 ${i + 1} 張卡片沒有副標 .ck-sub（單位、期間、圖例說明）`);
});
if (/\{\{[^}]+\}\}/.test(html)) fail.push('還有沒替換的 {{佔位}}：' + html.match(/\{\{[^}]+\}\}/)[0]);
if (/示意資料|CK\.demo\b/.test(pageJs + html.replace(/<script>[\s\S]*?<\/script>/g, ''))) warn.push('含示意資料（CK.demo 或「示意資料」字樣）；正式交付前換成真數字');

// 6. 實際渲染
function browser() {
  const c = [process.env.CK_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return c.find(p => p && existsSync(p));
}
if (render || shot) {
  const exe = browser();
  if (!exe) fail.push('找不到 Edge/Chrome，無法渲染驗收（可設 CK_BROWSER 指到瀏覽器）');
  else {
    const prof = mkdtempSync(join(tmpdir(), 'ck-'));
    const base = ['--headless=new', '--disable-gpu', '--no-first-run', '--force-prefers-reduced-motion', `--user-data-dir=${prof}`, '--virtual-time-budget=4000'];
    const url = pathToFileURL(resolve(file)).href;
    try {
      const dom = execFileSync(exe, [...base, '--dump-dom', url], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 });
      const body = dom.match(/<body[^>]*>/) ? dom.match(/<body[^>]*>/)[0] : '';
      const n = +((body.match(/data-ck-charts="(\d+)"/) || [])[1] ?? -1), e = +((body.match(/data-ck-errors="(\d+)"/) || [])[1] ?? -1);
      const calls = [...pageJs.matchAll(/CK\.(bar|hbar|diverging|line|area|stacked|dumbbell|waterfall|heatmap|scatter|waffle|limits|kpi|status|table)\(/g)].length;
      if (n < 0) fail.push('渲染後找不到 data-ck-charts：chartkit 沒跑起來（看瀏覽器主控台）');
      else {
        if (e > 0) fail.push(`渲染時有 ${e} 個錯誤：` + [...dom.replace(/<script>[\s\S]*?<\/script>/g, '').matchAll(/<div class="ck-err">([\s\S]*?)<\/div>/g)].map(m => m[1]).join(' | '));
        if (n < calls) fail.push(`只畫出 ${n} 個元件，頁面裡呼叫了 ${calls} 次`);
        console.log(`渲染：${n} 個元件、${e} 個錯誤、色系 ${(body.match(/data-ck-palette="([^"]*)"/) || [])[1]}`);
      }
      if (shot) {
        execFileSync(exe, [...base, `--screenshot=${resolve(shot)}`, '--window-size=1200,' + (args.includes('--tall') ? 6000 : 2400), '--hide-scrollbars', url], { timeout: 60000, stdio: 'ignore' });
        console.log(existsSync(shot) ? `截圖：${shot}` : '截圖失敗');
      }
    } catch (err) { fail.push('瀏覽器執行失敗：' + err.message.split('\n')[0]); }
    try { rmSync(prof, { recursive: true, force: true }); } catch { /* Edge 有時還鎖著暫存設定檔，留著無害 */ }
  }
}

warn.forEach(w => console.log('注意：' + w));
if (fail.length) { fail.forEach(f => console.log('✗ ' + f)); process.exit(1); }
console.log(`✓ ${file} 通過（${cards.length} 張卡片）`);
