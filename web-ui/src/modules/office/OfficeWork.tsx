import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Badge, Button, Input } from '@/shared/ui';
import { OfficeStatus } from '@/modules/office/OfficeStatus';
import { useOfficeQuery } from '@/modules/office/hooks/useOfficeQuery';
import { officeApi, officeEndpoints } from '@/shared/api';
import type { OfficeApprovalDetail, OfficeCitationCheck, OfficeDraftDetail, OfficeRun, OfficeSearchHit } from '@/shared/types';
import { formatOfficeTime } from '@/shared/utils';

const RUN_LABEL: Record<string, string> = { queued: '排隊中', running: '產生中', succeeded: '完成', failed: '失敗', cancelled: '已取消', quarantined: '已隔離（待管理員）' };
const DRAFT_LABEL: Record<string, string> = { generating: '產生中', draft: '草稿', submitted: '審核中', approved: '已核准', rejected: '已退回', failed: '失敗', quarantined: '已隔離' };
const CITATION_REASON: Record<string, string> = { MISSING_METADATA: '沒有對應的來源', SOURCE_NOT_FOUND: '來源不存在或不屬於本組織', VERSION_MISMATCH: '來源版本不符', HASH_MISMATCH: '來源原文已變更' };

/** office 模組內部：顯示伺服器重驗的引用狀態（ASTRA-007）；只有 VALID 才能送審／核准／匯出。 */
function CitationCheck({ check }: { check: OfficeCitationCheck }) {
  if (check.citationStatus === 'VALID') return <Badge variant="outline">引用有效</Badge>;
  return (
    <div className="rounded-md border border-destructive p-2 text-xs" role="alert">
      <Badge variant="destructive">{check.citationStatus === 'UNCITED' ? '沒有引用來源' : '引用無效'}</Badge>
      {check.citationStatus === 'UNCITED' && <p className="mt-1">內容沒有任何 [n] 來源標記，不能送審。</p>}
      <ul className="mt-1 list-disc pl-4">
        {check.citationReport.invalid.map(item => <li key={item.index}>[{item.index}] {CITATION_REASON[item.reason] ?? item.reason}</li>)}
      </ul>
    </div>
  );
}

function describeLocation(location: Record<string, unknown>) {
  const from = location.from as Record<string, unknown> | undefined;
  if (!from) return '';
  if (from.kind === 'row' && from.sheet) return `工作表「${String(from.sheet)}」第 ${String(from.row)} 列`;
  if (from.kind === 'paragraph') return `第 ${String(from.paragraph)} 段`;
  if (from.kind === 'line') return `第 ${String(from.line)} 行`;
  if (from.kind === 'page') return `第 ${String(from.page)} 頁第 ${String(from.line)} 行`;
  return `第 ${String(from.row ?? '')} 列`;
}

