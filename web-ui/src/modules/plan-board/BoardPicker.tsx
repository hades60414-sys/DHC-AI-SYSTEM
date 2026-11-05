import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Pencil } from 'lucide-react';

import type { PlanBoard } from '@/shared/planBoards';
import { cn } from '@/shared/utils';

/** A second click within this long of the first is a double click (the browser's own `detail` can be stricter). */
const DOUBLE_CLICK_MS = 400;
const MENU_WIDTH = 256;
const MENU_MARGIN = 8;

/**
 * 11/01: which board is open. A click opens the list, a double click renames in place; 「＋ 新白板」 is the last item.
 * Replaces the native select, which cannot tell a double click from opening its list.
 * 11/01: the list opens only after the double-click window (400 ms) so the second click never lands on its backdrop; each
 * row has a ✎ for renaming without timing; the list is placed with `fixed` and clamped inside a narrow window.
 */
export default function BoardPicker({ boards, active, naming, onPick, onCreate, onStartRename, onRename }: {
  boards: PlanBoard[];
  active: PlanBoard | null;
  naming: boolean;
  onPick: (id: string) => void;
  onCreate: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
}) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const clickTimer = useRef<number | null>(null);
  const lastClick = useRef(0);
  useEffect(() => () => { if (clickTimer.current !== null) window.clearTimeout(clickTimer.current); }, []);
  const close = () => setMenu(null);
  const openMenu = () => {
    const box = button.current?.getBoundingClientRect();
    const left = Math.max(MENU_MARGIN, Math.min(box?.left ?? 0, window.innerWidth - MENU_WIDTH - MENU_MARGIN));
    setMenu((current) => (current ? null : { left, top: (box?.bottom ?? 0) + 4 }));
  };

  if (naming && active) {
    return (
      <input
        autoFocus
        aria-label="白板名稱"
        defaultValue={active.autoName ? '' : active.name}
        placeholder="幫白板取名（留空會自動取名）"
        onFocus={(event) => event.target.select()}
        onBlur={(event) => onRename(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
          if (event.key === 'Escape') { event.currentTarget.value = ''; event.currentTarget.blur(); }
        }}
        className="w-56 min-w-0 max-w-full rounded-md border border-primary bg-background px-2 py-1 text-xs text-foreground outline-none"
      />
    );
  }
  return (
    <div className="relative min-w-0">
      <button
        ref={button}
        type="button"
        aria-label="選擇白板"
        aria-expanded={menu !== null}
        title="按一下換白板，連按兩下改名"
        data-tutorial-tip="按一下換白板、開新白板；連按兩下改名"
        onClick={(event) => {
          if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
          clickTimer.current = null;
          const now = Date.now();
          const again = event.detail >= 2 || now - lastClick.current < DOUBLE_CLICK_MS;
          lastClick.current = now;
          if (again) {
            lastClick.current = 0;
            close();
            if (active) onStartRename();
            return;
          }
          clickTimer.current = window.setTimeout(() => { clickTimer.current = null; openMenu(); }, DOUBLE_CLICK_MS);
        }}
        className="flex max-w-[14rem] min-w-0 items-center gap-1 max-md:max-w-[36vw] rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
      >
        <span className="truncate">{active ? (active.co ? `👥 ${active.name}` : active.name) : '選擇白板'}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            role="listbox"
            aria-label="白板清單"
            style={{ left: menu.left, top: menu.top }}
            className="fixed z-50 max-h-[60vh] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-background py-1 text-sm shadow-xl"
          >
            {boards.map((board) => (
              <div key={board.id} className={cn('flex items-center', board.id === active?.id ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted')}>
                <button
                  type="button"
                  role="option"
                  aria-selected={board.id === active?.id}
                  onClick={() => { close(); onPick(board.id); }}
                  className="min-w-0 flex-1 truncate px-3 py-1.5 text-left"
                >
                  {board.co ? `👥 ${board.name}` : board.name}
                </button>
                <button
                  type="button"
                  aria-label={`改名：${board.name}`}
                  title="改名"
                  onClick={() => { close(); onPick(board.id); onStartRename(); }}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded opacity-70 hover:opacity-100"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="my-1 border-t border-border" />
            <button type="button" onClick={() => { close(); onCreate(); }} className="block w-full px-3 py-1.5 text-left text-foreground hover:bg-muted">
              ＋ 新白板
            </button>
          </div>
        </>
      )}
    </div>
  );
}
