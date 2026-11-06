import { useState } from 'react';

import { Badge, Button } from '@/shared/ui';
import { OfficeStatus } from '@/modules/office/OfficeStatus';
import { useOfficeQuery } from '@/modules/office/hooks/useOfficeQuery';
import { officeApi, officeEndpoints } from '@/shared/api';
import type { OfficeNotification } from '@/shared/types';
import { formatOfficeTime } from '@/shared/utils';

const SEVERITY_VARIANT: Record<OfficeNotification['severity'], 'destructive' | 'default' | 'outline'> = { critical: 'destructive', warning: 'default', info: 'outline' };
const SEVERITY_LABEL: Record<OfficeNotification['severity'], string> = { critical: '嚴重', warning: '注意', info: '通知' };

/** office 模組內部：站內通知（外送被拒、Run 隔離等硬邊界事件；伺服器只回傳本人或本人角色可見的通知）。 */
export function OfficeNotifications() {
  const list = useOfficeQuery<{ items: OfficeNotification[] }>(officeEndpoints.notifications);
  const [message, setMessage] = useState<string | null>(null);
  const markRead = async (id: string) => {
    try {
      await officeApi.markNotificationRead(id);
      list.reload();
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  };
  return (
    <section className="space-y-2" aria-label="通知">
      {message && <p className="text-sm" role="status">{message}</p>}
      <OfficeStatus loading={list.loading && !list.data} error={list.error} empty={list.data?.items.length === 0} emptyText="沒有通知" onRetry={list.reload} />
      <ul className="divide-y rounded-md border">
        {list.data?.items.map(item => (
          <li key={item.id} className={`flex flex-wrap items-start gap-2 p-2 text-sm ${item.readAt ? 'opacity-60' : ''}`}>
            <Badge variant={SEVERITY_VARIANT[item.severity]}>{SEVERITY_LABEL[item.severity]}</Badge>
            <div className="min-w-0 flex-1">
              <p>{item.message}</p>
              <p className="text-xs text-muted-foreground">{formatOfficeTime(item.createdAt)}{item.code ? `　${item.code}` : ''}</p>
            </div>
            {!item.readAt && <Button size="sm" variant="ghost" onClick={() => void markRead(item.id)}>標為已讀</Button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
