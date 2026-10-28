import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Sparkles, Store, X } from 'lucide-react';

import { TOOL_CATALOG, TOOL_CATEGORIES, findTool, isToolReady } from '@/modules/tool-library/catalog';
import type { ToolCategory } from '@/modules/tool-library/catalog';
import { addPick, movePick, removePick } from '@/shared/customTools';
import type { Picks } from '@/shared/customTools';
import { cn } from '@/shared/utils';

type ToolLibraryProps = {
  isMobile: boolean;
  picks: Picks;
  onPicksChange: (picks: Picks) => void;
  onOpenTool: (id: string) => void;
  onOpenWishes: () => void;
  onClose: () => void;
};

/**
 * DHC CLI 10/14 工具庫: every tool as a card (規劃／資料與程式／產出); 加入自選 puts it in one of the person's five
 * 自選 slots, and the 我的自選 row on top orders or empties them. Tools still being built show as 製作中.
 */
export default function ToolLibrary({ isMobile, picks, onPicksChange, onOpenTool, onOpenWishes, onClose }: ToolLibraryProps) {
  const [category, setCategory] = useState<ToolCategory | '全部'>('全部');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const shown = TOOL_CATALOG.filter((tool) => category === '全部' || tool.category === category)
    .sort((a, b) => Number(isToolReady(b.id)) - Number(isToolReady(a.id)));

  const add = (id: string) => {
    const next = addPick(picks, id);
    if (!next) {
      setNotice('五格自選都滿了，先在上面「我的自選」拿掉一個。');
      return;
    }
    setNotice('');
    onPicksChange(next);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <button type="button" aria-label="關閉工具庫" onClick={onClose} className="absolute inset-0 bg-background/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-label="工具庫"
        className={cn('relative flex flex-col overflow-hidden border border-border bg-background shadow-xl', isMobile ? 'h-full w-full' : 'max-h-[88vh] w-[52rem] rounded-lg')}
      >
        <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3">
          <Store className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">工具庫</span>
          <button type="button" onClick={onClose} aria-label="關閉" className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <section aria-label="我的自選" className="mb-4">
            <p className="mb-2 text-xs font-semibold text-foreground">我的自選（右側「自選功能」滑過就會展開）</p>
            <div className="flex flex-wrap gap-2">
              {picks.map((id, index) => {
                const tool = findTool(id);
                if (!tool) {
                  return (
                    <div key={index} className="flex h-16 w-36 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                      空位 {index + 1}
                    </div>
                  );
                }
                const Icon = tool.icon;
                return (
                  <div key={index} className="flex h-16 w-36 flex-col justify-between rounded-lg border border-border px-2 py-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="truncate">{tool.name}</span>
                    </div>
                    <div className="flex items-center gap-0.5 text-muted-foreground">
                      <button type="button" onClick={() => onPicksChange(movePick(picks, index, -1))} disabled={index === 0} aria-label={`${tool.name} 往前`} className="rounded p-0.5 hover:bg-muted disabled:opacity-30">
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => onPicksChange(movePick(picks, index, 1))} disabled={index === picks.length - 1} aria-label={`${tool.name} 往後`} className="rounded p-0.5 hover:bg-muted disabled:opacity-30">
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => onPicksChange(removePick(picks, tool.id))} aria-label={`從自選拿掉 ${tool.name}`} className="ml-auto rounded px-1 text-[11px] hover:bg-muted hover:text-foreground">
                        拿掉
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {notice && <p className="mt-2 text-xs text-destructive">{notice}</p>}
          </section>

          <div className="mb-3 flex items-center gap-1 border-b border-border">
            {(['全部', ...TOOL_CATEGORIES] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setCategory(item)}
                className={cn('-mb-px border-b-2 px-3 py-1.5 text-xs', category === item ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
              >
                {item}
              </button>
            ))}
          </div>

          <div className={cn('grid gap-3', isMobile ? 'grid-cols-1' : 'grid-cols-2')}>
            {shown.map((tool) => {
              const Icon = tool.icon;
              const ready = isToolReady(tool.id);
              const picked = picks.includes(tool.id);
              return (
                <article key={tool.id} aria-label={tool.name} className={cn('flex flex-col rounded-lg border border-border p-3', !ready && 'opacity-60')}>
                  <div className="flex items-start gap-2">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold text-foreground">{tool.name}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tool.category}</span>
                        {!ready && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">製作中</span>}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{tool.summary}</p>
                    </div>
                  </div>
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-muted-foreground">
                    {tool.details.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                  <div className="mt-3 flex items-center justify-end gap-2">
                    {ready && (
                      <button type="button" onClick={() => onOpenTool(tool.id)} className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-muted">
                        打開
                      </button>
                    )}
                    {picked ? (
                      <button type="button" onClick={() => onPicksChange(removePick(picks, tool.id))} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted">
                        已在自選（拿掉）
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => add(tool.id)}
                        disabled={!ready}
                        className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        加入自選
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            沒有想要的工具？
            <button type="button" onClick={onOpenWishes} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-foreground hover:bg-muted">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              功能許願池
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
