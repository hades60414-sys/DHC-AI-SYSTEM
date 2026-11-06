// ASTRA-011：真瀏覽器 E2E（Playwright Chromium headless shell），對「實際企業 image＋PostgreSQL」部署操作 /office。
// 用法：DHC_E2E_PASSWORD=… node tests/enterprise/e2e/office_e2e.mjs <base-url> <org-slug> <輸出目錄>
// 只用合成帳號與 fixture；密碼只從環境變數讀取。輸出 RESULT.json（每步驟、console／CSP 錯誤、下載檔 SHA-256）與失敗時截圖。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const [base, slug, outDir] = process.argv.slice(2);
const password = process.env.DHC_E2E_PASSWORD;
if (!base || !slug || !outDir || !password) { console.error('usage: DHC_E2E_PASSWORD=… office_e2e.mjs <base-url> <org-slug> <out-dir>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pdf = path.join(root, 'server/modules/enterprise-persistence/tests/fixtures/extraction/text-cjk.pdf');
const accounting = path.join(root, 'docs/enterprise/scenarios/會計對帳');
const steps = [];
const consoleErrors = [];
const externalFailures = [];
let status = 'PASS';
let failure = null;

const browser = await chromium.launch({ headless: true });
async function session(email) {
  const context = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW' });
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ email, text: message.text().slice(0, 300) }); });
  page.on('pageerror', error => consoleErrors.push({ email, text: `pageerror: ${String(error).slice(0, 300)}` }));
  page.on('requestfailed', request => consoleErrors.push({ email, text: `requestfailed: ${request.url().slice(0, 200)} ${request.failure()?.errorText ?? ''}` }));
  await page.goto(`${base}/office`);
  await page.getByLabel('組織代碼').fill(slug);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('密碼').fill(password);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByRole('navigation', { name: '主要功能' }).waitFor();
  return { context, page };
}
async function step(name, action) {
  const started = Date.now();
  await action();
  steps.push({ name, ms: Date.now() - started, pass: true });
}

