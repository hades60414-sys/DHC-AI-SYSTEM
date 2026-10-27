// 把頁面裡的 <script>/*CHARTKIT*/</script> 換成 chartkit.js 全文，產出可單檔分享的 HTML。
// 用法：node build.mjs <草稿.html> <成品.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('用法：node build.mjs <草稿.html> <成品.html>'); process.exit(2); }
const kit = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'chartkit.js'), 'utf8');
const html = readFileSync(src, 'utf8');
const marker = '<script>/*CHARTKIT*/</script>';
const hits = html.split(marker).length - 1;
if (hits !== 1) { console.error(`草稿裡要剛好一個 ${marker}，現在有 ${hits} 個`); process.exit(1); }
writeFileSync(out, html.replace(marker, () => `<script>\n${kit}\n</script>`), 'utf8');
console.log(`已輸出 ${out}（${Math.round(readFileSync(out).length / 1024)} KB）`);
