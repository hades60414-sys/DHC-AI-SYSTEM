import { memo, useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';

import { formatClock } from '@/modules/chat/utils/messageTime';

/**
 * DHC CLI 對話跳轉: one dot per prompt on a rail along the transcript's right edge. Hovering a dot previews
 * the prompt; clicking scrolls to it. Rows are found by `data-jump-anchor`, which ChatMessagesPane puts on
 * each user row (the wrapper stays in the DOM even while the lazy row is unmounted).
 */
export type JumpPrompt = {
  key: string;
  text: string;
  timestamp: string | number | Date | undefined;
  /** DHC CLI Co-Work: a log card (share / leave) rather than a prompt — its own colour, not counted as a prompt. */
  kind?: 'cowork';
};

type ConversationJumpRailProps = {
  prompts: JumpPrompt[];
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** Older history is not loaded yet; the rail's top button loads it so its prompts get dots too. */
  onLoadEarlier?: () => void;
  isLoadingEarlier?: boolean;
};

const PREVIEW_CHARS = 90;

const findAnchor = (container: HTMLElement, key: string) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-jump-anchor]')).find((el) => el.dataset.jumpAnchor === key) ?? null;

const anchorTop = (container: HTMLElement, el: HTMLElement) =>
  el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;

function ConversationJumpRail({ prompts, scrollContainerRef, onLoadEarlier, isLoadingEarlier }: ConversationJumpRailProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  // The current prompt = the last one whose row starts above the top third of the viewport.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || prompts.length < 2) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = container.scrollTop + container.clientHeight / 3;
      let current: string | null = prompts[0]?.key ?? null;
      for (const prompt of prompts) {
        const el = findAnchor(container, prompt.key);
        if (el && anchorTop(container, el) <= line) current = prompt.key;
      }
      setActiveKey(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [prompts, scrollContainerRef]);

  const jumpTo = useCallback((key: string) => {
    const container = scrollContainerRef.current;
    const el = container ? findAnchor(container, key) : null;
    if (!container || !el) return;
    container.scrollTo({ top: Math.max(0, anchorTop(container, el) - 12), behavior: 'smooth' });
    // Rows that were placeholders mount on the way and change height; settle on the real position.
    for (const delay of [450, 900, 1500]) {
      window.setTimeout(() => {
        const settled = findAnchor(container, key);
        if (settled) container.scrollTo({ top: Math.max(0, anchorTop(container, settled) - 12) });
      }, delay);
    }
  }, [scrollContainerRef]);

  if (prompts.length < 2 && !onLoadEarlier) return null;

  return (
    <nav
      aria-label="對話跳轉"
      className="pointer-events-none absolute bottom-6 right-3 top-14 z-20 flex w-5 flex-col items-center"
    >
      <div className="pointer-events-auto relative flex h-full max-h-full w-full flex-col items-center justify-between overflow-visible py-1">
        <div className="absolute bottom-1 top-1 w-px bg-border/70" aria-hidden />
        {onLoadEarlier && (
          <button
            type="button"
            onClick={onLoadEarlier}
            disabled={isLoadingEarlier}
            title={isLoadingEarlier ? '載入中…' : '還有更早的提問，點這裡載入全部'}
            aria-label="載入更早的提問"
            className="relative z-10 mb-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-border bg-background text-[10px] leading-none text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {isLoadingEarlier ? '…' : '↑'}
          </button>
        )}
        {prompts.map((prompt, railIndex) => {
          const isCoWork = prompt.kind === 'cowork';
          // Prompts are numbered among themselves; Co-Work cards sit between them unnumbered.
          const index = prompts.slice(0, railIndex).filter((other) => other.kind !== 'cowork').length;
          const isActive = prompt.key === activeKey;
          const isHover = prompt.key === hoverKey;
          const preview = prompt.text.length > PREVIEW_CHARS ? `${prompt.text.slice(0, PREVIEW_CHARS)}…` : prompt.text;
          const time = prompt.timestamp ? formatClock(prompt.timestamp) : '';
          return (
            <div key={prompt.key} className="relative flex min-h-0 flex-1 items-center justify-center">
              <button
                type="button"
                onClick={() => jumpTo(prompt.key)}
                onMouseEnter={() => setHoverKey(prompt.key)}
                onMouseLeave={() => setHoverKey((current) => (current === prompt.key ? null : current))}
                onFocus={() => setHoverKey(prompt.key)}
                onBlur={() => setHoverKey((current) => (current === prompt.key ? null : current))}
                aria-label={isCoWork ? `跳到 Co-Work 紀錄：${preview}` : `跳到第 ${index + 1} 則提問：${preview}`}
                data-kind={prompt.kind ?? 'prompt'}
                className="relative flex h-3 w-5 items-center justify-center"
              >
                <span
                  className={`block rounded-full transition-all ${
                    isCoWork
                      ? (isActive || isHover ? 'h-2.5 w-2.5 rotate-45 rounded-[2px] bg-amber-500' : 'h-2 w-2 rotate-45 rounded-[2px] bg-amber-500/80')
                      : isActive
                        ? 'h-2.5 w-2.5 bg-foreground'
                        : isHover
                          ? 'h-2.5 w-2.5 bg-foreground/70'
                          : 'h-1.5 w-1.5 bg-muted-foreground/50'
                  }`}
                />
              </button>
              {isHover && (
                <div
                  role="tooltip"
                  className="absolute right-6 top-1/2 w-64 -translate-y-1/2 rounded-md border border-border bg-popover px-3 py-2 text-left text-xs leading-relaxed text-popover-foreground shadow-lg"
                >
                  <div className="mb-0.5 text-[10px] text-muted-foreground">
                    {isCoWork ? 'Co-Work 紀錄' : `第 ${index + 1} 則`}{time ? ` · ${time}` : ''}
                  </div>
                  <div className="line-clamp-3 break-words">{preview || '（附件）'}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

export default memo(ConversationJumpRail);
