import { useEffect, useRef, useState } from 'react';
import { Blocks, ListTodo, Menu, MessageCircle, Settings, X } from 'lucide-react';

import { openChatPanel } from '@/shared/chatRoom';
import { requestRailOpen, useRailCount, useRailTotal } from '@/shared/mobileRail';

type RailItem = { key: string; label: string; Icon: typeof Menu; open: () => void };

// 從漢堡往左排：工具庫、待辦，最左邊是設定（右緣把手在手機已收掉，設定要有入口）。
// 聊天室在漢堡左邊有自己的鈕與未讀數（10-25 使用者要求：直屏也要看得到聊天室通知）。
export const MOBILE_RAIL_ITEMS: RailItem[] = [
  { key: 'library', label: '工具庫', Icon: Blocks, open: () => requestRailOpen('library') },
  { key: 'todo', label: '待辦', Icon: ListTodo, open: () => requestRailOpen('todo') },
  { key: 'settings', label: '快速設定', Icon: Settings, open: () => requestRailOpen('settings') },
];

/**
 * Rendered in the phone header's top-right (WorkspaceHeader / WorkspaceStateView): a 聊天室 button with its own unread
 * badge, then one hamburger that expands a row of items to its left (工具庫, 待辦, 設定 — nearest first). Tapping an item opens it and folds the row; tapping
 * outside or the hamburger again folds it too. Replaces the old floating round button and the right-edge handles.
 */
export default function MobileRailToggle() {
  const [open, setOpen] = useState(false);
  const chatUnread = useRailCount('chat');
  const total = useRailTotal() - chatUnread;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-auto flex flex-shrink-0 items-center gap-1.5">
      <button
        type="button"
        data-rail-chat
        onClick={() => {
          setOpen(false);
          openChatPanel();
        }}
        aria-label={chatUnread > 0 ? `聊天室（${chatUnread} 則未讀）` : '聊天室'}
        className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-border/50 bg-muted/50 text-foreground"
      >
        <MessageCircle className="h-5 w-5" />
        {chatUnread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-[1.1rem] text-white">
            {chatUnread > 99 ? '99+' : chatUnread}
          </span>
        )}
      </button>
      <button
        type="button"
        data-rail-toggle
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? '收起選單' : '選單（工具庫、待辦、快速設定）'}
        className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-border/50 bg-muted/50 text-foreground"
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        {!open && total > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-primary px-1 text-[10px] font-semibold leading-[1.1rem] text-primary-foreground">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          data-testid="mobile-rail-items"
          className="absolute right-full top-1/2 z-50 mr-1.5 flex -translate-y-1/2 flex-row-reverse items-center gap-1 rounded-xl border border-border/60 bg-card p-1 shadow-xl"
        >
          {MOBILE_RAIL_ITEMS.map(({ key, label, Icon, open: openItem }) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openItem();
              }}
              className="flex h-10 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs text-foreground hover:bg-muted"
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