let staff;
try {
  let headers;
  await step('CSP 與安全標頭存在於 /office', async () => {
    const response = await fetch(`${base}/office`);
    headers = Object.fromEntries(response.headers);
    if (!/script-src 'self'/.test(headers['content-security-policy'] ?? '') || headers['x-frame-options'] !== 'DENY') throw new Error(`headers ${JSON.stringify(headers)}`);
  });
  staff = await session('staff@synthetic-co.example.invalid');
  const page = staff.page;
  await step('上傳 PDF（文字層）→ 可檢索', async () => {
    await page.getByLabel('標題').fill('E2E 採購合約');
    await page.getByLabel('選擇檔案').setInputFiles(pdf);
    await page.getByRole('button', { name: '上傳', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '可檢索' }).waitFor({ timeout: 60_000 });
  });
  await step('檢索 PDF 內容並顯示頁碼位置；驗證引用原文相符', async () => {
    await page.getByRole('button', { name: '檢索與引用', exact: true }).click();
    await page.getByLabel('查詢').fill('採購合約');
    await page.getByRole('button', { name: '檢索', exact: true }).click();
    await page.getByText(/第 1 頁第 \d+ 行/).first().waitFor();
    await page.getByRole('button', { name: '驗證引用', exact: true }).first().click();
    await page.getByText('原文相符').first().waitFor();
  });
  await step('建立 AI 草稿（離線 mock）→ 完成且引用有效', async () => {
    await page.getByRole('button', { name: 'AI 草稿', exact: true }).click();
    await page.getByLabel('標題').fill('E2E 合約摘要');
    await page.getByLabel('需求與關鍵詞').fill('採購合約');
    await page.getByLabel('模型').selectOption('offline');
    await page.getByRole('button', { name: '產生草稿', exact: true }).click();
    await page.getByRole('button', { name: /E2E 合約摘要/ }).first().waitFor({ timeout: 60_000 });
    for (let i = 0; i < 30; i += 1) {
      await page.getByRole('button', { name: /E2E 合約摘要/ }).first().click();
      if (await page.getByText('引用有效').count()) break;
      await page.waitForTimeout(1000);
    }
    await page.getByText('引用有效').waitFor();
  });
  await step('送審', async () => {
    await page.getByRole('button', { name: '送審', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已送審' }).waitFor();
  });
  const approver = await session('approver@synthetic-co.example.invalid');
  await step('審核者核准（另一個瀏覽器 context）', async () => {
    await approver.page.getByRole('button', { name: '審批', exact: true }).click();
    await approver.page.getByRole('button', { name: /E2E 合約摘要/ }).click();
    await approver.page.getByText('引用有效').waitFor();
    // ASTRA-V3-NEW-001：審核畫面顯示 approval 綁定的版號與內容 hash
    const bound = await approver.page.getByTestId('approval-revision').textContent();
    if (!/審核第 1 版（內容 SHA-256 [0-9a-f]{12}…）/.test(bound ?? '')) throw new Error(`approval revision label: ${bound}`);
    await approver.page.getByRole('button', { name: '核准', exact: true }).click();
    await approver.page.getByRole('status').filter({ hasText: '已核准' }).waitFor();
  });
  await approver.context.close();
  await step('申請者匯出 Word；下載檔為有效 DOCX（ZIP 簽章）並記錄 SHA-256', async () => {
    // 審核在另一個瀏覽器完成；申請者重新整理頁面（session 在 sessionStorage，仍保持登入）才會看到「已核准」
    await page.reload();
    await page.getByRole('navigation', { name: '主要功能' }).waitFor();
    await page.getByRole('button', { name: 'AI 草稿', exact: true }).click();
    await page.getByRole('button', { name: /E2E 合約摘要/ }).first().click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '匯出 Word', exact: true }).click()]);
    const file = path.join(outDir, 'export.docx');
    await download.saveAs(file);
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 2).toString() !== 'PK') throw new Error('not a zip/docx');
    steps.at(-1).sha256 = undefined;
    writeFileSync(path.join(outDir, 'export.sha256'), `${createHash('sha256').update(bytes).digest('hex')}  export.docx\n`);
  });
  await step('W6-B 對帳：上傳兩份合成 CSV → ACC-MATCH-v1 → 9 案件、缺漏顯示「—」、來源列可見', async () => {
    await page.getByRole('button', { name: '文件', exact: true }).click();
    for (const [title, file] of [['E2E 合成內部帳', '合成內部帳.csv'], ['E2E 合成收款明細', '合成收款明細.csv']]) {
      await page.getByLabel('標題').fill(title);
      await page.getByLabel('選擇檔案').setInputFiles(path.join(accounting, file));
      await page.getByRole('button', { name: '上傳', exact: true }).click();
      await page.getByRole('status').filter({ hasText: file }).waitFor({ timeout: 60_000 });
    }
    await page.getByRole('button', { name: '對帳', exact: true }).click();
    await page.getByLabel('內部帳 CSV').selectOption({ label: 'E2E 合成內部帳' });
    await page.getByLabel('收款明細 CSV').selectOption({ label: 'E2E 合成收款明細' });
    await page.getByLabel('期間起').fill('2026-10-01');
    await page.getByLabel('期間迄').fill('2026-10-28');
    await page.getByRole('button', { name: '執行對帳', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '對帳完成' }).waitFor();
    const table = page.getByRole('table', { name: '對帳案件' });
    await table.waitFor();
    const rows = await table.locator('tbody tr').count();
    if (rows !== 9) throw new Error(`cases ${rows}`);
    for (const label of ['缺收款明細', '缺內部單據', '金額差異', '幣別不一致', '單據ID重複（隔離）', '收款ID重複（隔離）']) await table.getByText(label, { exact: true }).waitFor();
    await table.getByText('-50.00 TWD', { exact: true }).waitFor();
    await table.getByText(/內部帳第4行 I003/).waitFor();
  });
  await step('沒有 CSP 違規、同源請求失敗或頁面錯誤（外部資源失敗另列，不算產品錯誤但列為發現）', async () => {
    const external = item => /requestfailed: https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(item.text);
    const externalUrls = new Set(consoleErrors.filter(external).map(item => item.text));
    // Chromium 對同一個失敗請求也會印一行不含網址的 "Failed to load resource"；只有在外部失敗數量足以對應時才視為同一事件
    let unlabeled = consoleErrors.filter(item => item.text.startsWith('Failed to load resource')).length;
    const relevant = consoleErrors.filter(item => {
      if (external(item) || /favicon/.test(item.text)) return false;
      if (item.text.startsWith('Failed to load resource') && unlabeled > 0 && unlabeled <= consoleErrors.filter(external).length) { return false; }
      return true;
    });
    externalFailures.push(...externalUrls);
    if (relevant.length || consoleErrors.some(item => /Content Security Policy|Refused to/i.test(item.text))) throw new Error(JSON.stringify(relevant).slice(0, 600));
  });
} catch (error) {
  status = 'FAIL';
  failure = String(error).slice(0, 800);
  steps.push({ name: 'FAILED', pass: false, error: failure });
  if (staff) await staff.page.screenshot({ path: path.join(outDir, 'failure.png'), fullPage: true }).catch(() => undefined);
} finally {
  await browser.close();
  writeFileSync(path.join(outDir, 'RESULT.json'), `${JSON.stringify({ status, failure, base, browser: 'chromium-headless-shell (playwright-core 1.64.1)', steps, consoleErrors, externalFailures, finding: externalFailures.length ? 'Office 頁面依賴 Google Fonts（外部網路）；離線環境會載入失敗且會向 Google 透露用戶端 IP，建議自行託管字型' : null }, null, 1)}\n`);
  console.log(JSON.stringify({ status, failure, steps: steps.length }));
}
process.exit(status === 'PASS' ? 0 : 1);
