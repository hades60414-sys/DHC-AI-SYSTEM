import { useRef, useState } from 'react';
import { Send } from 'lucide-react';

export type SendItem = { label: string; disabled?: boolean; onPick: () => void };

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
