// cdp.cjs <動作> [參數]：連 9333 的 NotebookLM Edge。動作：shot | goto <url> | text | click <文字> | fill <selector> <值> | eval <js>
const { chromium } = require('C:/Users/demo/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
(async () => {
  const [act, a1, a2] = process.argv.slice(2);
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  let page = ctx.pages().find(p => /google\.com/.test(p.url())) || ctx.pages().find(p => p.url().startsWith('http')) || await ctx.newPage();
  await page.bringToFront();
  if (act === 'goto') await page.goto(a1, { waitUntil: 'domcontentloaded' });
  if (act === 'click') await page.getByText(a1, { exact: false }).first().click();
  if (act === 'label') await page.locator('[aria-label="' + a1 + '"]').first().click();
  if (act === 'btn') await page.locator('button:visible', { hasText: a1 }).last().click();
  if (act === 'type') await page.keyboard.type(a1);
  if (act === 'press') await page.keyboard.press(a1);
  if (act === 'fill') await page.fill(a1, a2);
  if (act === 'eval') console.log(JSON.stringify(await page.evaluate(a1)));
  await page.waitForTimeout(2000);
  const f = 'D:/TAS/ai-tools/nblm/out/shot.png';
  await page.screenshot({ path: f });
  console.log(JSON.stringify({ url: page.url(), title: await page.title(), shot: f }));
  if (act === 'text') console.log((await page.innerText('body')).slice(0, 4000));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
