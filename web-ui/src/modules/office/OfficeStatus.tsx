import { Button } from '@/shared/ui';

/** office 模組內部：統一的載入中／錯誤／空狀態區塊。 */
export function OfficeStatus({ loading, error, empty, emptyText, onRetry }: {
  loading: boolean; error: string | null; empty?: boolean; emptyText?: string; onRetry?: () => void;
}) {
  if (loading) return <p className="py-6 text-sm text-muted-foreground" role="status">載入中…</p>;
  if (error) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert">
        <span>{error}</span>
        {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>重試</Button>}
      </div>
    );
  }
  if (empty) return <p className="py-6 text-sm text-muted-foreground">{emptyText ?? '目前沒有資料'}</p>;
  return null;
}
