import { useState, type FormEvent } from 'react';

import { Badge, Button, Input } from '@/shared/ui';
import { OfficeStatus } from '@/modules/office/OfficeStatus';
import { useOfficeQuery } from '@/modules/office/hooks/useOfficeQuery';
import { officeApi, officeEndpoints } from '@/shared/api';
import type { OfficeDocumentRow, OfficeReconciliation } from '@/shared/types';
import { formatOfficeTime } from '@/shared/utils';

/** 最小單位整數字串 → 顯示字串（小數位數 2，只移動小數點、不換匯）；null 顯示「—」表示缺資料，不是 0。 */
function formatMinor(value: string | null, currency: string | null) {
  if (value === null) return '—';
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${digits.slice(-2)} ${currency ?? ''}`.trim();
}

/** 供 OfficeApp「對帳」分頁使用：選兩個 CSV 文件版本與期間，以 ACC-MATCH-v1 產生確定性對帳結果；結果只顯示伺服器計算值。 */
export function OfficeReconciliation({ canWrite }: { canWrite: boolean }) {
  const documents = useOfficeQuery<{ items: OfficeDocumentRow[] }>(officeEndpoints.documents(100));
  const list = useOfficeQuery<{ items: OfficeReconciliation[] }>(officeEndpoints.reconciliations);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useOfficeQuery<OfficeReconciliation>(selected ? officeEndpoints.reconciliation(selected) : null);
  const [form, setForm] = useState({ ledger: '', ledgerVersion: '1', receipts: '', receiptsVersion: '1', periodStart: '', periodEnd: '' });
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const created = await officeApi.createReconciliation({
        ledger: { documentId: form.ledger, versionNumber: Number(form.ledgerVersion) },
        receipts: { documentId: form.receipts, versionNumber: Number(form.receiptsVersion) },
        periodStart: form.periodStart, periodEnd: form.periodEnd,
      });
      setMessage(created.reused ? '相同輸入已對帳過，顯示原結果' : created.reconciliation.status === 'completed' ? '對帳完成' : '資料結構錯誤，整批拒收');
      setSelected(created.reconciliation.id);
      list.reload();
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  };
  const field = (key: keyof typeof form) => ({ value: form[key], onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }) });
  const result = detail.data?.result;

  return (
    <section className="space-y-4" aria-label="對帳">
      <p className="text-xs text-muted-foreground">規則 ACC-MATCH-v1：以單據 ID 一對一比對、不模糊配對、不換匯、缺漏不補 0、重複整組隔離。結果供人審核對，不是會計或稅務結論。</p>
      {canWrite && (
        <form className="grid gap-2 md:grid-cols-3" onSubmit={event => void submit(event)}>
          <label className="text-sm">內部帳 CSV
            <select className="block w-full rounded-md border p-1" required {...field('ledger')}>
              <option value="">選擇文件</option>
              {documents.data?.items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <label className="text-sm">內部帳版本<Input type="number" min={1} required {...field('ledgerVersion')} /></label>
          <label className="text-sm">期間起<Input type="date" required {...field('periodStart')} /></label>
          <label className="text-sm">收款明細 CSV
            <select className="block w-full rounded-md border p-1" required {...field('receipts')}>
              <option value="">選擇文件</option>
              {documents.data?.items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <label className="text-sm">收款明細版本<Input type="number" min={1} required {...field('receiptsVersion')} /></label>
          <label className="text-sm">期間迄<Input type="date" required {...field('periodEnd')} /></label>
          <div><Button type="submit">執行對帳</Button></div>
        </form>
      )}
      {message && <p className="text-sm" role="status">{message}</p>}
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <div>
          <OfficeStatus loading={list.loading} error={list.error} empty={list.data?.items.length === 0} emptyText="尚無對帳結果" onRetry={list.reload} />
          <ul className="divide-y rounded-md border">
            {list.data?.items.map(item => (
              <li key={item.id}>
                <button type="button" className="w-full p-2 text-left text-sm hover:bg-accent" onClick={() => setSelected(item.id)}>
                  {item.periodStart}～{item.periodEnd} <Badge variant={item.status === 'completed' ? 'secondary' : 'destructive'}>{item.status === 'completed' ? '完成' : '拒收'}</Badge>
                  <span className="block text-xs text-muted-foreground">{formatOfficeTime(item.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {detail.data && (
          <div className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground" data-testid="reconciliation-hash">結果 SHA-256 {detail.data.resultSha256.slice(0, 16)}…；內部帳 {detail.data.ledgerSha256.slice(0, 12)}…；收款 {detail.data.receiptsSha256.slice(0, 12)}…</p>
            {result?.errors && (
              <ul className="list-disc pl-5 text-destructive" aria-label="拒收原因">
                {result.errors.map((error, index) => <li key={index}>{error.side} 第 {error.line ?? '—'} 行 {error.rowId ?? ''}：{error.code}</li>)}
              </ul>
            )}
            {result?.totals && (
              <table className="w-full border text-xs" aria-label="幣別合計">
                <thead><tr><th className="p-1 text-left">幣別</th><th>完全匹配總額</th><th>隔離（內部帳／收款）</th></tr></thead>
                <tbody>{result.totals.map(total => (
                  <tr key={total.currency}><td className="p-1">{total.currency}</td><td>{formatMinor(total.exactMatchMinor, total.currency)}</td>
                    <td>{formatMinor(total.isolatedLedgerMinor, total.currency)}／{formatMinor(total.isolatedReceiptMinor, total.currency)}</td></tr>
                ))}</tbody>
              </table>
            )}
            {result?.cases && (
              <table className="w-full border text-xs" aria-label="對帳案件">
                <thead><tr><th className="p-1 text-left">案件</th><th>單據</th><th>分類</th><th>應收</th><th>收款</th><th>差額</th><th>來源列</th></tr></thead>
                <tbody>{result.cases.map(item => (
                  <tr key={item.caseId} className="border-t">
                    <td className="p-1">{item.caseId}</td><td>{item.documentId}</td>
                    <td>{item.label}{item.isolated ? '（隔離）' : ''}</td>
                    <td>{formatMinor(item.ledgerTotalMinor, item.ledgerCurrency)}</td><td>{formatMinor(item.receiptTotalMinor, item.receiptCurrency)}</td>
                    <td>{formatMinor(item.differenceMinor, item.ledgerCurrency)}</td>
                    <td>{item.sources.map(source => `${source.side === 'ledger' ? '內部帳' : '收款'}第${source.line}行 ${source.rowId}`).join('；')}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
