import { useState } from 'react';
import { AtSign, Check, MessageCircle } from 'lucide-react';

import { REF_DRAG_TYPE, clipLabel, openChatPanel, roomOfBoard, roomOfSession, useChatPanel, useMyMentions } from '@/shared/chatRoom';
import type { ChatRef } from '@/shared/chatRoom';
import { cn } from '@/shared/utils';

/** A soft red dot (not alarming) where someone mentioned you; the count is in the tooltip. */
export function MentionDot({ count, className, label = '有人提到你' }: { count: number; className?: string; label?: string }) {
  if (count <= 0) return null;
  return (
    <span
      role="status"
      aria-label={`${label}（${count}）`}
      title={`${label}（${count}）`}
      data-testid="mention-dot"
      className={cn('block h-2 w-2 rounded-full bg-rose-400/75 shadow-[0_0_0_3px_rgba(251,113,133,0.15)]', className)}
    />
  );
}

/** Unread mentions of you on a session or whiteboard (its room plus its sticky notes). */
export function useMentionCount(kind: 'session' | 'board', id: string | null | undefined): number {
  const mentions = useMyMentions();
  return id ? mentions.get(kind === 'session' ? roomOfSession(id) : roomOfBoard(id)) ?? 0 : 0;
}

/**
 * Beside a title: click copies `@@title` to paste anywhere; drag it into a sticky note or the chat room to tag
 * (or share) this session or whiteboard.
 */
export function CopyNameButton({ chip: full, className }: { chip: ChatRef; className?: string }) {
  const chip = { ...full, label: clipLabel(full.label) };
  const [copied, setCopied] = useState(false);
  const token = `${chip.kind === 'person' ? '@' : '@@'}${chip.label}`;
  return (
    <button
      type="button"
      draggable
      aria-label="複製名稱"
      title={`複製「${token}」；也可以直接拖進便利貼或聊天室標記它`}
      onDragStart={(event) => {
        event.dataTransfer.setData(REF_DRAG_TYPE, JSON.stringify(chip));
        event.dataTransfer.setData('text/plain', token);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => {
        void navigator.clipboard?.writeText(token).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn('inline-flex h-6 w-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/70 transition hover:bg-muted hover:text-foreground active:cursor-grabbing', className)}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <AtSign className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Opens the chat room on this session's or whiteboard's own room; shows a soft dot when you were mentioned here. */
export function ChatRoomButton({ kind, id, className }: { kind: 'session' | 'board'; id: string; className?: string }) {
  const count = useMentionCount(kind, id);
  const { open } = useChatPanel();
  const room = kind === 'session' ? roomOfSession(id) : roomOfBoard(id);
  return (
    <button
      type="button"
      aria-label={kind === 'session' ? '這個對話的聊天室' : '這張白板的聊天室'}
      data-tutorial-tip={kind === 'session' ? '這個對話的聊天室：和參與的人留話，@ 標記同事' : '這張白板的聊天室：和參與的人留話'}
      title={kind === 'session' ? '這個對話的聊天室：和參與的人留話、@ 標記' : '這張白板的聊天室'}
      onClick={() => openChatPanel(room)}
      className={cn('relative inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground', open && 'text-foreground', className)}
    >
      <MessageCircle className="h-3.5 w-3.5" />
      <MentionDot count={count} className="absolute right-0.5 top-0.5 h-1.5 w-1.5" />
    </button>
  );
}
