import { useState, type FormEvent } from 'react';

import { Badge, Button, Input } from '@/shared/ui';
import { OfficeStatus } from '@/modules/office/OfficeStatus';
import { useOfficeQuery } from '@/modules/office/hooks/useOfficeQuery';
import { officeApi, officeEndpoints } from '@/shared/api';
import type { OfficeMember } from '@/shared/types';
import { formatOfficeTime } from '@/shared/utils';

const ROLE_LABEL: Record<string, string> = { org_admin: '管理員', approver: '審核者', employee: '員工', auditor: '稽核者' };

/** office 模組內部：成員與權限管理（新增、停權、恢復、改角色）。安全判斷全在後端，UI 只呈現結果。 */
export function OfficeMembers({ canManage }: { canManage: boolean }) {
  const members = useOfficeQuery<{ items: OfficeMember[] }>(officeEndpoints.members);
  const [form, setForm] = useState({ email: '', password: '', role: 'employee' });
  const [message, setMessage] = useState<string | null>(null);
  const act = async (operation: () => Promise<unknown>, done: string) => {
    setMessage(null);
    try { await operation(); setMessage(done); members.reload(); } catch (reason) { setMessage((reason as Error).message); }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(() => officeApi.createMember({ email: form.email, password: form.password, roles: [form.role] }), '已新增成員').then(() => setForm({ ...form, password: '' }));
  };
  return (
    <section className="space-y-3" aria-label="成員">
      {canManage && (
        <form className="flex flex-wrap items-end gap-2 rounded-md border p-3" onSubmit={create}>
          <label className="text-sm">Email<Input type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} required /></label>
          <label className="text-sm">初始密碼（12 字元以上）<Input type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} required minLength={12} /></label>
          <label className="text-sm">角色
            <select className="mt-1 block rounded-md border bg-background p-2 text-sm" value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}>
              {Object.entries(ROLE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <Button type="submit">新增成員</Button>
        </form>
      )}
      {message && <p className="text-sm" role="status">{message}</p>}
      <OfficeStatus loading={members.loading} error={members.error} onRetry={members.reload} />
      <table className="w-full text-left text-sm">
        <thead><tr><th className="p-2">Email</th><th className="p-2">角色</th><th className="p-2">狀態</th><th className="p-2"><span className="sr-only">操作</span></th></tr></thead>
        <tbody>
          {members.data?.items.map(member => (
            <tr key={member.id} className="border-t">
              <td className="p-2">{member.email}</td>
              <td className="p-2">{member.roles.map(role => ROLE_LABEL[role] ?? role).join('、')}</td>
              <td className="p-2"><Badge variant={member.status === 'active' ? 'outline' : 'destructive'}>{member.status === 'active' ? '啟用' : '已停權'}</Badge></td>
              <td className="p-2">
                {canManage && member.status === 'active' && <Button size="sm" variant="destructive" onClick={() => void act(() => officeApi.disableMember(member.id), '已停權並撤銷其所有登入')}>停權</Button>}
                {canManage && member.status !== 'active' && <Button size="sm" variant="outline" onClick={() => void act(() => officeApi.enableMember(member.id), '已恢復')}>恢復</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** office 模組內部：模型 provider 設定（BYOK 金鑰只送出不回顯）與本月用量。 */
export function OfficeModels({ canManage }: { canManage: boolean }) {
  const providers = useOfficeQuery<{ items: Array<{ key: string; kind: string; baseUrl: string | null; model: string; deployment: string; hasApiKey: boolean; monthlyBudgetMicros: string; enabled: boolean }> }>(officeEndpoints.providers);
  const usage = useOfficeQuery<{ items: Array<{ key: string; spentMicros: string; monthlyBudgetMicros: string; inputTokens: number; outputTokens: number; succeededCalls: number; failedOrDeniedCalls: number }> }>(canManage ? officeEndpoints.usage : null);
  const [form, setForm] = useState({ key: '', kind: 'openai_compatible', baseUrl: '', model: '', deployment: 'LOCAL_ONLY', apiKey: '', monthlyBudgetUsd: '10', inputUsdPerMtok: '0', outputUsdPerMtok: '0' });
  const [message, setMessage] = useState<string | null>(null);
  const micros = (usd: string) => Math.round(Number(usd) * 1_000_000);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await officeApi.saveProvider({
        key: form.key, kind: form.kind, baseUrl: form.baseUrl || null, model: form.model || (form.kind === 'mock' ? 'mock' : ''), deployment: form.deployment,
        apiKey: form.apiKey || undefined, monthlyBudgetMicros: micros(form.monthlyBudgetUsd), inputPriceMicrosPerMtok: micros(form.inputUsdPerMtok), outputPriceMicrosPerMtok: micros(form.outputUsdPerMtok) });
      setForm({ ...form, apiKey: '' });
      setMessage('已儲存模型設定');
      providers.reload(); usage.reload();
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  };
  const field = (name: keyof typeof form, label: string, type = 'text') => (
    <label className="text-sm">{label}<Input type={type} value={form[name]} onChange={event => setForm({ ...form, [name]: event.target.value })} /></label>
  );
  return (
    <section className="space-y-3" aria-label="模型">
      {canManage && (
        <form className="grid gap-2 rounded-md border p-3 md:grid-cols-3" onSubmit={save}>
          {field('key', '代碼（小寫英數）')}
          <label className="text-sm">類型
            <select className="mt-1 block w-full rounded-md border bg-background p-2 text-sm" value={form.kind} onChange={event => setForm({ ...form, kind: event.target.value })}>
              <option value="mock">離線示範（不使用模型）</option><option value="openai_compatible">OpenAI 相容（含本地模型）</option><option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="text-sm">資料政策
            <select className="mt-1 block w-full rounded-md border bg-background p-2 text-sm" value={form.deployment} onChange={event => setForm({ ...form, deployment: event.target.value })}>
              <option value="LOCAL_ONLY">僅限內部主機</option><option value="CLOUD_ALLOWED">允許雲端（僅公開／內部文件）</option>
            </select>
          </label>
          {field('baseUrl', 'API 位址')}
          {field('model', '模型名稱')}
          {field('apiKey', 'API 金鑰（不會回顯）', 'password')}
          {field('monthlyBudgetUsd', '每月預算（USD）', 'number')}
          {field('inputUsdPerMtok', '輸入價格（USD / 百萬 token）', 'number')}
          {field('outputUsdPerMtok', '輸出價格（USD / 百萬 token）', 'number')}
          <Button type="submit" className="md:col-span-3">儲存</Button>
        </form>
      )}
      {message && <p className="text-sm" role="status">{message}</p>}
      <OfficeStatus loading={providers.loading} error={providers.error} empty={providers.data?.items.length === 0} emptyText="尚未設定模型" onRetry={providers.reload} />
      <ul className="space-y-1 text-sm">
        {providers.data?.items.map(item => (
          <li key={item.key}>
            <span className="font-medium">{item.key}</span> {item.kind}／{item.model}／{item.deployment === 'LOCAL_ONLY' ? '僅內部' : '允許雲端'}
            {item.hasApiKey && <Badge className="ml-1" variant="outline">已設定金鑰</Badge>}{!item.enabled && <Badge className="ml-1" variant="destructive">停用</Badge>}
          </li>
        ))}
      </ul>
      {usage.data && (
        <table className="w-full text-left text-sm">
          <thead><tr><th className="p-1">模型</th><th className="p-1">本月花費 / 預算（USD）</th><th className="p-1">Token（入/出）</th><th className="p-1">成功 / 失敗或拒絕</th></tr></thead>
          <tbody>{usage.data.items.map(row => (
            <tr key={row.key} className="border-t"><td className="p-1">{row.key}</td><td className="p-1">{(Number(row.spentMicros) / 1e6).toFixed(4)} / {(Number(row.monthlyBudgetMicros) / 1e6).toFixed(2)}</td>
              <td className="p-1">{row.inputTokens} / {row.outputTokens}</td><td className="p-1">{row.succeededCalls} / {row.failedOrDeniedCalls}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

/** office 模組內部：方案、席位、用量與帳務（唯讀；方案由供應商調整）。 */
export function OfficeSubscription() {
  const data = useOfficeQuery<{ subscription: { planKey: string; effectiveStatus: string; seatLimit: number; monthlyRunLimit: number; storageLimitBytes: string; periodEnd: string } | null;
    plan: { name: string } | null; usage: { activeSeats: number; runsThisMonth: number; storageBytes: string };
    invoices: Array<{ id: string; periodStart: string; periodEnd: string; amountNtd: string; state: string }> }>(officeEndpoints.subscription);
  const status: Record<string, string> = { trial: '試用中', active: '有效', grace: '寬限期', expired: '已到期（唯讀）', cancelled: '已取消（唯讀）' };
  return (
    <section className="space-y-2 text-sm" aria-label="方案與用量">
      <OfficeStatus loading={data.loading} error={data.error} onRetry={data.reload} />
      {data.data && !data.data.subscription && <p role="alert">尚未設定訂閱，系統目前為唯讀。</p>}
      {data.data?.subscription && (
        <dl className="grid grid-cols-2 gap-1">
          <dt>方案</dt><dd>{data.data.plan?.name}</dd>
          <dt>狀態</dt><dd>{status[data.data.subscription.effectiveStatus] ?? data.data.subscription.effectiveStatus}（至 {data.data.subscription.periodEnd}）</dd>
          <dt>席位</dt><dd>{data.data.usage.activeSeats} / {data.data.subscription.seatLimit}</dd>
          <dt>本月 AI 工作</dt><dd>{data.data.usage.runsThisMonth} / {data.data.subscription.monthlyRunLimit}</dd>
          <dt>儲存空間</dt><dd>{(Number(data.data.usage.storageBytes) / 1024 ** 2).toFixed(1)} MB / {(Number(data.data.subscription.storageLimitBytes) / 1024 ** 3).toFixed(0)} GB</dd>
        </dl>
      )}
      <p className="text-xs text-muted-foreground">方案價格為內部候選，正式報價以簽約文件為準。</p>
    </section>
  );
}

/** office 模組內部：稽核紀錄（分頁）。 */
export function OfficeAudit() {
  const [cursor, setCursor] = useState<string | null>(null);
  const events = useOfficeQuery<{ items: Array<{ id: string; action: string; resourceType: string; resourceId: string; actorMemberId: string; occurredAt: string }>; nextCursor: string | null }>(
    officeEndpoints.auditEvents(cursor));
  return (
    <section className="space-y-2" aria-label="稽核">
      <OfficeStatus loading={events.loading} error={events.error} empty={events.data?.items.length === 0} onRetry={events.reload} />
      <table className="w-full text-left text-xs">
        <thead><tr><th className="p-1">時間</th><th className="p-1">動作</th><th className="p-1">對象</th><th className="p-1">操作者</th></tr></thead>
        <tbody>{events.data?.items.map(event => (
          <tr key={event.id} className="border-t"><td className="p-1">{formatOfficeTime(event.occurredAt)}</td><td className="p-1">{event.action}</td>
            <td className="p-1">{event.resourceType}:{event.resourceId.slice(0, 8)}</td><td className="p-1">{event.actorMemberId.slice(0, 8)}</td></tr>
        ))}</tbody>
      </table>
      <div className="flex gap-2">
        {cursor && <Button size="sm" variant="outline" onClick={() => setCursor(null)}>回到最前</Button>}
        {events.data?.nextCursor && <Button size="sm" variant="outline" onClick={() => setCursor(events.data!.nextCursor)}>下一頁</Button>}
      </div>
    </section>
  );
}
