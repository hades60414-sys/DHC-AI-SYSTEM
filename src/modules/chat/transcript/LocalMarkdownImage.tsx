import { useEffect, useState } from 'react';

import { useChatProjectId } from '@/modules/chat/context/ChatProjectContext';
import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';
import { api } from '@/shared/api';

/** 訊息裡的 Windows 絕對路徑圖片（![x](D:\a\b.png)）先改寫成這個前綴，避開 markdown 對空白、反斜線、冒號的處理。 */
export const LOCAL_IMAGE_PREFIX = 'dhc-local-image:';

const LOCAL_IMAGE_PATTERN = /!\[([^\]\n]*)\]\(\s*<?([A-Za-z]:[\\/][^\n>]*?\.(?:png|jpe?g|gif|webp|bmp))>?\s*\)/gi;

/** 只處理圖片副檔名的本機絕對路徑；http(s)／data: 等原樣不動。 */
export function rewriteLocalImages(text: string): string {
  if (!text || typeof text !== 'string' || !/[A-Za-z]:[\\/]/.test(text)) return text;
  return text.replace(
    LOCAL_IMAGE_PATTERN,
    (_match, alt: string, path: string) => `![${alt}](${LOCAL_IMAGE_PREFIX}${encodeURIComponent(path)})`,
  );
}

/** react-markdown 預設會把非白名單協定的網址清空，所以這個前綴要放行。 */
export const isLocalImageSrc = (src?: string): src is string => !!src && src.startsWith(LOCAL_IMAGE_PREFIX);

type LoadState = { kind: 'loading' } | { kind: 'ok'; url: string } | { kind: 'failed'; reason: string };

/**
 * 走既有的專案檔案端點（api.readFileBlob → /api/file-tree/projects/:id/files/content）；
 * 該端點要 Authorization 標頭，所以先 fetch 成 blob 再給 <img>。伺服器只放行專案根目錄底下的路徑。
 */
export default function LocalMarkdownImage({ src, alt }: { src: string; alt?: string }) {
  const projectId = useChatProjectId();
  const path = decodeURIComponent(src.slice(LOCAL_IMAGE_PREFIX.length));
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setState({ kind: 'failed', reason: '沒有對應的專案' });
      return undefined;
    }
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    (async () => {
      try {
        const response = await api.readFileBlob(projectId, path, { signal: controller.signal });
        if (!response.ok) {
          setState({
            kind: 'failed',
            reason: response.status === 403 ? '路徑在專案目錄之外' : response.status === 404 ? '找不到檔案' : `錯誤 ${response.status}`,
          });
          return;
        }
        objectUrl = URL.createObjectURL(await response.blob());
        setState({ kind: 'ok', url: objectUrl });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        setState({ kind: 'failed', reason: '讀取失敗' });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, path]);

  if (state.kind === 'failed') {
    return (
      <span className="my-1 block break-all rounded border border-dashed border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
        圖片無法顯示：{path}（{state.reason}）
      </span>
    );
  }
  if (state.kind === 'loading') {
    return <span className="my-1 block h-24 w-40 max-w-full animate-pulse rounded border border-border/50 bg-muted" aria-label="圖片載入中" />;
  }
  return (
    <>
      <button type="button" onClick={() => setExpanded(true)} aria-label={`放大圖片：${alt || path}`} className="my-1 block max-w-full cursor-zoom-in">
        <img src={state.url} alt={alt || path} className="h-auto max-w-full rounded border border-border/50" />
      </button>
      {expanded && <ImageLightbox src={state.url} alt={alt || path} onClose={() => setExpanded(false)} />}
    </>
  );
}
