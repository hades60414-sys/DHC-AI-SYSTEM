import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Blocks, MessageSquare, Plus, Sparkles, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  addFeatureWish,
  removeFeatureWish,
  startFeatureWishesSync,
  useFeatureWishes,
  wishDiscussionPrompt,
} from '@/shared/featureWishes';
import { cn } from '@/shared/utils';

const DRAFT_STORAGE_KEY = 'dhc.wishDraft';
// Middle of the right-edge stack, between 待辦 and 版本更新 (TodoDock, ReleaseNotes).
const DESKTOP_HANDLE_STYLE: CSSProperties = { top: 'calc(90% - 46px)', transform: 'translateY(-50%)' };
const MOBILE_HANDLE_STYLE: CSSProperties = { bottom: 'calc(50% + 46px)' };

// 自選功能 fan: the person's five slots on an arc around the handle.
const FAN_RADIUS = 105;
const FAN_ANGLES = [-72, -36, 0, 36, 72];
// Reaches past the outer edge of the circles (radius + half a circle + margin).
const FAN_ZONE_RADIUS = FAN_RADIUS + 18 + 14;
const fanStyle = (index: number, isFanned: boolean): CSSProperties => {
  const angle = (FAN_ANGLES[index] * Math.PI) / 180;
  const x = -FAN_RADIUS * Math.cos(angle);
  const y = FAN_RADIUS * Math.sin(angle);
  return {
    transform: isFanned
      ? `translate(calc(${x}px - 50%), calc(${y}px - 50%)) scale(1)`
      : 'translate(-50%, -50%) scale(0.3)',
    opacity: isFanned ? 1 : 0,
    transitionDelay: isFanned ? `${index * 40}ms` : '0ms',
  };
};

type Draft = { title: string; description: string; author: string };
const EMPTY_DRAFT: Draft = { title: '', description: '', author: '' };

// Kept per browser so a detour into the discussion chat does not lose what was typed.
const readDraft = (): Draft => {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? 'null') as Partial<Draft> | null;
    return { ...EMPTY_DRAFT, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return EMPTY_DRAFT;
  }
};

