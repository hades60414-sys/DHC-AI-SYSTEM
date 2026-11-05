import { LayoutPanelLeft } from 'lucide-react';

import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import { useChatProjectId } from '@/modules/chat/context/ChatProjectContext';
import { openCanvas, setCanvasMode, useCanvasDocs, useCanvasMode, useCanvasState } from '@/modules/canvas/canvasStore';

/**
 * The composer's 畫布 button (like Gemini's Canvas toggle): on, every turn of this conversation asks Claude to deliver
 * pages for the canvas and opens it when one arrives. Beside it, while the panel is closed and this conversation has canvases, a chip reopens it.
 */
export default function CanvasComposerButton() {
  const projectId = useChatProjectId();
  const on = useCanvasMode();
  const { open } = useCanvasState();
  const docs = useCanvasDocs();
  if (!projectId) return null;
  return (
    <>
      <PromptInputButton
        tooltip={{ content: on ? '關閉畫布模式' : '畫布模式：請 Claude 把成果做成網頁，顯示在旁邊的畫布，可框選修改、存到白板' }}
        onClick={() => setCanvasMode(!on)}
        aria-pressed={on}
        aria-label="畫布模式"
        data-tutorial-tip="畫布模式：請 Claude 把成果做成網頁，顯示在旁邊的畫布"
        className={on ? 'w-auto gap-1 bg-sky-500/15 px-2 text-sky-600 hover:bg-sky-500/25 dark:text-sky-300' : undefined}
      >
        <LayoutPanelLeft />
        {on && <span className="text-xs font-medium">畫布</span>}
      </PromptInputButton>
      {!open && docs.length > 0 && (
        <PromptInputButton tooltip={{ content: '打開這個對話的畫布' }} onClick={() => openCanvas()} aria-label="打開畫布"
          className="w-auto gap-1 px-2 text-sky-600 dark:text-sky-300">
          <span className="text-xs font-medium">開啟畫布（{docs.length}）</span>
        </PromptInputButton>
      )}
    </>
  );
}
