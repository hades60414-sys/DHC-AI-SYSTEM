import { useRef, useState } from 'react';
import { Send } from 'lucide-react';

import { postToolSummary } from '@/shared/chatRoom';

export type SendItem = { label: string; disabled?: boolean; onPick: () => void };

/**
 * 10/25 R4 (稽核 P1-1): the two items every tool adds: 貼到聊天室… (waits in the chat's composer to be sent) and
 * 問團隊小助理 (sent to your private chat with it). Plain text: tool name, title and the first 1500 characters.
 */
export function chatItems(toolName: string, read: () => { title: string; body: string }, disabled = false, beforePick?: () => void): SendItem[] {
  const pick = (target: 'chat' | 'assistant') => {
    beforePick?.();
    const { title, body } = read();
    postToolSummary(target, toolName, title, body);
  };
  return [
    { label: '貼到聊天室…', disabled, onPick: () => pick('chat') },
    { label: '問團隊小助理', disabled, onPick: () => pick('assistant') },
  ];
}

/** DHC CLI 10/14 工具庫串接: the 「送到…」 button in a tool's header; the list is fixed-positioned so the header's scroll area does not clip it. */
export default function SendMenu({ items }: { items: SendItem[] }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          setAt(at || !rect ? null : { left: rect.left, top: rect.bottom + 4 });
        }}
        className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
      >
        <Send className="h-3.5 w-3.5" />
        送到…
      </button>
      {at && (
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setAt(null)} />
          <div role="menu" style={{ left: at.left, top: at.top }} className="fixed z-[71] min-w-40 rounded-md border border-border bg-background py-1 shadow-lg">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { setAt(null); item.onPick(); }}
                className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted disabled:opacity-40"
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