const writeDraft = (draft: Draft) => {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage blocked: the draft lasts for this page load.
  }
};

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${date.getMonth() + 1}/${date.getDate()}`;
};

/** One 自選 slot as the fan shows it; null = empty. */
export type FanSlot = { id: string; name: string; icon: LucideIcon } | null;

type WishPoolProps = {
  isMobile: boolean;
  /** Opens a new chat with this text in the composer. */
  onDiscuss: (prompt: string) => void;
  /** The person's five 自選 slots. */
  slots: FanSlot[];
  onOpenTool: (id: string) => void;
  /** 工具庫: the handle itself and every empty slot open it. */
  onOpenLibrary: () => void;
  /** The 功能許願池 window (opened from 工具庫). */
  wishesOpen: boolean;
  onWishesOpenChange: (open: boolean) => void;
};

/**
 * DHC CLI 自選功能: a right-edge handle that, hovered, turns into a half circle and fans out the person's five
 * 自選 slots (10/14). Clicking the handle opens 工具庫; an empty slot says 新增自選 and opens 工具庫 too.
 * 功能許願池 (the form and everyone's wishes) opens from 工具庫.
 */
export default function WishPool({ isMobile, onDiscuss, slots, onOpenTool, onOpenLibrary, wishesOpen: isOpen, onWishesOpenChange: setIsOpen }: WishPoolProps) {
  useEffect(() => startFeatureWishesSync(), []);
  const wishes = useFeatureWishes();
  const [isFanned, setIsFanned] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const [draft, setDraft] = useState<Draft>(readDraft);

  // The circles sit apart, so leaving one must not fold the fan before the pointer reaches the next.
  const keepFan = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setIsFanned(true);
  };
  const foldFanSoon = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setIsFanned(false), 250);
  };
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  const openLibrary = () => {
    setIsFanned(false);
    onOpenLibrary();
  };

  useEffect(() => {
    if (!isOpen && !isFanned) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      setIsFanned(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen, isFanned, setIsOpen]);

  const update = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    writeDraft(next);
  };
  const submit = () => {
    if (!addFeatureWish(draft)) return;
    // The name is kept for the next wish; the wish itself is done.
    update({ title: '', description: '' });
  };
  const discuss = () => {
    onDiscuss(wishDiscussionPrompt(draft));
    setIsOpen(false);
  };
  const remove = (id: string, title: string) => {
    if (window.confirm(`刪除「${title}」這個願望？`)) removeFeatureWish(id);
  };

  const inputClass = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary';

  return (
    <>
      <div
        className="fixed right-0 z-[51] flex items-center justify-end"
        style={isMobile ? MOBILE_HANDLE_STYLE : DESKTOP_HANDLE_STYLE}
        onMouseEnter={isMobile ? undefined : keepFan}
        onMouseLeave={isMobile ? undefined : foldFanSoon}
      >
        <button
          type="button"
          // Phones have no hover: the first tap fans the slots out, the next opens 工具庫.
          onClick={() => (isMobile && !isFanned ? keepFan() : openLibrary())}
          aria-label="自選功能"
          aria-expanded={isFanned}
          title={isFanned ? undefined : '自選功能（點一下打開工具庫）'}
          className={cn(
            'flex items-center justify-center border border-gray-200 bg-white text-gray-600 shadow-lg transition-all duration-200 ease-out hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
            isFanned ? 'h-16 w-8 rounded-l-full border-r-0 pl-1 text-primary dark:text-primary' : 'h-[38px] w-[38px] rounded-l-md',
          )}
        >
          <Blocks className={cn('transition-all duration-200', isFanned ? 'h-4 w-4' : 'h-5 w-5')} />
        </button>

        {/* While fanned, the whole half disc behind the circles counts as hovering, so the gaps between them never fold it. */}
        {isFanned && !isMobile && (
          <div
            data-testid="custom-fan-zone"
            className="absolute right-8 top-1/2 rounded-l-full"
            style={{ width: FAN_ZONE_RADIUS - 32, height: FAN_ZONE_RADIUS * 2, transform: 'translateY(-50%)' }}
          />
        )}

        {/* Circles hang off the handle's flat edge (the screen edge), centered on it. */}
        <div className="pointer-events-none absolute right-0 top-1/2 h-0 w-0" aria-hidden={!isFanned}>
          {FAN_ANGLES.map((_, index) => {
            const slot = slots[index] ?? null;
            const Icon = slot?.icon ?? Plus;
            const label = slot ? slot.name : '新增自選';
            return (
              <button
                key={index}
                type="button"
                tabIndex={isFanned ? 0 : -1}
                onClick={slot ? () => { setIsFanned(false); onOpenTool(slot.id); } : openLibrary}
                aria-label={slot ? slot.name : `自選位置 ${index + 1}（空）：新增自選`}
                className={cn(
                  'group absolute left-0 top-0 flex h-9 w-9 items-center justify-center rounded-full border shadow-lg transition-all duration-200 ease-out',
                  isFanned ? 'pointer-events-auto' : 'pointer-events-none',
                  slot
                    ? 'border-gray-200 bg-white text-primary hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700'
                    : 'border-dashed border-gray-300 bg-white text-gray-400 hover:border-primary hover:text-primary dark:border-gray-600 dark:bg-gray-800 dark:text-gray-500',
                )}
                style={fanStyle(index, isFanned)}
              >
                <Icon className="h-4 w-4" />
                <span className="pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <button
            type="button"
            aria-label="關閉功能許願池"
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 bg-background/60 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-label="功能許願池"
            className={cn(
              'relative flex flex-col overflow-hidden border border-border bg-background shadow-xl',
              isMobile ? 'h-full w-full' : 'max-h-[85vh] w-[34rem] rounded-lg',
            )}
          >
            <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">功能許願池</span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="關閉"
                className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                任何 AI 相關的願望都可以許：介面功能、內部資料自動彙整報告、電腦操作自動化等；不知道怎麼寫，按「跟 DHC CLI 討論」。
              </p>

              <div className="space-y-2">
                <input
                  aria-label="主題"
                  placeholder="主題（必填）"
                  value={draft.title}
                  onChange={(event) => update({ title: event.target.value })}
                  className={inputClass}
                />
                <textarea
                  aria-label="描述"
                  placeholder="描述：想在什麼情況下做到什麼？"
                  value={draft.description}
                  onChange={(event) => update({ description: event.target.value })}
                  rows={4}
                  className={cn(inputClass, 'resize-y')}
                />
                <input
                  aria-label="署名"
                  placeholder="署名（留空＝匿名）"
                  value={draft.author}
                  onChange={(event) => update({ author: event.target.value })}
                  className={inputClass}
                />
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={discuss}
                    className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-muted"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    跟 DHC CLI 討論
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!draft.title.trim()}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    許願
                  </button>
                </div>
              </div>

              <div className="mt-4 border-t border-border pt-3">
                <p className="mb-2 text-xs font-semibold text-foreground">大家的願望（{wishes.length}）</p>
                {wishes.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground">還沒有人許願。</p>
                ) : (
                  <ul className="space-y-2">
                    {wishes.map((wish) => (
                      <li key={wish.id} className="group rounded-md border border-border/60 px-2.5 py-2">
                        <div className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{wish.title}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {wish.author || '匿名'} · {formatDate(wish.createdAt)}
                          </span>
                          <button
                            type="button"
                            onClick={() => remove(wish.id, wish.title)}
                            aria-label={`刪除 ${wish.title}`}
                            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground hover:opacity-100"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {wish.description && (
                          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{wish.description}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
