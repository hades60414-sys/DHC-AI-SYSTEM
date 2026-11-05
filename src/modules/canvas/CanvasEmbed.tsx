import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { CANVAS_SANDBOX, withNetworkLock } from '@/modules/canvas/canvasBridge';

/**
 * A canvas saved to the whiteboard is an Excalidraw embeddable whose link points at the page stored in assets. The
 * board draws it with this frame instead of Excalidraw's own (whose sandbox allows same-origin, which would let the
 * page act as the person on this site). Matched by path, so a card made through the public address still works when
 * the board is opened on the host, and the other way round.
 */
const MARK = '#dhc-canvas';
const LINK = /\/api\/assets\/files\/([^/?#]+)#dhc-canvas$/;

export const canvasLinkOf = (storedName: string) => `${window.location.origin}/api/assets/files/${encodeURIComponent(storedName)}${MARK}`;

export function storedNameOfLink(link: string | null | undefined): string | null {
  const match = link ? LINK.exec(link) : null;
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export default function CanvasEmbed({ link, title }: { link: string; title?: string }) {
  const storedName = storedNameOfLink(link);
  const [page, setPage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!storedName) return undefined;
    let cancelled = false;
    api.assets.file(storedName)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((text) => { if (!cancelled) setPage(text); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [storedName]);

  if (!storedName || failed) {
    return <div className="flex h-full w-full items-center justify-center bg-muted text-xs text-muted-foreground">畫布讀不到（檔案可能已被清掉）</div>;
  }
  if (page === null) {
    return <div className="flex h-full w-full items-center justify-center bg-muted text-xs text-muted-foreground">畫布載入中…</div>;
  }
  return <iframe title={title ?? '畫布'} sandbox={CANVAS_SANDBOX} srcDoc={withNetworkLock(page)} className="h-full w-full border-0 bg-white" />;
}
