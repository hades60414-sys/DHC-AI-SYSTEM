// V5.3 WP1（ASTRA-ROLL-002 runtime 證據）：真 Chromium＋實際 image＋PostgreSQL，驗證切換資源（A→B）時不會把 A 的內容寫進 B。
// 用法：DHC_E2E_PASSWORD=… node tests/enterprise/e2e/office_stale_e2e.mjs <base-url> <org-slug> <輸出目錄>
// 前置：組織已 bootstrap，管理員 admin@<slug>.example.invalid，訂閱 active。本程式以 API 建立合成成員、文件、草稿與審批（只用合成資料）。
// 不在第一個問題就停：逐情境記錄 violations；切換後若「儲存修改／送審／核准」仍可按，就實際按下（這正是舊版的攻擊路徑）。
// 輸出 RESULT.json：情境、violations、所有 PUT／POST（url＋body）、建立的 id（供 harness 以 psql 交叉核對 PostgreSQL）。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

const [base, slug, outDir] = process.argv.slice(2);
const password = process.env.DHC_E2E_PASSWORD;
if (!base || !slug || !outDir || !password) { console.error('usage: DHC_E2E_PASSWORD=… office_stale_e2e.mjs <base-url> <org-slug> <out-dir>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const API = `${base}/api/enterprise/v1`;
const scenarios = [];
const violations = [];
const writes = [];
const ids = {};
let fatal = null;

async function api(token, method, route, body, headers = {}) {
  const response = await fetch(API + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (response.status >= 400) throw new Error(`${method} ${route} → ${response.status} ${text.slice(0, 200)}`);
  return data;
}
const login = async email => (await api(null, 'POST', '/auth/login', { organizationSlug: slug, email, password })).token;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function seed() {
  const admin = await login(`admin@${slug}.example.invalid`);
  for (const [email, role] of [[`staff@${slug}.example.invalid`, 'employee'], [`approver@${slug}.example.invalid`, 'approver']]) {
    await api(admin, 'POST', '/members', { email, password, roles: [role] });
  }
  await api(admin, 'PUT', '/models/providers', { key: 'offline', kind: 'mock', deployment: 'LOCAL_ONLY', monthlyBudgetMicros: 0 });
  const staff = await login(`staff@${slug}.example.invalid`);
  // 兩份不同內容（不同 source hash）的合成來源
  const docs = {};
  for (const [key, text] of [['甲', '合成來源甲 交付期限 2026/12/31 甲方承擔運費'], ['乙', '合成來源乙 預算上限 88,000 乙方負責驗收'], ['丙', '合成來源丙 共同條款 保密期間三年']]) {
    const created = await api(staff, 'POST', '/documents', new TextEncoder().encode(text), { 'content-type': 'text/plain', 'x-dhc-title': encodeURIComponent(`來源${key}`), 'x-dhc-filename': encodeURIComponent(`src-${key}.txt`) });
    docs[key] = created.document?.id ?? created.id;
  }
  const draft = async (title, query, key) => {
    const run = (await api(staff, 'POST', '/runs/draft-generation', { title, query, providerKey: 'offline' }, { 'idempotency-key': `stale-${key}-${Date.now()}` })).run;
    for (let i = 0; i < 90; i += 1) {
      const state = await api(staff, 'GET', `/runs/${run.id}`);
      if (!['queued', 'running'].includes(state.status)) {
        if (state.status !== 'succeeded') throw new Error(`run ${title} ${state.status} ${state.errorCode}`);
        return state.draftId;
      }
      await sleep(1000);
    }
    throw new Error(`run ${title} timeout`);
  };
  ids.draftA = await draft('甲稿', '交付期限', 'a');
  ids.draftB = await draft('乙稿', '預算上限', 'b');
  ids.draftDiff = await draft('丁稿（不同版號）', '交付期限', 'd');
  // 不同 revision：丁稿改成第 2 版（甲／乙維持同作者同為第 1 版）
  const diff = await api(staff, 'GET', `/drafts/${ids.draftDiff}`);
  await api(staff, 'PUT', `/drafts/${ids.draftDiff}`, { expectedRevision: diff.revision.revision, body: `${diff.revision.body}\n（人工補充第 2 版）` });
  // 相同內容、不同 approval：兩份以相同查詢產生的草稿送審
  ids.draftC = await draft('審核C', '保密期間', 'c');
  ids.draftD = await draft('審核D', '保密期間', 'e');
  for (const key of ['draftC', 'draftD']) {
    const detail = await api(staff, 'GET', `/drafts/${ids[key]}`);
    const approval = await api(staff, 'POST', `/drafts/${ids[key]}/submit`, { expectedRevision: detail.revision.revision });
    ids[key.replace('draft', 'approval')] = approval.approvalId;
  }
  const details = {};
  for (const key of ['draftA', 'draftB', 'draftDiff', 'draftC', 'draftD']) details[key] = await api(staff, 'GET', `/drafts/${ids[key]}`);
  const approver = await login(`approver@${slug}.example.invalid`);
  const approvalC = await api(approver, 'GET', `/approvals/${ids.approvalC}`);
  const approvalD = await api(approver, 'GET', `/approvals/${ids.approvalD}`);
  return {
    bodies: Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value.revision.body])),
    revisions: Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value.revision.revision])),
    citationHashes: Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value.revision.citations.map(item => item.excerptSha256)])),
    approvals: { C: { revision: approvalC.approval.revision, sha: approvalC.approval.revisionSha256 }, D: { revision: approvalD.approval.revision, sha: approvalD.approval.revisionSha256 } },
  };
}

