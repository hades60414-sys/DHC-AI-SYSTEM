import { useRef, useState } from 'react';

import { Badge, Button, Input } from '@/shared/ui';
import { OfficeStatus } from '@/modules/office/OfficeStatus';
import { useOfficeQuery } from '@/modules/office/hooks/useOfficeQuery';
import { officeApi, officeEndpoints } from '@/shared/api';
import type { OfficeDocumentRow, OfficeExtraction, OfficeVersionRow } from '@/shared/types';
import { formatOfficeTime } from '@/shared/utils';


const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
};
const EXTRACTION_LABEL: Record<string, string> = { succeeded: '可檢索', failed: '擷取失敗', unsupported: '不支援檢索（僅保存）' };

function mediaTypeOf(file: File) {
  return EXTENSION_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? file.type;
}

/** office 模組內部：文件清單、上傳、版本、下載與擷取狀態。 */
export function OfficeDocuments({ canWrite }: { canWrite: boolean }) {
  const list = useOfficeQuery<{ items: OfficeDocumentRow[]; nextCursor: string | null }>(officeEndpoints.documents(50));
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useOfficeQuery<{ document: OfficeDocumentRow; versions: OfficeVersionRow[] }>(selected ? officeEndpoints.document(selected) : null);
  const [title, setTitle] = useState('');
  const [classification, setClassification] = useState('internal');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);

  const send = async (file: File, upload: (body: ArrayBuffer, mediaType: string) => Promise<{ extraction?: OfficeExtraction }>) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await upload(await file.arrayBuffer(), mediaTypeOf(file));
      const status = result.extraction?.status;
      setMessage(`已上傳「${file.name}」${status ? `，${EXTRACTION_LABEL[status] ?? status}` : ''}`);
      list.reload();
      detail.reload();
      return result;
    } catch (reason) {
      setMessage((reason as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file || !title.trim()) { setMessage('請選擇檔案並輸入標題'); return; }
    const result = await send(file, (body, mediaType) => officeApi.uploadDocument({ body, filename: file.name, mediaType, title: title.trim(), classification }));
    if (result) { setTitle(''); if (fileInput.current) fileInput.current.value = ''; }
  };

  const uploadVersion = async () => {
    const file = versionInput.current?.files?.[0];
    const latest = detail.data?.versions.at(-1)?.versionNumber ?? 0;
    if (!file || !selected) { setMessage('請選擇新版本檔案'); return; }
    await send(file, (body, mediaType) => officeApi.uploadVersion(selected, { body, filename: file.name, mediaType, expectedLatestVersion: latest }));
    if (versionInput.current) versionInput.current.value = '';
  };

  return (
    <section className="grid gap-4 md:grid-cols-2" aria-label="文件">
      <div className="space-y-3">
        {canWrite && (
          <div className="space-y-2 rounded-md border p-3">
            <h3 className="font-medium">上傳文件</h3>
            <label className="block text-sm">標題<Input value={title} onChange={event => setTitle(event.target.value)} /></label>
            <label className="block text-sm">資料分級
              <select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={classification} onChange={event => setClassification(event.target.value)}>
                <option value="public">公開</option><option value="internal">內部</option><option value="confidential">機密</option><option value="restricted">限閱</option>
              </select>
            </label>
            <input ref={fileInput} type="file" aria-label="選擇檔案" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt,.md,.csv" className="text-sm" />
            <Button onClick={upload} disabled={busy}>{busy ? '上傳中…' : '上傳'}</Button>
          </div>
        )}
        {message && <p className="text-sm" role="status">{message}</p>}
        <OfficeStatus loading={list.loading} error={list.error} empty={list.data?.items.length === 0} emptyText="尚未上傳文件" onRetry={list.reload} />
        <ul className="divide-y rounded-md border">
          {list.data?.items.map(item => (
            <li key={item.id}>
              <button type="button" className={`w-full p-3 text-left text-sm hover:bg-accent ${selected === item.id ? 'bg-accent' : ''}`} onClick={() => setSelected(item.id)}>
                <span className="font-medium">{item.title}</span> <Badge variant="outline">{item.classification}</Badge>
                <span className="block text-xs text-muted-foreground">{formatOfficeTime(item.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-3">
        {!selected && <p className="text-sm text-muted-foreground">選擇左側文件以檢視版本</p>}
        {selected && <OfficeStatus loading={detail.loading} error={detail.error} onRetry={detail.reload} />}
        {detail.data && (
          <div className="space-y-2">
            <h3 className="font-medium">{detail.data.document.title}</h3>
            <ul className="space-y-2">
              {detail.data.versions.map(version => (
                <li key={version.versionNumber} className="rounded-md border p-2 text-sm">
                  第 {version.versionNumber} 版：{version.filename}（{Math.ceil(version.byteSize / 1024)} KB）
                  <span className="block break-all text-xs text-muted-foreground">SHA-256 {version.sha256}</span>
                  <Button size="sm" variant="outline" className="mt-1" onClick={() => void officeApi.downloadVersion(selected!, version.versionNumber, version.filename)}>下載</Button>
                </li>
              ))}
            </ul>
            {canWrite && (
              <div className="space-y-2 rounded-md border p-2">
                <input ref={versionInput} type="file" aria-label="選擇新版本檔案" className="text-sm" />
                <Button size="sm" onClick={uploadVersion} disabled={busy}>上傳新版本</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
