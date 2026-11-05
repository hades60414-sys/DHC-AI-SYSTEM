import { useEffect, useMemo } from 'react';
import { Download } from 'lucide-react';

import ToolFrame from '@/modules/tool-library/ToolFrame';
import { SHARED_ICON } from '@/modules/tool-library/catalog';
import { PREVIEW_SANDBOX, buildSrcdoc, safeFileName } from '@/modules/tool-library/tools/workshopModel';
import { startSharedToolsSync, useSharedTools } from '@/shared/sharedTools';

type SharedToolWindowProps = {
  /** The listing id in 「已上架」 (dhc.sharedTools). */
  listingId: string;
  isMobile: boolean;
  onClose: () => void;
};

/** DHC CLI 10/22 上架: a published 小工具工坊 tool opened from 工具庫 or 自選, in the same network-free sandbox as the workshop preview. */
export default function SharedToolWindow({ listingId, isMobile, onClose }: SharedToolWindowProps) {
  const shared = useSharedTools();
  useEffect(() => startSharedToolsSync(), []);
  const item = shared.find((entry) => entry.id === listingId) ?? null;
  const srcDoc = useMemo(() => (item ? buildSrcdoc(item.html) : ''), [item]);

  const download = () => {
    if (!item) return;
    const url = URL.createObjectURL(new Blob([item.html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFileName(item.name)}.html`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ToolFrame
      icon={SHARED_ICON}
      title={item?.name ?? '已上架的工具'}
      profileName={item ? `${item.author || '匿名'} 上架` : ''}
      isMobile={isMobile}
      onClose={onClose}
      headerExtra={item && (
        <>
          <span className="truncate text-xs text-muted-foreground">{item.summary ?? ''}　{item.sharedAt.slice(0, 10)}</span>
          <button type="button" onClick={download} className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted">
            <Download className="h-3.5 w-3.5" />下載
          </button>
        </>
      )}
    >
      {item
        ? <iframe title={`工具：${item.name}`} sandbox={PREVIEW_SANDBOX} srcDoc={srcDoc} className="h-full w-full border-0 bg-white" />
        : <p className="p-6 text-sm text-muted-foreground">{shared.length === 0 ? '載入中…' : '這個工具已經下架了。'}</p>}
    </ToolFrame>
  );
}