const browser = await chromium.launch({ headless: true });
async function session(email) {
  const context = await browser.newContext({ locale: 'zh-TW' });
  const page = await context.newPage();
  page.on('request', request => {
    if (['PUT', 'POST'].includes(request.method()) && request.url().includes('/api/enterprise/v1/') && !request.url().endsWith('/auth/login')) {
      writes.push({ who: email, method: request.method(), url: request.url().replace(base, ''), body: request.postData() ?? '' });
    }
  });
  await page.goto(`${base}/office`);
  await page.getByLabel('組織代碼').fill(slug);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('密碼').fill(password);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByRole('navigation', { name: '主要功能' }).waitFor();
  return { context, page };
}
const resourcePath = (kind, id) => url => url.pathname.endsWith(`/api/enterprise/v1/${kind}/${id}`);
async function textareaValues(page) { return page.locator('textarea').evaluateAll(nodes => nodes.map(node => node.value)); }
async function clickIfEnabled(page, name) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.count())) return 'absent';
  if (await button.first().isDisabled()) return 'disabled';
  await button.first().click();
  await sleep(800);
  return 'clicked';
}

async function draftScenario(page, seeded, name, fromKey, toKey, mode) {
  const to = ids[toKey];
  const fromBody = seeded.bodies[fromKey];
  const record = { name, mode, from: fromKey, to: toKey, attempts: {}, shownFromBodyUnderTo: false };
  await page.getByRole('button', { name: 'AI 草稿', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(fromKey === 'draftA' ? '甲稿' : fromKey === 'draftB' ? '乙稿' : '丁稿') }).first().click();
  await page.locator('textarea').first().waitFor();
  if (!(await textareaValues(page)).includes(fromBody)) throw new Error(`${name}: 來源草稿內容未載入`);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (mode === '503') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ENTERPRISE_INTERNAL', message: '暫時無法使用' } }) });
    await gate;
    return route.continue();
  };
  await page.route(resourcePath('drafts', to), handler);
  const before = writes.length;
  await page.getByRole('button', { name: new RegExp(toKey === 'draftA' ? '甲稿' : toKey === 'draftB' ? '乙稿' : '丁稿') }).first().click();
  await sleep(1500);
  record.shownFromBodyUnderTo = (await textareaValues(page)).includes(fromBody);
  if (record.shownFromBodyUnderTo) violations.push({ scenario: name, code: 'FROM_BODY_SHOWN_UNDER_TO' });
  for (const button of ['儲存修改', '送審']) record.attempts[button] = await clickIfEnabled(page, button);
  const wrong = writes.slice(before).filter(item => item.url.includes(`/drafts/${to}`));
  record.writesToTarget = wrong;
  for (const item of wrong) {
    violations.push({ scenario: name, code: item.body.includes(JSON.stringify(fromBody).slice(1, -1)) ? 'WROTE_FROM_BODY_TO_TARGET' : 'WROTE_TO_TARGET_WHILE_NOT_READY', url: item.url });
  }
  release?.();
  await sleep(500);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  scenarios.push(record);
}

