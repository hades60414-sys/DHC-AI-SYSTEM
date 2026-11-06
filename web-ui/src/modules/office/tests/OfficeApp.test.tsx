import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { OfficeApp } from '@/modules/office';

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown };
let handler: Handler;
const calls: Array<{ url: string; init: RequestInit }> = [];

const json = (status: number, body?: unknown) => ({ status, body });
const employee = { organizationId: 'o', memberId: 'm', email: 'staff@example.invalid', roles: ['employee'], permissions: ['documents.read', 'documents.write', 'tasks.read', 'tasks.write'], expiresAt: '2099-01-01T00:00:00Z' };
const admin = { ...employee, email: 'admin@example.invalid', roles: ['org_admin'], permissions: [...employee.permissions, 'members.read', 'members.manage', 'audit.read', 'models.manage', 'billing.read', 'approvals.decide'] };

beforeEach(() => {
  sessionStorage.clear();
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function login(identity: typeof employee) {
  handler = (url, init) => {
    if (url.endsWith('/auth/login')) {
      const body = JSON.parse(String(init.body));
      return body.password === 'correct-password-1' ? json(200, { token: 'dhcs1.tok', expiresAt: '2099-01-01T00:00:00Z' }) : json(401, { error: { code: 'ENTERPRISE_INVALID_CREDENTIALS' } });
    }
    if (url.endsWith('/identity/me')) return json(200, identity);
    if (url.includes('/documents?')) return json(200, { items: [], nextCursor: null });
    return json(200, { items: [] });
  };
  render(<OfficeApp />);
  fireEvent.change(screen.getByLabelText('組織代碼'), { target: { value: 'alpha' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: identity.email } });
  fireEvent.change(screen.getByLabelText('密碼'), { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: '登入' }));
  expect((await screen.findByRole('alert')).textContent).toContain('組織代碼、Email 或密碼不正確');
  fireEvent.change(screen.getByLabelText('密碼'), { target: { value: 'correct-password-1' } });
  fireEvent.click(screen.getByRole('button', { name: '登入' }));
  await screen.findByRole('navigation', { name: '主要功能' });
}

describe('OfficeApp', () => {
  it('未登入顯示登入頁；登入錯誤以中文提示；員工只看到有權限的分頁', async () => {
    await login(employee);
    const nav = screen.getByRole('navigation', { name: '主要功能' });
    expect((nav).textContent).toContain('文件');
    expect((nav).textContent).toContain('AI 草稿');
    expect(nav.textContent).not.toContain('成員');
    expect(nav.textContent).not.toContain('稽核紀錄');
    expect(nav.textContent).not.toContain('審批');
    expect(await screen.findByText('尚未上傳文件')).toBeTruthy();
  });

  it('管理員看到管理分頁；token 只放在 Authorization header、不出現在 URL', async () => {
    await login(admin);
    expect((screen.getByRole('navigation', { name: '主要功能' })).textContent).toContain('成員');
    const authorized = calls.filter(call => (call.init.headers as Record<string, string> | undefined)?.authorization === 'Bearer dhcs1.tok');
    expect(authorized.length).toBeGreaterThan(0);
    expect(calls.every(call => !call.url.includes('dhcs1.tok'))).toBe(true);
  });

  it('任何請求回 401 即清除 session 並回到登入頁', async () => {
    await login(employee);
    handler = () => json(401, { error: { code: 'ENTERPRISE_AUTH_REQUIRED' } });
    fireEvent.click(screen.getByRole('button', { name: '檢索與引用' }));
    fireEvent.change(screen.getByLabelText('查詢'), { target: { value: '期限' } });
    fireEvent.click(screen.getByRole('button', { name: '檢索' }));
    expect(await screen.findByRole('form', { name: '登入表單' })).toBeTruthy();
    expect(sessionStorage.getItem('dhc-office-session')).toBeNull();
  });

  it('載入失敗顯示錯誤與重試；重試成功後顯示資料', async () => {
    await login(employee);
    let fail = true;
    handler = url => (url.includes('/documents?') ? (fail ? json(500, { error: { code: 'ENTERPRISE_INTERNAL', message: '伺服器發生錯誤' } }) : json(200, { items: [{ id: 'd1', title: '週報', classification: 'internal', createdAt: '2026-11-05T00:00:00Z' }], nextCursor: null })) : json(200, { items: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'AI 草稿' }));
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    const retry = await screen.findByRole('button', { name: '重試' });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('週報')).toBeTruthy();
  });

  it('檢索結果顯示來源版本與位置，驗證引用顯示結果', async () => {
    await login(employee);
    handler = url => {
      if (url.includes('/documents/search')) {
        return json(200, { items: [{ excerpt: '交付期限 12/20', score: 1, citation: { documentId: 'd', versionNumber: 2, title: '週報', filename: 'w.docx', chunkId: 'c1', location: { kind: 'paragraph', from: { kind: 'paragraph', paragraph: 3 } }, excerptSha256: 'x' } }] });
      }
      if (url.endsWith('/citations/c1')) return json(200, { verified: true });
      return json(200, { items: [] });
    };
    fireEvent.click(screen.getByRole('button', { name: '檢索與引用' }));
    fireEvent.change(screen.getByLabelText('查詢'), { target: { value: '期限' } });
    fireEvent.click(screen.getByRole('button', { name: '檢索' }));
    expect(await screen.findByText(/來源：週報 第 2 版（w.docx）第 3 段/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '驗證引用' }));
    expect(await screen.findByText('原文相符')).toBeTruthy();
  });

  it('網路中斷時顯示離線提示', async () => {
    await login(employee);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    fireEvent.click(screen.getByRole('button', { name: '檢索與引用' }));
    fireEvent.change(screen.getByLabelText('查詢'), { target: { value: '期限' } });
    fireEvent.click(screen.getByRole('button', { name: '檢索' }));
    expect(await screen.findByText('無法連線到伺服器，請檢查網路後重試')).toBeTruthy();
  });

  for (const status of ['INVALID', 'VALID'] as const) it(`ASTRA-007：引用 ${status}：${status === 'INVALID' ? '顯示原因、送審停用' : '送審可按'}`, async () => {
    await login(employee);
    const citation = { index: 1, documentId: 'd', versionNumber: 1, title: '丙專案', filename: 'c.txt', chunkId: 'c1', location: { from: { kind: 'page', page: 2, line: 3 } }, excerptSha256: 'x' };
    handler = url => {
      if (url.endsWith('/drafts')) return json(200, { items: [{ id: 'dr1', title: '週報', status: 'draft', updatedAt: '2026-11-05T00:00:00Z' }] });
      if (url.endsWith('/drafts/dr1')) return json(200, {
        draft: { id: 'dr1', title: '週報', status: 'draft', currentRevision: 1, authorMemberId: 'm' },
        revision: { revision: 1, body: '依 [1] 與 [999]', source: 'model', citations: [citation], citationStatus: status,
          citationReport: { cited: [1, 999], invalid: status === 'INVALID' ? [{ index: 999, reason: 'MISSING_METADATA' }] : [], unused: [] } },
        approvals: [],
      });
      return json(200, { items: [] });
    };
    fireEvent.click(screen.getByRole('button', { name: 'AI 草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: /週報/ }));
    expect(await screen.findByText(/第 2 頁第 3 行/)).toBeTruthy();
    if (status === 'INVALID') {
      expect(screen.getByText('引用無效')).toBeTruthy();
      expect(screen.getByText(/\[999\] 沒有對應的來源/)).toBeTruthy();
      expect((screen.getByRole('button', { name: '送審' }) as HTMLButtonElement).disabled).toBe(true);
    } else {
      expect(screen.getByText('引用有效')).toBeTruthy();
      expect((screen.getByRole('button', { name: '送審' }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('ASTRA-004：隔離的 Run 對申請者顯示硬邊界提示；管理員可放行；通知分頁可標已讀', async () => {
    const quarantined = { id: 'r1', status: 'quarantined', errorCode: 'ENTERPRISE_PRINCIPAL_REVOKED', draftId: 'dr2', attempts: 1, createdAt: '2026-11-05T00:00:00Z', input: { query: '交付期限' } };
    await login(employee);
    handler = url => (url.endsWith('/runs') ? json(200, { items: [quarantined] }) : json(200, { items: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'AI 草稿' }));
    expect(await screen.findByText(/硬邊界，需管理員重新授權/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '放行' })).toBeNull();
    cleanup();
    sessionStorage.clear();
    await login(admin);
    handler = (url, init) => {
      if (url.endsWith('/runs')) return json(200, { items: [quarantined] });
      if (url.endsWith('/quarantine/release') && init.method === 'POST') return json(200, { runId: 'r1', status: 'released' });
      if (url.endsWith('/notifications')) return json(200, { items: [{ id: 'n1', kind: 'run.quarantined', severity: 'warning', subjectType: 'run', subjectId: 'r1', code: 'ENTERPRISE_PRINCIPAL_REVOKED', message: '結果已隔離、未發布', createdAt: '2026-11-05T00:00:00Z', readAt: null, audience: 'role' }] });
      if (url.endsWith('/notifications/n1/read')) return json(200, { id: 'n1', read: true });
      return json(200, { items: [] });
    };
    fireEvent.click(screen.getByRole('button', { name: 'AI 草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: '放行' }));
    expect(await screen.findByText('已重新確認權限並放行')).toBeTruthy();
    expect(calls.some(call => call.url.endsWith('/api/enterprise/v1/runs/r1/quarantine/release') && call.init.method === 'POST')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '通知' }));
    expect(await screen.findByText('結果已隔離、未發布')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '標為已讀' }));
    await vi.waitFor(() => expect(calls.some(call => call.url.endsWith('/notifications/n1/read'))).toBe(true));
  });

  it('E2E 發現：生成中就打開的草稿，完成後自動顯示內容（不必重新點選）', async () => {
    await login(employee);
    let done = false;
    handler = url => {
      if (url.endsWith('/runs')) return json(200, { items: [{ id: 'r9', status: done ? 'succeeded' : 'running', errorCode: null, draftId: 'd9', attempts: 1, createdAt: '2026-11-05T00:00:00Z', input: { query: 'q' } }] });
      if (url.endsWith('/drafts')) return json(200, { items: [{ id: 'd9', title: '生成中草稿', status: done ? 'draft' : 'generating', updatedAt: '2026-11-05T00:00:00Z' }] });
      if (url.endsWith('/drafts/d9')) return json(200, {
        draft: { id: 'd9', title: '生成中草稿', status: done ? 'draft' : 'generating', currentRevision: done ? 1 : 0, authorMemberId: 'm' },
        revision: done ? { revision: 1, body: '完成的內容 [1]', source: 'model', citations: [], citationStatus: 'VALID', citationReport: { cited: [1], invalid: [], unused: [] } } : null,
        approvals: [],
      });
      return json(200, { items: [] });
    };
    fireEvent.click(screen.getByRole('button', { name: 'AI 草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: /生成中草稿/ }));
    expect(await screen.findByText('草稿尚未產生內容')).toBeTruthy();
    done = true;
    await vi.waitFor(() => expect(screen.getByText('引用有效')).toBeTruthy(), { timeout: 8000 });
  }, 15000);
  it('ASTRA-V3-NEW-001：審核畫面顯示 approval 綁定的版號與內容（不是草稿目前版），核准送出同一版號與 hash；送審帶版號', async () => {
    await login(admin);
    const sha = 'a'.repeat(64);
    handler = (url, init) => {
      if (url.endsWith('/approvals')) return json(200, { items: [{ id: 'ap1', draftId: 'dr1', title: '月報', revision: 2, revisionSha256: sha, createdAt: '2026-11-06T00:00:00Z' }] });
      if (url.endsWith('/approvals/ap1')) return json(200, {
        approval: { id: 'ap1', draftId: 'dr1', revision: 2, revisionSha256: sha, status: 'pending', requestedByMemberId: 'x', createdAt: '2026-11-06T00:00:00Z' },
        draft: { id: 'dr1', title: '月報', status: 'submitted', currentRevision: 2 },
        revision: { revision: 2, body: '第二版內容 [1]', source: 'human', citations: [], citationStatus: 'VALID', citationReport: { cited: [1], invalid: [], unused: [] } },
        contentSha256: sha,
      });
      if (url.endsWith('/drafts/dr1')) return json(200, { draft: { id: 'dr1', title: '月報', status: 'submitted', currentRevision: 3 }, revision: { revision: 3, body: '不該出現的第三版', source: 'human', citations: [], citationStatus: 'VALID', citationReport: { cited: [], invalid: [], unused: [] } }, approvals: [] });
      if (url.endsWith('/approvals/ap1/decision') && init.method === 'POST') return json(200, { approvalId: 'ap1', status: 'approved', revision: 2, revisionSha256: sha });
      return json(200, { items: [] });
    };
    fireEvent.click(screen.getByRole('button', { name: '審批' }));
    fireEvent.click(await screen.findByRole('button', { name: /月報/ }));
    expect(await screen.findByText('第二版內容 [1]')).toBeTruthy();
    expect(screen.queryByText('不該出現的第三版')).toBeNull();
    expect(screen.getByTestId('approval-revision').textContent).toContain('審核第 2 版');
    fireEvent.click(screen.getByRole('button', { name: '核准' }));
    await vi.waitFor(() => expect(calls.some(call => call.url.endsWith('/approvals/ap1/decision'))).toBe(true));
    const decision = calls.find(call => call.url.endsWith('/approvals/ap1/decision'))!;
    expect(JSON.parse(String(decision.init.body))).toMatchObject({ decision: 'approve', expectedRevision: 2, expectedSha256: sha });
  });
  it('W6-B：對帳分頁送出兩個文件版本與期間；缺資料顯示「—」不是 0；拒收顯示原因', async () => {
    await login(employee);
    const completed = {
      id: 'rc1', ruleVersion: 'ACC-MATCH-v1', status: 'completed', periodStart: '2026-10-01', periodEnd: '2026-10-28', resultSha256: 'c'.repeat(64), createdAt: '2026-11-06T00:00:00Z',
      ledgerSha256: 'a'.repeat(64), receiptsSha256: 'b'.repeat(64),
      result: { totals: [{ currency: 'TWD', ledgerSourceMinor: '1', receiptSourceMinor: '1', isolatedLedgerMinor: '0', isolatedReceiptMinor: '0', exactMatchMinor: '350000' }],
        cases: [{ caseId: 'ACC-CASE-003', documentId: 'INV-003', category: 'MISSING_RECEIPT', label: '缺收款明細', reasons: [], ledgerRowIds: ['I003'], receiptRowIds: [],
          ledgerCurrency: 'TWD', ledgerTotalMinor: '120000', receiptCurrency: null, receiptTotalMinor: null, differenceMinor: null, includedInExactMatchTotal: false, isolated: false,
          sources: [{ side: 'ledger', versionId: 'v', sha256: 'a'.repeat(64), line: 4, rowId: 'I003' }] }] },
    };
    handler = (url, init) => {
      if (url.includes('/documents?')) return json(200, { items: [{ id: 'd1', title: '內部帳', classification: 'internal', createdAt: '2026-11-06T00:00:00Z' }, { id: 'd2', title: '收款', classification: 'internal', createdAt: '2026-11-06T00:00:00Z' }], nextCursor: null });
      if (url.endsWith('/reconciliations') && init.method === 'POST') return json(201, { reconciliation: completed, reused: false });
      if (url.endsWith('/reconciliations')) return json(200, { items: [] });
      if (url.endsWith('/reconciliations/rc1')) return json(200, completed);
      return json(200, { items: [] });
    };
    fireEvent.click(screen.getByRole('button', { name: '對帳' }));
    const [ledger, receipts] = await screen.findAllByRole('combobox');
    await vi.waitFor(() => expect(ledger.querySelectorAll('option').length).toBe(3));
    fireEvent.change(ledger, { target: { value: 'd1' } });
    fireEvent.change(receipts, { target: { value: 'd2' } });
    fireEvent.change(screen.getByLabelText('期間起'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('期間迄'), { target: { value: '2026-10-28' } });
    fireEvent.click(screen.getByRole('button', { name: '執行對帳' }));
    expect(await screen.findByText('對帳完成')).toBeTruthy();
    const sent = JSON.parse(String(calls.find(call => call.url.endsWith('/reconciliations') && call.init.method === 'POST')!.init.body));
    expect(sent).toEqual({ ledger: { documentId: 'd1', versionNumber: 1 }, receipts: { documentId: 'd2', versionNumber: 1 }, periodStart: '2026-10-01', periodEnd: '2026-10-28' });
    expect(await screen.findByText('缺收款明細')).toBeTruthy();
    expect(screen.getByText('1,200.00 TWD')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('3,500.00 TWD')).toBeTruthy();
    expect(screen.getByText(/內部帳第4行 I003/)).toBeTruthy();
  });
});