/** office 模組內部：檢索問答與來源引用（可回到文件版本並驗證 hash）。 */
export function OfficeSearch() {
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState(false);
  const [hits, setHits] = useState<OfficeSearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setHits((await officeApi.search(query, history)).items);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  const verify = async (chunkId: string) => {
    const result = await officeApi.verifyCitation(chunkId);
    setVerified(current => ({ ...current, [chunkId]: result.verified }));
  };

  return (
    <section className="space-y-3" aria-label="檢索與引用">
      <form className="flex flex-wrap gap-2" onSubmit={search}>
        <Input className="max-w-md" value={query} onChange={event => setQuery(event.target.value)} placeholder="輸入關鍵詞（以空白分隔，全部需出現）" aria-label="查詢" />
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />含舊版本</label>
        <Button type="submit">檢索</Button>
      </form>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {hits && hits.length === 0 && <p className="text-sm text-muted-foreground">找不到同時包含所有詞的段落（圖片與沒有文字層的掃描 PDF 目前不可檢索）</p>}
      <ol className="space-y-2">
        {hits?.map((hit, index) => (
          <li key={hit.citation.chunkId} className="rounded-md border p-3 text-sm">
            <p className="whitespace-pre-wrap">[{index + 1}] {hit.excerpt}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              來源：{hit.citation.title} 第 {hit.citation.versionNumber} 版（{hit.citation.filename}）{describeLocation(hit.citation.location)}
            </p>
            <Button size="sm" variant="outline" className="mt-1" onClick={() => void verify(hit.citation.chunkId)}>驗證引用</Button>
            {hit.citation.chunkId in verified && (
              <Badge className="ml-2" variant={verified[hit.citation.chunkId] ? 'default' : 'destructive'}>{verified[hit.citation.chunkId] ? '原文相符' : '原文已變更'}</Badge>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** office 模組內部：AI 草稿工作（建立、追蹤、取消）、人工修改、送審與匯出；canRelease＝可放行／丟棄隔離結果（預設 org_admin，後端再驗）。 */
export function OfficeDrafts({ canWrite, canRelease = false }: { canWrite: boolean; canRelease?: boolean }) {
  const providers = useOfficeQuery<{ items: Array<{ key: string; kind: string; enabled: boolean }> }>(officeEndpoints.providers);
  const runs = useOfficeQuery<{ items: OfficeRun[] }>(officeEndpoints.runs);
  const drafts = useOfficeQuery<{ items: Array<{ id: string; title: string; status: string; updatedAt: string }> }>(officeEndpoints.drafts);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useOfficeQuery<OfficeDraftDetail>(selected ? officeEndpoints.draft(selected) : null);
  const [form, setForm] = useState({ title: '', query: '', providerKey: '' });
  // 未儲存的編輯以「草稿 id:修訂號」為 key；切換草稿或有新修訂時自然回到伺服器內容。
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const { reload: reloadRuns } = runs;
  const { reload: reloadDrafts } = drafts;
  const { reload: reloadDetail } = detail;
  const pending = runs.data?.items.some(run => run.status === 'queued' || run.status === 'running');
  const wasPending = useRef(false);

  // 有未完成的工作時每 2 秒更新狀態（含目前選取草稿的內容，否則產生完成後仍顯示「尚未產生內容」）
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => { reloadRuns(); reloadDrafts(); reloadDetail(); }, 2000);
    return () => clearInterval(timer);
  }, [pending, reloadRuns, reloadDrafts, reloadDetail]);

  // 工作剛全部結束時再更新一次（最後一次輪詢可能早於完成）
  useEffect(() => {
    if (wasPending.current && !pending) { reloadDrafts(); reloadDetail(); }
    wasPending.current = Boolean(pending);
  }, [pending, reloadDrafts, reloadDetail]);

  const act = async (operation: () => Promise<unknown>, done: string) => {
    setMessage(null);
    try {
      await operation();
      setMessage(done);
      runs.reload(); drafts.reload(); detail.reload();
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  };
  const start = (event: FormEvent) => {
    event.preventDefault();
    const providerKey = form.providerKey || providers.data?.items.find(item => item.enabled)?.key || '';
    void act(() => officeApi.startDraftRun({ ...form, providerKey }), '已送出 AI 草稿工作');
  };
  const revision = detail.data?.revision;
  const editKey = `${selected}:${revision?.revision ?? 0}`;
  const body = edits[editKey] ?? revision?.body ?? '';
  const setBody = (value: string) => setEdits(current => ({ ...current, [editKey]: value }));
  const editable = detail.data && ['draft', 'rejected'].includes(detail.data.draft.status);

  return (
    <section className="grid gap-4 lg:grid-cols-2" aria-label="草稿">
      <div className="space-y-3">
        {canWrite && (
          <form className="space-y-2 rounded-md border p-3" onSubmit={start}>
            <h3 className="font-medium">新增 AI 草稿</h3>
            <label className="block text-sm">標題<Input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} required /></label>
            <label className="block text-sm">需求與關鍵詞<Input value={form.query} onChange={event => setForm({ ...form, query: event.target.value })} required /></label>
            <label className="block text-sm">模型
              <select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={form.providerKey} onChange={event => setForm({ ...form, providerKey: event.target.value })}>
                <option value="">預設</option>
                {providers.data?.items.filter(item => item.enabled).map(item => <option key={item.key} value={item.key}>{item.key}（{item.kind}）</option>)}
              </select>
            </label>
            <Button type="submit">產生草稿</Button>
          </form>
        )}
        {message && <p className="text-sm" role="status">{message}</p>}
        <h3 className="font-medium">工作狀態</h3>
        <OfficeStatus loading={runs.loading && !runs.data} error={runs.error} empty={runs.data?.items.length === 0} emptyText="尚無 AI 工作" onRetry={runs.reload} />
        <ul className="space-y-1 text-sm">
          {runs.data?.items.slice(0, 10).map(run => (
            <li key={run.id} className="flex flex-wrap items-center gap-2">
              <Badge variant={run.status === 'failed' ? 'destructive' : 'outline'}>{RUN_LABEL[run.status] ?? run.status}</Badge>
              <span>{run.input.query}</span>
              {run.errorCode && <span className="text-xs text-destructive">{run.errorCode}</span>}
              {(run.status === 'queued' || run.status === 'running') && (
                <Button size="sm" variant="ghost" onClick={() => void act(() => officeApi.cancelRun(run.id), '已要求取消')}>取消</Button>
              )}
              {run.status === 'quarantined' && !canRelease && (
                <span className="text-xs">執行期間權限已變更，結果已隔離；這是組織的硬邊界，需管理員重新授權。</span>
              )}
              {run.status === 'quarantined' && canRelease && (
                <>
                  <Button size="sm" variant="outline" onClick={() => void act(() => officeApi.releaseQuarantine(run.id), '已重新確認權限並放行')}>放行</Button>
                  <Button size="sm" variant="destructive" onClick={() => void act(() => officeApi.discardQuarantine(run.id), '已丟棄隔離結果')}>丟棄</Button>
                </>
              )}
            </li>
          ))}
        </ul>
        <h3 className="font-medium">草稿</h3>
        <ul className="divide-y rounded-md border">
          {drafts.data?.items.map(item => (
            <li key={item.id}>
              <button type="button" className={`w-full p-2 text-left text-sm hover:bg-accent ${selected === item.id ? 'bg-accent' : ''}`} onClick={() => setSelected(item.id)}>
                {item.title} <Badge variant="outline">{DRAFT_LABEL[item.status] ?? item.status}</Badge>
                <span className="block text-xs text-muted-foreground">{formatOfficeTime(item.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-3">
        {selected && <OfficeStatus loading={detail.loading && !detail.data} error={detail.error} onRetry={detail.reload} />}
        {detail.data && (
          <div className="space-y-2">
            <h3 className="font-medium">{detail.data.draft.title} <Badge variant="outline">{DRAFT_LABEL[detail.data.draft.status]}</Badge></h3>
            {!revision && <p className="text-sm text-muted-foreground">草稿尚未產生內容</p>}
            {revision && (
              <>
                <label className="block text-sm">內容（第 {revision.revision} 版，{revision.source === 'model' ? 'AI 產生' : '人工修改'}）
                  <textarea className="mt-1 h-64 w-full rounded-md border bg-background p-2 text-sm" value={body} readOnly={!editable || !canWrite} onChange={event => setBody(event.target.value)} />
                </label>
                <div className="flex flex-wrap gap-2">
                  {editable && canWrite && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => void act(() => officeApi.reviseDraft(selected!, { expectedRevision: revision.revision, body }), '已儲存修改')}>儲存修改</Button>
                      <Button size="sm" disabled={revision.citationStatus !== 'VALID'} onClick={() => void act(() => officeApi.submitDraft(selected!, revision.revision), '已送審')}>送審</Button>
                    </>
                  )}
                  {detail.data.draft.status === 'approved' && (
                    <>
                      <Button size="sm" onClick={() => void act(() => officeApi.exportDraft(selected!, 'docx'), '已匯出 Word')}>匯出 Word</Button>
                      <Button size="sm" variant="outline" onClick={() => void act(() => officeApi.exportDraft(selected!, 'markdown'), '已匯出 Markdown')}>匯出 Markdown</Button>
                    </>
                  )}
                </div>
                <CitationCheck check={revision} />
                <h4 className="text-sm font-medium">來源</h4>
                <ol className="space-y-1 text-xs text-muted-foreground">
                  {revision.citations.map(citation => (
                    <li key={citation.chunkId}>[{citation.index}] {citation.title} 第 {citation.versionNumber} 版 {describeLocation(citation.location)}</li>
                  ))}
                </ol>
                {detail.data.approvals.filter(item => item.status !== 'pending').map(item => (
                  <p key={item.id} className="text-xs">審核結果：{item.status === 'approved' ? '核准' : '退回'}　{item.decisionComment ?? ''}　{formatOfficeTime(item.decidedAt)}</p>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** office 模組內部：審核者待辦（核准／退回並填寫意見）。 */
export function OfficeApprovals() {
  const approvals = useOfficeQuery<{ items: Array<{ id: string; draftId: string; title: string; revision: number; revisionSha256: string | null; createdAt: string }> }>(officeEndpoints.approvals);
  const [selected, setSelected] = useState<{ id: string; draftId: string } | null>(null);
  // ASTRA-V3-NEW-001：審核畫面讀 approval 綁定的修訂，不讀草稿目前修訂；核准時把畫面上的版號與 hash 一起送出。
  const detail = useOfficeQuery<OfficeApprovalDetail>(selected ? officeEndpoints.approval(selected.id) : null);
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const decide = async (decision: 'approve' | 'reject') => {
    if (!selected) return;
    try {
      if (!detail.data) return;
      await officeApi.decideApproval(selected.id, { decision, comment, expectedRevision: detail.data.approval.revision, expectedSha256: detail.data.approval.revisionSha256 });
      setMessage(decision === 'approve' ? '已核准' : '已退回');
      setSelected(null);
      setComment('');
      approvals.reload();
    } catch (reason) {
      setMessage((reason as Error).message);
      // ASTRA-V3-NEW-001：版號／hash 已過期（409）時重新載入綁定修訂，避免審核者停在舊畫面
      detail.reload();
    }
  };

  return (
    <section className="grid gap-4 md:grid-cols-2" aria-label="審批">
      <div>
        {message && <p className="text-sm" role="status">{message}</p>}
        <OfficeStatus loading={approvals.loading} error={approvals.error} empty={approvals.data?.items.length === 0} emptyText="沒有待審項目" onRetry={approvals.reload} />
        <ul className="divide-y rounded-md border">
          {approvals.data?.items.map(item => (
            <li key={item.id}>
              <button type="button" className="w-full p-2 text-left text-sm hover:bg-accent" onClick={() => setSelected({ id: item.id, draftId: item.draftId })}>
                {item.title}（第 {item.revision} 版）<span className="block text-xs text-muted-foreground">{formatOfficeTime(item.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {detail.data?.revision && (
        <div className="space-y-2">
          <h3 className="font-medium">{detail.data.draft.title}</h3>
          <p className="text-xs text-muted-foreground" data-testid="approval-revision">
            審核第 {detail.data.approval.revision} 版（內容 SHA-256 {detail.data.approval.revisionSha256.slice(0, 12)}…）
          </p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border p-2 text-sm">{detail.data.revision.body}</pre>
          <CitationCheck check={detail.data.revision} />
          <label className="block text-sm">審核意見<Input value={comment} onChange={event => setComment(event.target.value)} /></label>
          <div className="flex gap-2">
            <Button disabled={detail.data.revision.citationStatus !== 'VALID'} onClick={() => void decide('approve')}>核准</Button>
            <Button variant="destructive" onClick={() => void decide('reject')}>退回</Button>
          </div>
        </div>
      )}
    </section>
  );
}