async function approvalScenario(approverPage, seeded) {
  const record = { name: '審批：C 已載入、D 回 503（相同內容、不同 approval）', attempts: {} };
  await approverPage.getByRole('button', { name: '審批', exact: true }).click();
  await approverPage.getByRole('button', { name: /審核C/ }).first().click();
  await approverPage.getByTestId('approval-revision').waitFor();
  await approverPage.route(resourcePath('approvals', ids.approvalD), route => (route.request().method() !== 'GET' ? route.continue()
    : route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ENTERPRISE_INTERNAL' } }) })));
  const before = writes.length;
  await approverPage.getByRole('button', { name: /審核D/ }).first().click();
  await sleep(1500);
  record.labelUnderD = await approverPage.getByTestId('approval-revision').count() ? await approverPage.getByTestId('approval-revision').textContent() : null;
  for (const button of ['核准', '退回']) record.attempts[button] = await clickIfEnabled(approverPage, button);
  const decisions = writes.slice(before).filter(item => /\/approvals\/[^/]+\/decision$/.test(item.url));
  record.decisionsWhileNotReady = decisions;
  for (const item of decisions) violations.push({ scenario: record.name, code: 'DECISION_WHILE_NOT_READY', url: item.url, body: item.body });
  await approverPage.unrouteAll({ behavior: 'ignoreErrors' });
  scenarios.push(record);

  // 正向：D 正常載入後核准，送出的 id／版號／hash 必須是 D 自己的
  const positive = { name: '審批正向：D 正常載入後核准' };
  await approverPage.getByRole('button', { name: /審核C/ }).first().click();
  await approverPage.getByTestId('approval-revision').waitFor();
  await approverPage.getByRole('button', { name: /審核D/ }).first().click();
  await approverPage.getByTestId('approval-revision').waitFor();
  const start = writes.length;
  await approverPage.getByRole('button', { name: '核准', exact: true }).click();
  await approverPage.getByRole('status').filter({ hasText: '已核准' }).waitFor();
  const sent = writes.slice(start).find(item => /\/decision$/.test(item.url));
  positive.sent = sent;
  const body = sent ? JSON.parse(sent.body) : null;
  positive.ok = Boolean(sent && sent.url.endsWith(`/approvals/${ids.approvalD}/decision`) && body.expectedRevision === seeded.approvals.D.revision && body.expectedSha256 === seeded.approvals.D.sha);
  if (!positive.ok) violations.push({ scenario: positive.name, code: 'POSITIVE_DECISION_MISMATCH', sent });
  scenarios.push(positive);
}

let seeded;
try {
  seeded = await seed();
  const staff = await session(`staff@${slug}.example.invalid`);
  await draftScenario(staff.page, seeded, '草稿：A 已載入、B GET 延遲（同作者同版號）', 'draftA', 'draftB', 'pending');
  await draftScenario(staff.page, seeded, '草稿：A 已載入、B GET 503（同作者同版號）', 'draftA', 'draftB', '503');
  await draftScenario(staff.page, seeded, '草稿：A 已載入、丁 GET 503（不同版號）', 'draftA', 'draftDiff', '503');
  // 正向：B 正常載入後合法修改並儲存，PUT 只帶 B 的版號與新內容
  const positive = { name: '草稿正向：B 正常載入後儲存' };
  await staff.page.getByRole('button', { name: /乙稿/ }).first().click();
  const area = staff.page.locator('textarea').first();
  await area.waitFor();
  for (let i = 0; i < 20 && !(await textareaValues(staff.page)).includes(seeded.bodies.draftB); i += 1) await sleep(300);
  const edited = `${seeded.bodies.draftB}\n（E2E 合法修改）`;
  await area.fill(edited);
  const start = writes.length;
  await staff.page.getByRole('button', { name: '儲存修改', exact: true }).click();
  await staff.page.getByRole('status').filter({ hasText: '已儲存修改' }).waitFor();
  const sent = writes.slice(start).find(item => item.url.endsWith(`/drafts/${ids.draftB}`));
  positive.ok = Boolean(sent && JSON.parse(sent.body).expectedRevision === seeded.revisions.draftB && JSON.parse(sent.body).body === edited);
  positive.sent = sent;
  if (!positive.ok) violations.push({ scenario: positive.name, code: 'POSITIVE_SAVE_MISMATCH', sent });
  scenarios.push(positive);
  ids.editedBodyB = edited;
  await staff.context.close();
  const approver = await session(`approver@${slug}.example.invalid`);
  await approvalScenario(approver.page, seeded);
  await approver.context.close();
} catch (error) {
  fatal = String(error).slice(0, 800);
} finally {
  await browser.close();
  const status = fatal ? 'ERROR' : violations.length ? 'VIOLATIONS' : 'PASS';
  writeFileSync(path.join(outDir, 'RESULT.json'), `${JSON.stringify({ status, fatal, base, ids, seeded, scenarios, violations, writes }, null, 1)}\n`);
  console.log(JSON.stringify({ status, fatal, violations: violations.length, scenarios: scenarios.length }));
  process.exit(status === 'PASS' ? 0 : status === 'VIOLATIONS' ? 3 : 1);
}
