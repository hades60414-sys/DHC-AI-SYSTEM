import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { setRailCount } from '@/shared/mobileRail';
import { useIsTeamMode } from '@/shared/dhcConfig';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUpRight, AtSign, Bot, Loader2, Megaphone, MessageCircle, MessageSquare, Plus, RotateCcw, Send, ShieldAlert, SmilePlus, Square, Trash2, Users, Workflow, X } from 'lucide-react';

import { isQueryProject, isRoutineProject, isWorkspaceProject } from '@/modules/sidebar';
import WhoAmI from '@/modules/sidebar/WhoAmI';
import { BotFace, PersonAvatar } from '@/modules/user-avatar';
import { isFlashProject } from '@/shared/flashTasks';
import { useBoardInvites } from '@/shared/coBoards';
import type { BoardInvite } from '@/shared/coBoards';
import { readCoSession, setCoSessionMembers, useCoLogs, useCoPeople, useCoSessions } from '@/shared/coSessions';
import type { Project } from '@/shared/types';
import { resolveSettingsProjectId } from '@/shared/userSettings';
import {
  ASSISTANT_ID,
  ASSISTANT_MENTION,
  ASSISTANT_MENTIONS,
  ASSISTANT_NAME,
  LOBBY,
  announcementKey,
  announcementUnread,
  askAssistant,
  askIfCalled,
  botSpeaker,
  callsAssistant,
  closeChatPanel,
  deleteChatMessage,
  dismissBusy,
  dmPeer,
  dmRoom,
  isAnnouncement,
  loadBots,
  markSeen,
  mentionsAssistant,
  openChatPanel,
  openToolName,
  pressAssistantCard,
  recentContacts,
  requestOpenLibrary,
  requestOpenTool,
  retryAssistant,
  retryBusy,
  retryChatMessage,
  roomOfBoard,
  roomOfSession,
  sendChatMessage,
  setChatMe,
  stopAssistant,
  startChatSync,
  takeChatDraft,
  toggleReaction,
  unreadDirect,
  unreadLights,
  useChatDraft,
  useChatMe,
  useChatPanel,
  useChatState,
  useMyMentions,
  useAssistantBusy,
  useAssistantCards,
  useAssistantNext,
  loadAssistantExamples,
  useAssistantStep,
  useAssistantTrail,
  useAssistantThinking,
  useBots,
  useRoom,
} from '@/shared/chatRoom';
import type { AssistantCardStatus, ChatContext, ChatMessage, ChatRef } from '@/shared/chatRoom';
import { useEscapeClose } from '@/shared/escapeStack';
import { cn } from '@/shared/utils';

import MyBots from '@/modules/chat-room/MyBots';
import { readRoomDraft, writeRoomDraft } from '@/modules/chat-room/roomDrafts';
import { TOOL_CATALOG, isToolReady } from '@/modules/tool-library/catalog';
import { FileButtons, MessageFiles, PendingFiles, fileHandlers, useComposerFiles } from '@/modules/chat-room/files';
import { MemberAvatar, RefIcon, RefInput, RefText, carriesRef, readDroppedRef, setRefCandidates, shortTime, usePerson, useRefAction } from '@/modules/chat-room/refs';
import { Markdown } from '@/modules/chat/transcript/Markdown';

// Bottom of the right-edge stack, under 待辦 and 自選功能 (TodoDock, WishPool).
const DESKTOP_HANDLE_STYLE: CSSProperties = { top: '90%', transform: 'translateY(-50%)' };
const MOBILE_HANDLE_STYLE: CSSProperties = { bottom: 'calc(50% - 46px)' };
// 10/27: on desktop the panel docks like 今日待辦 (full height, 18.5rem, squeezes the page); its left edge drags wider, remembered per device.
// 0 = never dragged; CSS keeps it between 18.5rem and 60vw.
const PANEL_WIDTH_KEY = 'dhc.chatRoomWidth';
const panelWidth = (px: number) => `clamp(18.5rem, ${px}px, 60vw)`;
const readPanelWidth = () => {
  try {
    return Math.max(0, Number(localStorage.getItem(PANEL_WIDTH_KEY)) || 0);
  } catch {
    return 0;
  }
};
// 10/22 hover fan: 團隊小助理 on top, then the two people you last chatted with privately.
// 10/28: a wide arc out to the left of the handle centre; circles and hover zone stay left of the rail, so the 工具庫 handle above stays clickable.
// Shallow enough that the lowest circle clears the taskbar on short laptop screens.
const FAN_RADIUS = 85;
const FAN_ANGLES = [-36, 0, 36];
const FAN_ORIGIN_X = 17;
// Hover zone left of the rail: spans the circles plus a margin, never over the handles themselves.
const FAN_ZONE = { right: 37, width: 101, top: -78, height: 156 };
const fanStyle = (index: number, isFanned: boolean): CSSProperties => {
  const angle = (FAN_ANGLES[index] * Math.PI) / 180;
  const x = -FAN_ORIGIN_X - FAN_RADIUS * Math.cos(angle);
  const y = FAN_RADIUS * Math.sin(angle);
  return {
    transform: isFanned ? `translate(calc(${x}px - 50%), calc(${y}px - 50%)) scale(1)` : `translate(calc(${-FAN_ORIGIN_X}px - 50%), -50%) scale(0.3)`,
    opacity: isFanned ? 1 : 0,
    transitionDelay: isFanned ? `${index * 40}ms` : '0ms',
  };
};
const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀'];

const isPersonProject = (project: Project) => (
  isWorkspaceProject(project) && !isQueryProject(project) && !isRoutineProject(project) && !isFlashProject(project)
);
const sessionLabel = (session: { summary?: unknown; name?: unknown; title?: unknown }) => (
  [session.summary, session.name, session.title].find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? '新對話'
);

/** The people who can see a session or whiteboard; null when unknown (anyone mentioned is fine). */
function participantsOf(context: ChatContext): string[] | null {
  if (context.kind === 'session') {
    const shared = readCoSession(context.id);
    if (shared) return [shared.ownerProjectId, ...shared.members];
    return context.ownerProjectId ? [context.ownerProjectId] : null;
  }
  return context.members ?? null;
}

/** The mentioned people who are not in the session's (or board's) Co-Work yet. */
export function outsiders(context: ChatContext | null, refs: ChatRef[]): ChatRef[] {
  if (!context) return [];
  const inside = participantsOf(context);
  if (!inside) return [];
  return refs.filter((ref) => ref.kind === 'person' && !inside.includes(ref.id));
}

/** Asks to bring mentioned people into the Co-Work, so they can actually open what they were tagged in. */
export function InviteOffer({ context, people: offered, message, onDone }: { context: ChatContext; people: ChatRef[]; message: string; onDone: () => void }) {
  const me = useChatMe();
  const names = offered.map((ref) => ref.label).join('、');
  const invite = () => {
    if (context.kind === 'session' && me) {
      const shared = readCoSession(context.id);
      const owner = shared?.ownerProjectId ?? context.ownerProjectId ?? me;
      const members = Array.from(new Set([...(shared?.members ?? []), ...offered.map((ref) => ref.id)]));
      void setCoSessionMembers(context.id, { ownerProjectId: owner, title: shared?.title || context.title, provider: (shared?.provider ?? context.provider ?? 'claude') as never }, members, { from: me, message });
    }
    onDone();
  };
  return (
    <div role="alert" className="flex items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
      <Users className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{names} 不在這個 Co-Work，看不到這裡。{context.kind === 'board' && '（白板請用上方 Co-Work 鈕邀請）'}</span>
      {context.kind === 'session' && (
        <button type="button" onClick={invite} className="shrink-0 rounded-md bg-amber-500 px-2 py-0.5 font-medium text-white hover:bg-amber-600">邀請加入</button>
      )}
      <button type="button" onClick={onDone} className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-amber-500/15">不用</button>
    </div>
  );
}

function ShareCard({ share }: { share: ChatRef }) {
  const act = useRefAction();
  const Icon = share.kind === 'session' ? MessageSquare : Workflow;
  return (
    <button
      type="button"
      onClick={() => act(share)}
      className="group/card mt-2 flex w-full items-center gap-3 rounded-xl border border-border bg-gradient-to-br from-violet-500/[0.07] via-transparent to-sky-500/[0.07] p-2.5 text-left transition hover:border-violet-400/60 hover:shadow-md"
    >
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm', share.kind === 'session' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500' : 'bg-gradient-to-br from-emerald-500 to-teal-500')}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{share.kind === 'session' ? '對話' : '白板'}</span>
        <span className="block truncate text-sm font-medium text-foreground">{share.label}</span>
      </span>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5 group-hover/card:text-violet-500" />
    </button>
  );
}

function Reactions({ roomId, message }: { roomId: string; message: ChatMessage }) {
  const me = useChatMe();
  const people = useCoPeople();
  const [picking, setPicking] = useState(false);
  const entries = Object.entries(message.reactions ?? {});
  if (!me) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, who]) => (
        <button
          key={emoji}
          type="button"
          title={who.map((id) => people.get(id)?.name ?? '?').join('、')}
          onClick={() => toggleReaction(roomId, message.id, emoji, me)}
          className={cn('flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] transition', who.includes(me) ? 'border-sky-400/60 bg-sky-500/10' : 'border-border hover:bg-muted')}
        >
          <span>{emoji}</span>
          <span className="tabular-nums text-muted-foreground">{who.length}</span>
        </button>
      ))}
      <span className="relative">
        <button type="button" aria-label="加表情" onClick={() => setPicking((open) => !open)} className="rounded-full p-0.5 text-muted-foreground/60 opacity-0 transition hover:bg-muted hover:text-foreground group-hover/msg:opacity-100">
          <SmilePlus className="h-3.5 w-3.5" />
        </button>
        {picking && (
          <span className="absolute bottom-full left-0 z-20 mb-1 flex gap-0.5 rounded-full border border-border bg-popover px-1 py-0.5 shadow-lg">
            {REACTIONS.map((emoji) => (
              <button key={emoji} type="button" onClick={() => { toggleReaction(roomId, message.id, emoji, me); setPicking(false); }} className="rounded-full px-1 text-sm transition hover:scale-125">
                {emoji}
              </button>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

const CARD_STATUS: Record<AssistantCardStatus, { label: string; style: string }> = {
  pending: { label: '等人按', style: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  running: { label: '執行中…', style: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  done: { label: '已執行', style: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  failed: { label: '沒執行成', style: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
  rejected: { label: '已取消', style: 'bg-muted text-muted-foreground' },
  expired: { label: '已過期', style: 'bg-muted text-muted-foreground' },
};

/** Under a 團隊小助理 reply: the actions it held (執行／取消, whole content on demand) and 重試 when it failed. */
function AssistantExtras({ roomId, message }: { roomId: string; message: ChatMessage }) {
  const me = useChatMe();
  const cards = useAssistantCards(roomId).filter((card) => card.messageId === message.id);
  const [pressing, setPressing] = useState<string | null>(null);
  const [pressNote, setPressNote] = useState('');
  // 10/25 R4: the second step of 執行／建立／同意 is a line in the card (確定／先不要), not window.confirm.
  const [asking, setAsking] = useState<string | null>(null);
  const failed = message.failed || message.text.startsWith('這次沒回成：');
  if (message.by !== ASSISTANT_ID || (cards.length === 0 && !failed)) return null;
  const press = async (cardId: string, decision: 'approve' | 'reject') => {
    if (!me || pressing) return;
    setAsking(null);
    setPressing(cardId);
    setPressNote('');
    try {
      setPressNote((await pressAssistantCard(roomId, cardId, decision, me)) ?? '');
    } finally {
      setPressing(null);
    }
  };
  return (
    <div className="mt-2 flex w-full flex-col gap-1.5" data-testid="assistant-cards">
      {cards.map((card) => (
        <div key={card.id} className={cn('rounded-xl border p-2 text-xs text-foreground', card.kind === 'patrol' ? 'border-green-400/60 bg-green-50/70 dark:border-green-500/30 dark:bg-green-500/10' : 'border-amber-300/70 bg-amber-50/70 dark:border-amber-400/30 dark:bg-amber-500/10')}>
          <div className="flex items-start gap-1.5">
            <ShieldAlert className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', card.kind === 'patrol' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-300')} />
            <span className="min-w-0 flex-1 break-all font-medium">{card.summary}</span>
            <span className={cn('shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold', CARD_STATUS[card.status]?.style)}>{card.kind === 'patrol' && card.status === 'done' ? '已建立' : card.kind === 'borrow' && card.status === 'done' ? '已同意' : card.kind === 'borrow' && card.status === 'rejected' ? '已拒絕' : CARD_STATUS[card.status]?.label ?? card.status}</span>
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">完整內容</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 p-1.5 text-[11px]">{card.detail}</pre>
          </details>
          {card.status === 'pending' && me && asking === card.id && (
            <div role="alertdialog" aria-label="確認" data-testid="card-confirm" className="mt-1.5 rounded-lg border border-border bg-background/80 p-1.5">
              <div className="mb-1.5 text-[11px] text-foreground">{card.summary.startsWith('建立巡查') ? '確定建立這個巡查？' : card.kind === 'borrow' ? '確定借他用？他的問題會在原房間得到回答。' : `確定讓${ASSISTANT_NAME}執行？`}</div>
              <div className="flex gap-1.5">
                <button type="button" disabled={pressing !== null} onClick={() => void press(card.id, 'approve')} className={cn('rounded-md px-2.5 py-1 font-semibold text-white transition disabled:opacity-50', card.kind === 'patrol' ? 'bg-green-500 hover:bg-green-600' : 'bg-amber-500 hover:bg-amber-600')}>確定</button>
                <button type="button" onClick={() => setAsking(null)} className="rounded-md border border-border bg-background px-2.5 py-1 text-muted-foreground transition hover:text-foreground">先不要</button>
              </div>
            </div>
          )}
          {card.status === 'pending' && me && asking !== card.id && (
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" disabled={pressing !== null} onClick={() => setAsking(card.id)} className={cn('rounded-md px-2.5 py-1 font-semibold text-white transition disabled:opacity-50', card.kind === 'patrol' ? 'bg-green-500 hover:bg-green-600' : 'bg-amber-500 hover:bg-amber-600')}>
                {pressing === card.id ? '送出中…' : card.kind === 'patrol' ? '建立' : card.kind === 'borrow' ? '同意' : '執行'}
              </button>
              <button type="button" disabled={pressing !== null} onClick={() => void press(card.id, 'reject')} className="rounded-md border border-border bg-background px-2.5 py-1 text-muted-foreground transition hover:text-foreground disabled:opacity-50">
                {card.kind === 'borrow' ? '拒絕' : '取消'}
              </button>
            </div>
          )}
          {card.by && card.status !== 'pending' && (
            <div className="mt-1 text-[11px] text-muted-foreground">{card.by}{card.doneAt ? ` · ${shortTime(card.doneAt)}` : ''}</div>
          )}
        </div>
      ))}
      {pressNote && <div role="status" data-testid="card-note" className="text-[11px] text-rose-600 dark:text-rose-300">{pressNote}</div>}
      {failed && me && (
        <button type="button" onClick={() => retryAssistant(roomId, message, me)} className="inline-flex w-fit items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition hover:text-foreground">
          <RotateCcw className="h-3 w-3" />重試
        </button>
      )}
    </div>
  );
}

// Reports from the assistant carry tables, headings and lists; plain chat stays plain.
const looksLikeMarkdown = (text: string) => /^\s*\|.*\|\s*$/m.test(text) || /^#{1,6}\s/m.test(text) || /^\s*([-*]|\d+\.)\s/m.test(text) || /\*\*[^*]+\*\*/.test(text);
const COMPACT_PROSE = 'prose prose-sm max-w-none text-foreground dark:prose-invert prose-p:my-1 prose-headings:mb-1 prose-headings:mt-2 [&_table]:text-xs [&_td]:px-2 [&_td]:py-1 [&_th]:whitespace-nowrap [&_th]:px-2 [&_th]:py-1 [overflow-wrap:anywhere] [&_code]:!whitespace-pre-wrap [&_pre]:!whitespace-pre-wrap';

/** Message text: markdown when it has no chips and looks formatted, otherwise text with chips. */
function MessageText({ message, className }: { message: ChatMessage; className?: string }) {
  if (message.refs.length === 0 && looksLikeMarkdown(message.text)) {
    return <Markdown className={cn(COMPACT_PROSE, className)} breaks>{message.text}</Markdown>;
  }
  return <RefText text={message.text} refs={message.refs} className={className} />;
}

/**
 * 10/25 R4 (稽核 P1-4): a 【巡查】 post folded to its title line and its conclusion (the report's first line, without
 * markdown marks); null when there is nothing more to fold.
 */
export function patrolHead(text: string): string | null {
  if (!text.startsWith('【巡查】')) return null;
  const [title, ...rest] = text.split('\n');
  const body = rest.map((line) => line.trim()).filter(Boolean);
  if (body.length <= 1) return null;
  const conclusion = body[0].replace(/^#{1,6}\s+|^[-*]\s+|^>\s*/, '').replace(/\*\*/g, '').replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, '｜');
  return `${title}\n${conclusion}`;
}

/** 11/01: a message whose save failed: kept on this device and marked until 重試 gets it through. */
function UnsentBar({ roomId, message }: { roomId: string; message: ChatMessage }) {
  if (!message.unsent) return null;
  return (
    <div role="status" data-testid="unsent" className="flex items-center gap-2 px-1 text-[11px] text-destructive">
      <span>未送出</span>
      <button type="button" onClick={() => retryChatMessage(roomId, message.id)} className="inline-flex items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 hover:bg-destructive/10">
        <RotateCcw className="h-3 w-3" />重試
      </button>
      <button type="button" onClick={() => deleteChatMessage(roomId, message.id)} className="hover:underline">放棄</button>
    </div>
  );
}

/** One post in 動態: avatar, name, time, text with chips, the shared card, reactions. */
/** 11/04 AI 辦公室: who wrote a message (a helper by the 【name】 in front of its answer), its face, and the text without that name. */
function useSpeaker(message: ChatMessage): { name: string; face: string | null; shown: ChatMessage } {
  const person = usePerson(message.by);
  const { faces } = useBots();
  const speaker = message.by === ASSISTANT_ID ? botSpeaker(message.text, faces) : null;
  if (speaker === null) return { name: person.name, face: null, shown: message };
  return { name: speaker, face: faces[speaker], shown: { ...message, text: message.text.slice(speaker.length + 2).trimStart() } };
}

function Post({ roomId, message }: { roomId: string; message: ChatMessage }) {
  const me = useChatMe();
  const head = message.by === ASSISTANT_ID ? patrolHead(message.text) : null;
  const [unfolded, setUnfolded] = useState(false);
  const person = usePerson(message.by);
  const act = useRefAction();
  const { seen } = useChatState();
  const mentionsMe = message.refs.some((ref) => ref.kind === 'person' && ref.id === me);
  const announcement = isAnnouncement(roomId, message);
  const unreadNotice = announcement && announcementUnread(seen, me, message);
  const speaker = useSpeaker(message);
  return (
    <article className={cn('group/msg relative rounded-2xl border bg-card p-3 shadow-sm', announcement ? 'border-amber-300/70 bg-gradient-to-br from-amber-50 to-card dark:border-amber-400/30 dark:from-amber-500/10' : message.by === ASSISTANT_ID ? 'border-green-400/50 dark:border-green-500/30' : mentionsMe ? 'border-rose-300/60 shadow-rose-500/5 dark:border-rose-400/30' : 'border-border/70')}>
      <header className="flex items-center gap-2">
        <button type="button" title={`和 ${person.name} 私聊`} onClick={() => act({ kind: 'person', id: message.by, label: person.name })} className="rounded-full ring-2 ring-transparent transition hover:ring-sky-400/50">
          <MemberAvatar id={message.by} face={speaker.face} className="h-8 w-8 text-xs" />
        </button>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-semibold text-foreground">{speaker.name}</div>
          <div className="text-[11px] text-muted-foreground">{shortTime(message.at)}{mentionsMe && <span className="ml-1.5 text-rose-500/80">提到你</span>}</div>
        </div>
        {announcement && <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"><Megaphone className="h-3 w-3" />公告</span>}
        {unreadNotice && (
          <button type="button" onClick={() => markSeen(announcementKey(message.id))} className="rounded-full bg-amber-500 px-2.5 py-0.5 text-[11px] font-medium text-white shadow-sm transition hover:bg-amber-600">已讀</button>
        )}
        {message.by === me && (
          <button type="button" aria-label="刪除" onClick={() => deleteChatMessage(roomId, message.id)} className="rounded p-1 text-muted-foreground/50 opacity-0 transition hover:text-destructive group-hover/msg:opacity-100">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      {head && !unfolded ? (
        <div data-testid="patrol-folded" className="mt-2 text-sm leading-relaxed text-foreground">
          <p className="whitespace-pre-wrap break-words">{head}</p>
          <button type="button" onClick={() => setUnfolded(true)} className="mt-1 text-xs text-sky-600 hover:underline dark:text-sky-300">展開全文</button>
        </div>
      ) : message.text && (
        <>
          <MessageText message={speaker.shown} className="mt-2 block text-sm leading-relaxed text-foreground" />
          {head && <button type="button" onClick={() => setUnfolded(false)} className="mt-1 text-xs text-sky-600 hover:underline dark:text-sky-300">收起</button>}
        </>
      )}
      {message.files && <div className="mt-2"><MessageFiles roomId={roomId} files={message.files} /></div>}
      {message.share && <ShareCard share={message.share} />}
      <AssistantExtras roomId={roomId} message={message} />
      <UnsentBar roomId={roomId} message={message} />
      <Reactions roomId={roomId} message={message} />
    </article>
  );
}

/** A chat bubble (private chats and the room beside a session or whiteboard): mine on the right. */
function Bubble({ roomId, message, showName }: { roomId: string; message: ChatMessage; showName: boolean }) {
  const me = useChatMe();
  const person = usePerson(message.by);
  const act = useRefAction();
  const mine = message.by === me;
  const mentionsMe = message.refs.some((ref) => ref.kind === 'person' && ref.id === me);
  const speaker = useSpeaker(message);
  return (
    <div className={cn('group/msg flex items-end gap-2', mine && 'flex-row-reverse')}>
      {!mine && (
        <button type="button" title={`和 ${person.name} 私聊`} onClick={() => act({ kind: 'person', id: message.by, label: person.name })}>
          <MemberAvatar id={message.by} face={speaker.face} className="h-7 w-7 text-[11px]" />
        </button>
      )}
      <div className={cn('flex min-w-0 max-w-[80%] flex-col', mine ? 'items-end' : 'items-start')}>
        {showName && !mine && <span className="mb-0.5 px-1 text-[11px] text-muted-foreground">{speaker.name}</span>}
        <div className={cn(
          // 10/27: long code/URLs wrap inside the bubble instead of widening the room (no sideways scrollbar).
          'min-w-0 max-w-full rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm [overflow-wrap:anywhere] [&_code]:!whitespace-pre-wrap [&_pre]:!whitespace-pre-wrap',
          mine ? 'rounded-br-md bg-gradient-to-br from-sky-500 to-indigo-500 text-white [&_button]:bg-white/20 [&_button]:text-white' : 'rounded-bl-md border border-border/70 bg-card text-foreground',
          mentionsMe && !mine && 'border-rose-300/70 dark:border-rose-400/40',
        )}>
          {message.text && (mine ? <RefText text={message.text} refs={message.refs} /> : <MessageText message={speaker.shown} />)}
          {message.files && <MessageFiles roomId={roomId} files={message.files} />}
          {message.share && <ShareCard share={message.share} />}
          <AssistantExtras roomId={roomId} message={message} />
        </div>
        <div className={cn('flex items-center gap-1.5 px-1', mine && 'flex-row-reverse')}>
          <span className="text-[10px] text-muted-foreground/70">{shortTime(message.at)}</span>
          <Reactions roomId={roomId} message={message} />
          <UnsentBar roomId={roomId} message={message} />
          {mine && (
            <button type="button" aria-label="刪除" onClick={() => deleteChatMessage(roomId, message.id)} className="mt-1.5 rounded p-0.5 text-muted-foreground/50 opacity-0 transition hover:text-destructive group-hover/msg:opacity-100">
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A Co-Work invitation from the log, shown again in 動態 so a missed one can be found. */
type CoPost = { kind: 'cowork'; sessionId: string; from: string; to: string[]; message: string; at: string };

function CoWorkPost({ post }: { post: CoPost }) {
  const me = useChatMe();
  const people = useCoPeople();
  const sender = usePerson(post.from);
  const title = readCoSession(post.sessionId)?.title || '共享對話';
  const toNames = post.to.map((id) => (id === me ? '你' : people.get(id)?.name ?? '?')).join('、');
  return (
    <article className="relative overflow-hidden rounded-2xl border border-violet-300/60 bg-gradient-to-br from-violet-50 to-card p-3 shadow-sm dark:border-violet-400/25 dark:from-violet-500/10">
      <header className="flex items-center gap-2">
        <PersonAvatar person={sender} className="h-8 w-8 text-xs" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm text-foreground"><span className="font-semibold">{sender.name}</span> 邀 {toNames} Co-Work</div>
          <div className="text-[11px] text-muted-foreground">{shortTime(post.at)}</div>
        </div>
        <span className="flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300"><Users className="h-3 w-3" />Co-Work</span>
      </header>
      {post.message && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{post.message}</p>}
      <ShareCard share={{ kind: 'session', id: post.sessionId, label: title }} />
    </article>
  );
}

/** A board someone shared with you that you have not opened yet; it leaves 動態 once you open the board. */
function BoardInvitePost({ invite }: { invite: BoardInvite }) {
  const sender = usePerson(invite.from);
  return (
    <article data-testid="board-invite-post" className="relative overflow-hidden rounded-2xl border border-violet-300/60 bg-gradient-to-br from-violet-50 to-card p-3 shadow-sm dark:border-violet-400/25 dark:from-violet-500/10">
      <header className="flex items-center gap-2">
        <PersonAvatar person={sender} className="h-8 w-8 text-xs" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm text-foreground"><span className="font-semibold">{sender.name}</span> 邀你 Co-Work 白板</div>
          <div className="text-[11px] text-muted-foreground">{shortTime(invite.at)} · 還沒打開</div>
        </div>
        <span className="flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300"><Users className="h-3 w-3" />Co-Work</span>
      </header>
      {invite.message && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{invite.message}</p>}
      <ShareCard share={{ kind: 'board', id: invite.boardId, label: invite.name }} />
    </article>
  );
}

/** 11/04 AI 辦公室: the helper picked in the private chat with 團隊小助理; what is sent goes to it through its first mention. */
type CallAs = { name: string; mention: string };
const addressed = (text: string, callAs: CallAs | null) => (callAs && !mentionsAssistant(text) ? `${callAs.mention} ${text}` : text);

function Composer({ roomId, context, placeholder, draw = false, callAs = null }: { roomId: string; context: ChatContext | null; placeholder: string; draw?: boolean; callAs?: CallAs | null }) {
  const me = useChatMe();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  // 11/01: the unsent text is kept per room (memory + sessionStorage), so switching tabs or reloading does not lose it.
  const [text, setText] = useState(() => readRoomDraft(roomId).text);
  const [refs, setRefs] = useState<ChatRef[]>(() => readRoomDraft(roomId).refs);
  const edit = (nextText: string, nextRefs: ChatRef[]) => {
    setText(nextText);
    setRefs(nextRefs);
    writeRoomDraft(roomId, nextText, nextRefs);
  };
  const shownRoom = useRef(roomId);
  useEffect(() => {
    if (shownRoom.current === roomId) return;
    shownRoom.current = roomId;
    const kept = readRoomDraft(roomId);
    setText(kept.text);
    setRefs(kept.refs);
  }, [roomId]);
  const [offer, setOffer] = useState<{ people: ChatRef[]; message: string } | null>(null);
  const files = useComposerFiles();
  const [fileOver, setFileOver] = useState(false);
  const canSend = !!me && !files.busy && (text.trim() !== '' || files.pending.length > 0);
  // 10/21 只回我 (like Meta AI's side chat): the question and the answer go to your private chat with the assistant.
  const [onlyMe, setOnlyMe] = useState(false);
  const [sideNote, setSideNote] = useState(false);
  const canAskPrivately = !!me && dmPeer(roomId, me) !== ASSISTANT_ID && mentionsAssistant(text);
  // 10/25 R4: 貼到聊天室… from a tool waits here (under what is already typed) until it is sent.
  const draft = useChatDraft();
  useEffect(() => {
    if (draft === null || !me) return;
    const taken = takeChatDraft();
    if (taken) edit(text.trim() ? `${text.trimEnd()}\n\n${taken}` : taken, refs);
  }, [draft, me]);
  const send = async () => {
    if (!canSend) return;
    // Upload first; if it fails the text and the chips stay so nothing has to be typed again.
    const uploaded = files.pending.length > 0 ? await files.upload() : [];
    if (!uploaded) return;
    if (onlyMe && canAskPrivately) {
      const where = roomId === LOBBY ? '動態' : roomId.startsWith('s:') ? '對話旁的聊天室' : roomId.startsWith('b:') ? '白板旁的聊天室' : '私聊';
      const dm = dmRoom(me, ASSISTANT_ID);
      const asked = sendChatMessage(dm, { by: me, text: `（在「${where}」悄悄問）${ASSISTANT_MENTIONS.reduce((rest, mention) => rest.replace(mention, ''), text).trim()}`, refs, ...(uploaded.length > 0 ? { files: uploaded } : {}) });
      void askAssistant(dm, asked, me, roomId);
      edit('', []);
      files.clear();
      setOnlyMe(false);
      setSideNote(true);
      window.setTimeout(() => setSideNote(false), 5000);
      return;
    }
    const sent = sendChatMessage(roomId, { by: me, text: addressed(text.trim(), callAs), refs, ...(uploaded.length > 0 ? { files: uploaded } : {}) });
    void askIfCalled(roomId, sent, me);
    const missing = outsiders(context, refs);
    if (missing.length > 0) setOffer({ people: missing, message: text.trim() });
    edit('', []);
    files.clear();
  };
  const pick = (item: string) => {
    if (!me) return;
    const sent = sendChatMessage(roomId, { by: me, text: dmPeer(roomId, me) === ASSISTANT_ID ? addressed(item, callAs) : `${ASSISTANT_MENTION} ${item}`, refs: [] });
    if (callsAssistant(roomId, sent.text, me)) void askAssistant(roomId, sent, me);
  };
  // 10/25: 忙線 is a line here (and one automatic retry), not an alert().
  const busy = useAssistantBusy(roomId);
  return (
    <div className="relative border-t border-border/70 bg-background/80 p-2.5 backdrop-blur" {...fileHandlers(files, setFileOver)}>
      {offer && context && <div className="mb-2"><InviteOffer context={context} people={offer.people} message={offer.message} onDone={() => setOffer(null)} /></div>}
      <AssistantChips roomId={roomId} onPick={pick} />
      {busy && (
        <div role="status" data-testid="assistant-busy" className="mb-1.5 flex items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50/70 px-2.5 py-1 text-[11px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="min-w-0 flex-1">{ASSISTANT_NAME}忙線中（同時最多 3 件在跑），{busy.auto ? '30 秒後自動再試一次' : '還在忙，可以等一下再按重試'}。訊息已經送出了。</span>
          <button type="button" onClick={() => retryBusy(roomId)} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400/60 bg-background px-2 py-0.5 text-amber-800 transition hover:bg-amber-100 dark:text-amber-200"><RotateCcw className="h-3 w-3" />重試</button>
          <button type="button" aria-label="關掉忙線提示" onClick={() => dismissBusy(roomId)} className="shrink-0 rounded p-0.5 hover:bg-amber-500/15"><X className="h-3 w-3" /></button>
        </div>
      )}
      {sideNote && <div data-testid="side-note" className="mb-1.5 text-[11px] text-sky-600 dark:text-sky-300">已私下問，答案在你和{ASSISTANT_NAME}的私聊</div>}
      {canAskPrivately && (
        <label className="mb-1.5 flex w-fit cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={onlyMe} onChange={(event) => setOnlyMe(event.target.checked)} className="h-3 w-3" />
          只回我（不發到動態，但資料不加密）
        </label>
      )}
      <PendingFiles files={files} />
      {fileOver && <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-sky-400/70 bg-sky-500/10 text-sm font-medium text-sky-600 dark:text-sky-300">放開就附加檔案</div>}
      {/* 10/25: no 你是誰 yet: chosen right here instead of 左下設定 → 專案設定. */}
      {!me && <WhoAmI note="這台裝置還沒選你是誰，選好就能發言。" className="rounded-2xl border border-border bg-card px-3 py-2 shadow-sm" />}
      {me && <div data-tutorial-tip={roomId === LOBBY ? '大家都看得到；@ 標記人、@@ 標記對話或白板、@ALL 發公告' : '@ 標記人、@@ 標記對話或白板；檔案可拖進來或貼上圖片'} className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-sm focus-within:border-sky-400/60 focus-within:ring-2 focus-within:ring-sky-400/15">
        <FileButtons files={files} disabled={!me || files.busy} draw={draw} />
        <RefInput
          value={text}
          refs={refs}
          onChange={edit}
          onSubmit={() => void send()}
          rows={1}
          placeholder={me ? placeholder : '先在設定選好你的專案設定，才能發言'}
          className="min-w-0 flex-1"
          textareaClassName="max-h-32 min-h-[1.5rem] py-0.5 [field-sizing:content]"
        />
        <button type="button" aria-label="送出" onClick={() => void send()} disabled={!canSend} className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-500 text-white shadow transition hover:scale-105 disabled:opacity-30 disabled:hover:scale-100">
          {files.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </div>}
      <div data-tutorial className="mt-1 px-1 text-[10px] text-muted-foreground/70">{isMobile ? '@ 標記人 · @@ 標記對話' : '@ 標記人 · @@ 標記對話或白板 · 從側欄把對話拖進來可以分享 · 檔案可拖進來或貼上圖片'}</div>
    </div>
  );
}

/** 思考中, plus what it is doing right now and 停止 (10/21, like Grok's visible progress and Stop). */
function AssistantThinking({ roomId }: { roomId: string }) {
  const me = useChatMe();
  const step = useAssistantStep(roomId);
  const trail = useAssistantTrail(roomId);
  const [stopping, setStopping] = useState(false);
  // 10/25 R4 (稽核 P1-3): a role or own bot answering shows its own name and face; kept when later steps replace the role line.
  const { faces } = useBots();
  const role = /^以(.+)的角色處理$/.exec(step)?.[1] ?? null;
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => {
    if (role) setWho(role);
  }, [role]);
  const name = who ?? ASSISTANT_NAME;
  const face = who ? faces[who] ?? Array.from(who)[0] : null;
  const stop = async () => {
    if (!me || stopping) return;
    setStopping(true);
    try {
      await stopAssistant(roomId, me);
    } finally {
      setStopping(false);
    }
  };
  return (
    <div data-testid="assistant-thinking" className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
      <MemberAvatar id={ASSISTANT_ID} face={face} className="h-5 w-5 text-[10px]" />
      <span className="min-w-0 truncate">{name} {role ? '正在處理…' : step ? `正在${step}…` : '思考中…'}</span>
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      {me && (
        <button type="button" onClick={() => void stop()} disabled={stopping} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition hover:text-foreground disabled:opacity-50">
          <Square className="h-2.5 w-2.5 fill-current" />{stopping ? '停止中…' : '停止'}
        </button>
      )}
      {trail.length > 0 && (
        <ul data-testid="assistant-trail" className="order-last basis-full space-y-0.5 pl-7 text-[11px]">
          {trail.map((item, index) => (
            <li key={index} className={item.state === 'failed' ? 'text-rose-500' : item.state === 'empty' ? 'text-amber-600 dark:text-amber-400' : item.state === 'now' ? 'text-foreground' : 'text-muted-foreground'}>
              {item.state === 'done' ? '✓ ' : item.state === 'failed' ? '✗ ' : item.state === 'empty' ? '∅ ' : '• '}{item.label}{item.state === 'empty' ? ' 無結果' : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 10/25 R4 (稽核 P1-2): a 「打開：試算工作台」 chip names a built tool; null when it names none (then it is sent like any chip). */
export function chipTool(item: string): { id: string; name: string } | null {
  const name = openToolName(item);
  const tool = name ? TOOL_CATALOG.find((entry) => entry.name === name && isToolReady(entry.id)) : undefined;
  return tool ? { id: tool.id, name: tool.name } : null;
}

/** The latest answer's follow-up chips; one press sends it as your next message to the assistant (打開：工具名 opens that tool). */
function AssistantChips({ roomId, onPick }: { roomId: string; onPick: (text: string) => void }) {
  const messages = useRoom(roomId);
  const next = useAssistantNext(roomId);
  const thinking = useAssistantThinking(roomId);
  const last = roomId === LOBBY ? [...messages].sort((a, b) => a.at.localeCompare(b.at)).at(-1) : messages.at(-1);
  if (thinking || !next || next.items.length === 0 || !last || last.by !== ASSISTANT_ID || last.id !== next.messageId) return null;
  return (
    <div data-testid="assistant-chips" className="mb-1.5 flex flex-wrap gap-1.5">
      {next.items.map((item) => {
        const tool = chipTool(item);
        if (tool) {
          return (
            <button key={item} type="button" data-testid="assistant-tool-chip" onClick={() => { closeChatPanel(); requestOpenTool(tool.id); }} className="inline-flex items-center gap-1 rounded-full border border-violet-300/70 bg-violet-50/70 px-2.5 py-0.5 text-xs text-violet-700 transition hover:bg-violet-100 dark:border-violet-400/30 dark:bg-violet-500/10 dark:text-violet-300">
              <ArrowUpRight className="h-3 w-3" />打開{tool.name}
            </button>
          );
        }
        return (
          <button key={item} type="button" onClick={() => onPick(item)} className="rounded-full border border-sky-300/70 bg-sky-50/70 px-2.5 py-0.5 text-xs text-sky-700 transition hover:bg-sky-100 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-300">
            {item}
          </button>
        );
      })}
    </div>
  );
}

/** Scrolls to the newest message when the room opens or something new arrives. */
function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dependency]);
  return ref;
}

function RoomView({ roomId, context, bubbles, placeholder, empty, emptyMore, emptyExtra, callAs = null }: { roomId: string; context: ChatContext | null; bubbles: boolean; placeholder: string; empty: string; emptyMore?: string; emptyExtra?: ReactNode; callAs?: CallAs | null }) {
  const messages = useRoom(roomId);
  const me = useChatMe();
  const { faces } = useBots();
  // Two helpers answering one after the other each get their name over the bubble.
  const writer = (message: ChatMessage) => (message.by === ASSISTANT_ID ? botSpeaker(message.text, faces) ?? message.by : message.by);
  const thinking = useAssistantThinking(roomId);
  const scroller = useStickToBottom(`${roomId}:${messages.length}`);
  useEffect(() => {
    markSeen(roomId);
  }, [roomId, messages.length]);
  const share = (ref: ChatRef) => {
    if (me) sendChatMessage(roomId, { by: me, text: '', refs: [], share: ref });
  };
  const [dropping, setDropping] = useState(false);
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!carriesRef(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        const ref = readDroppedRef(event);
        if (!ref) return;
        event.preventDefault();
        share(ref);
      }}
    >
      <div ref={scroller} className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3', bubbles ? 'space-y-2.5' : 'space-y-3')}>
        {messages.length === 0 && <p className="py-10 text-center text-xs text-muted-foreground">{empty}{emptyMore && <span data-tutorial>{emptyMore}</span>}</p>}
        {messages.length === 0 && emptyExtra}
        {messages.map((message, index) => (bubbles
          ? <Bubble key={message.id} roomId={roomId} message={message} showName={index === 0 || writer(messages[index - 1]) !== writer(message)} />
          : <Post key={message.id} roomId={roomId} message={message} />))}
      </div>
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-400/70 bg-violet-500/5 text-sm font-medium text-violet-600 backdrop-blur-[1px] dark:text-violet-300">
          放開就分享到這裡
        </div>
      )}
      {thinking && <AssistantThinking roomId={roomId} />}
      <Composer roomId={roomId} context={context} placeholder={callAs ? `對${callAs.name}說…` : placeholder} callAs={callAs} />
    </div>
  );
}

type FeedFilter = 'all' | 'notice' | 'cowork' | 'patrol';
const isPatrol = (message: ChatMessage) => message.by === ASSISTANT_ID && message.text.startsWith('【巡查】');
const FEED_FILTERS: Array<{ id: FeedFilter; label: string; empty: string; more?: string }> = [
  { id: 'all', label: '全部', empty: '還沒有動態。', more: '說點什麼、@ 同事，或把側欄的對話拖進來分享。' },
  { id: 'notice', label: '公告', empty: '還沒有公告。', more: '發文時打 @ALL 就會變成公告。' },
  { id: 'cowork', label: 'Co-Work', empty: '還沒有 Co-Work 邀請。' },
  { id: 'patrol', label: '巡查', empty: '還沒有巡查回報。' },
];

/** 動態: lobby posts and the Co-Work invitations involving you, newest at the top like a feed; unread 公告 stay on top of 全部. */
function LobbyView() {
  const me = useChatMe();
  const { seen } = useChatState();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const messages = useRoom(LOBBY);
  const thinking = useAssistantThinking(LOBBY);
  const logs = useCoLogs();
  const boardInvites = useBoardInvites(me);
  const coPosts = useMemo<CoPost[]>(() => {
    if (!me) return [];
    return Object.entries(logs).flatMap(([sessionId, entries]) => entries
      .filter((entry) => entry.kind === 'share' && (entry.to.includes(me) || entry.from === me))
      .map((entry) => ({ kind: 'cowork' as const, sessionId, from: entry.from, to: entry.to, message: entry.message, at: entry.at })));
  }, [logs, me]);
  const unreadNotices = messages.filter((message) => isAnnouncement(LOBBY, message) && announcementUnread(seen, me, message)).length;
  const feed = useMemo(() => {
    const posts = messages.filter((message) => filter === 'all' || (filter === 'notice' && isAnnouncement(LOBBY, message)) || (filter === 'patrol' && isPatrol(message)));
    const items = [
      ...posts.map((message) => ({ at: message.at, pinned: filter === 'all' && isAnnouncement(LOBBY, message) && announcementUnread(seen, me, message), key: `m:${message.id}`, node: <Post roomId={LOBBY} message={message} /> })),
      ...(filter !== 'all' && filter !== 'cowork' ? [] : [
        ...coPosts.map((post) => ({ at: post.at, pinned: false, key: `c:${post.sessionId}:${post.at}`, node: <CoWorkPost post={post} /> })),
        ...boardInvites.map((invite) => ({ at: invite.at, pinned: false, key: `b:${invite.boardId}`, node: <BoardInvitePost invite={invite} /> })),
      ]),
    ];
    return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at.localeCompare(a.at)).slice(0, 200);
  }, [messages, coPosts, boardInvites, filter, seen, me]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [feed.length, filter]);
  useEffect(() => {
    markSeen(LOBBY);
  }, [messages.length]);
  const [dropping, setDropping] = useState(false);
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!carriesRef(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        const ref = readDroppedRef(event);
        if (!ref || !me) return;
        event.preventDefault();
        sendChatMessage(LOBBY, { by: me, text: '', refs: [], share: ref });
      }}
    >
      <div className="flex gap-1.5 border-b border-border/50 px-3 py-1.5" role="radiogroup" aria-label="動態類別">
        {FEED_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={cn('flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition', filter === item.id ? 'border-foreground/80 bg-foreground/90 text-background' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')}
          >
            {item.label}
            {item.id === 'notice' && unreadNotices > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-medium leading-4 text-white">{unreadNotices}</span>}
          </button>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden bg-muted/20 px-3 py-3">
        {feed.length === 0 && (
          <div className="py-12 text-center text-xs text-muted-foreground">
            <MessageCircle className="mx-auto mb-2 h-8 w-8 opacity-30" />
            {FEED_FILTERS.find((item) => item.id === filter)?.empty}
            <span data-tutorial>{FEED_FILTERS.find((item) => item.id === filter)?.more}</span>
          </div>
        )}
        {feed.map((item) => <div key={item.key}>{item.node}</div>)}
      </div>
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-400/70 bg-violet-500/5 text-sm font-medium text-violet-600 dark:text-violet-300">
          放開就分享到動態
        </div>
      )}
      {thinking && <AssistantThinking roomId={LOBBY} />}
      <Composer roomId={LOBBY} context={null} draw={false} placeholder="分享點什麼…" />
    </div>
  );
}

/** 10/25: an empty private chat with 團隊小助理 offers three ways to start (建一個小助理 only with 自建小助理 on). */
const DB_EXAMPLE = '用一個例子教我怎麼請你查資料庫（只看不改）';
const STARTER = 'rounded-full border border-sky-300/70 bg-sky-50/70 px-3 py-1 text-xs text-sky-700 transition hover:bg-sky-100 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-300';
function AssistantStarters({ roomId, onNewBot }: { roomId: string; onNewBot: () => void }) {
  const me = useChatMe();
  const bots = useBots();
  // 11/02 (MausBot TryAsking): questions colleagues asked before that got a good answer.
  const [examples, setExamples] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void loadAssistantExamples().then((list) => { if (alive) setExamples(list); });
    return () => { alive = false; };
  }, []);
  if (!me) return null;
  const askText = (text: string) => {
    const sent = sendChatMessage(roomId, { by: me, text, refs: [] });
    void askAssistant(roomId, sent, me);
  };
  const ask = () => askText(DB_EXAMPLE);
  return (
    <div data-testid="assistant-starters" className="flex flex-wrap justify-center gap-2">
      <button type="button" onClick={ask} className={STARTER}>查資料庫範例</button>
      {bots.enabled && <button type="button" onClick={onNewBot} className={STARTER}>建一個小助理</button>}
      <button type="button" onClick={() => { closeChatPanel(); requestOpenLibrary(); }} className={STARTER}>打開工具庫</button>
      {examples.length > 0 && (
        <div data-testid="assistant-examples" className="flex basis-full flex-wrap items-center justify-center gap-2">
          <span className="text-xs text-muted-foreground">試著問：</span>
          {examples.map((text) => <button key={text} type="button" onClick={() => askText(text)} className={STARTER}>{text}</button>)}
        </div>
      )}
    </div>
  );
}

function DirectList({ personIds, onOpen, onOpenBots }: { personIds: string[]; onOpen: (roomId: string) => void; onOpenBots: () => void }) {
  const isTeamMode = useIsTeamMode();
  const me = useChatMe();
  const people = useCoPeople();
  const chat = useChatState();
  const bots = useBots();
  const unread = useMemo(() => unreadDirect(chat, me), [chat, me]);
  if (!me) return <div className="min-h-0 flex-1 overflow-y-auto p-4">{isTeamMode && <WhoAmI inline note="私訊要知道你是誰。選你的專案，這台裝置之後就記得是你。" />}</div>;
  const rows = personIds.filter((id) => id !== me && id !== ASSISTANT_ID).map((id) => {
    const roomId = dmRoom(me, id);
    const last = chat.rooms[roomId]?.at(-1);
    return { id, roomId, last, unread: unread.get(roomId) ?? 0 };
  }).sort((a, b) => (b.last?.at ?? '').localeCompare(a.last?.at ?? '') || (people.get(a.id)?.name ?? '').localeCompare(people.get(b.id)?.name ?? ''));
  const assistantRoom = dmRoom(me, ASSISTANT_ID);
  rows.unshift({ id: ASSISTANT_ID, roomId: assistantRoom, last: chat.rooms[assistantRoom]?.at(-1), unread: unread.get(assistantRoom) ?? 0 });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {rows.map((row) => {
        const person = row.id === ASSISTANT_ID ? { name: ASSISTANT_NAME, avatarId: null } : people.get(row.id) ?? { name: '?', avatarId: null };
        return [
          <button key={row.id} type="button" onClick={() => onOpen(row.roomId)} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-muted/70">
            <span className="relative">
              <MemberAvatar id={row.id} className="h-9 w-9 text-sm" />
              {row.unread > 0 && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-400 ring-2 ring-background" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate text-sm', row.unread > 0 ? 'font-semibold text-foreground' : 'text-foreground')}>{person.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {row.last ? `${row.last.by === me ? '你：' : ''}${row.last.text || (row.last.files?.length ? `傳了 ${row.last.files.length} 個檔案` : row.last.share ? `分享了「${row.last.share.label}」` : '')}` : '開始聊天'}
              </span>
            </span>
            {row.last && <span className="shrink-0 text-[10px] text-muted-foreground">{shortTime(row.last.at)}</span>}
          </button>,
          // 10/25 入口往前移: 我的小助理 right under 團隊小助理 (only with 自建小助理 on).
          row.id === ASSISTANT_ID && bots.enabled && (
            <button key="my-bots" type="button" data-testid="my-bots-row" onClick={onOpenBots} className="flex w-full items-center gap-3 rounded-xl py-1.5 pl-6 pr-2.5 text-left transition hover:bg-muted/70">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-green-400/60 bg-green-500/10 text-green-700 dark:text-green-300"><Bot className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">我的小助理（{bots.mine.length}）</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">新增、修改、看別人的</span>
            </button>
          ),
        ];
      })}
    </div>
  );
}

type Tab = 'lobby' | 'direct' | 'here';

const TALK_TO_KEY = 'dhc.officeTalkTo';
const readTalkTo = (): string => {
  try {
    return localStorage.getItem(TALK_TO_KEY) ?? '';
  } catch {
    return '';
  }
};
const writeTalkTo = (id: string) => {
  try {
    if (id) localStorage.setItem(TALK_TO_KEY, id);
    else localStorage.removeItem(TALK_TO_KEY);
  } catch {
    // private mode: the pick lasts until reload
  }
};

/** 11/04 AI 辦公室: the private chat with 團隊小助理 is an office of your own helpers; pick who gets what you send next. */
function OfficeRoster({ talkTo, onPick, onAdd }: { talkTo: string; onPick: (id: string) => void; onAdd: () => void }) {
  const bots = useBots();
  const seat = (id: string, name: string, avatar: string, note: string) => (
    <button key={id || 'general'} type="button" aria-pressed={talkTo === id} title={note} onClick={() => onPick(id)} className={cn('flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1 transition', talkTo === id ? 'bg-green-500/15 ring-1 ring-green-500/50' : 'hover:bg-muted')}>
      <BotFace avatar={avatar} className="h-7 w-7 text-[11px]" />
      <span className={cn('w-full truncate text-center text-[10px]', talkTo === id ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{name}</span>
    </button>
  );
  return (
    <div data-testid="office-roster" className="flex items-center gap-1 overflow-x-auto border-b border-border/50 px-2 py-1">
      {seat('', '通用', '', `${ASSISTANT_NAME}，什麼都可以問`)}
      {bots.mine.map((bot) => seat(bot.id, bot.name, bot.avatar, `對${bot.name}說：${bot.duty}`))}
      {bots.mine.length < 5 && (
        <button type="button" title="新增員工" aria-label="新增員工" onClick={onAdd} className="flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <span className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-border"><Plus className="h-3.5 w-3.5" /></span>
          <span className="text-[10px]">新員工</span>
        </button>
      )}
    </div>
  );
}

function Panel({ personIds, isMobile }: { personIds: string[]; isMobile: boolean }) {
  const { room, context, boardContext } = useChatPanel();
  const me = useChatMe();
  const people = useCoPeople();
  const chat = useChatState();
  const mentions = useMyMentions();
  const boardInvites = useBoardInvites(me);
  const here = boardContext ?? context;
  const hereRoom = here ? (here.kind === 'session' ? roomOfSession(here.id) : roomOfBoard(here.id)) : null;
  const [tab, setTab] = useState<Tab>(room && dmPeer(room, me ?? '') ? 'direct' : room && room === hereRoom ? 'here' : 'lobby');
  const [direct, setDirect] = useState<string | null>(room && me && dmPeer(room, me) ? room : null);
  // 10/25 我的小助理: opened from the top of the private chat with 團隊小助理; the list is fresh each time the panel opens.
  const bots = useBots();
  const [botsOpen, setBotsOpen] = useState(false);
  // 10/25: the 建一個小助理 starter opens the panel with the add form ready.
  const [botsNew, setBotsNew] = useState(false);
  const openBots = (fresh: boolean) => {
    if (!me) return;
    setTab('direct');
    setDirect(dmRoom(me, ASSISTANT_ID));
    setBotsNew(fresh);
    setBotsOpen(true);
  };
  // 現在試叫: the first call goes to the private chat with 團隊小助理, which then shows.
  const tryBot = (mention: string) => {
    if (!me) return;
    const room = dmRoom(me, ASSISTANT_ID);
    const sent = sendChatMessage(room, { by: me, text: `${mention} 你好，用三句話介紹你能幫我做什麼`, refs: [] });
    void askAssistant(room, sent, me);
    setBotsOpen(false);
  };
  useEffect(() => {
    void loadBots(me);
  }, [me]);
  // 11/04 AI 辦公室: who in the office you are talking to (one of your own helpers; '' is 團隊小助理), kept on this device.
  const [talkTo, setTalkTo] = useState(readTalkTo);
  const pickTalkTo = (id: string) => {
    setTalkTo(id);
    writeTalkTo(id);
  };
  const talkBot = bots.enabled ? bots.mine.find((bot) => bot.id === talkTo) ?? null : null;

  // A jump from elsewhere (a person chip, the session header) picks the tab.
  useEffect(() => {
    if (!room) return;
    if (me && dmPeer(room, me)) {
      setTab('direct');
      setDirect(room);
    } else if (room === hereRoom) setTab('here');
    else if (room === LOBBY) setTab('lobby');
  }, [room, me, hereRoom]);
  useEffect(() => {
    if (tab === 'here' && !hereRoom) setTab('lobby');
  }, [tab, hereRoom]);

  useEscapeClose(closeChatPanel);

  const [width, setWidth] = useState(readPanelWidth);
  const dragging = useRef<{ x: number; width: number } | null>(null);
  const saveWidth = (px: number) => {
    try {
      if (px) localStorage.setItem(PANEL_WIDTH_KEY, String(px));
      else localStorage.removeItem(PANEL_WIDTH_KEY);
    } catch {
      // private mode: the width just isn't remembered
    }
  };

  const directUnread = useMemo(() => [...unreadDirect(chat, me).values()].reduce((sum, n) => sum + n, 0), [chat, me]);
  const lobbyUnread = (mentions.get(LOBBY) ?? 0) + boardInvites.length;
  const hereUnread = hereRoom ? mentions.get(hereRoom) ?? 0 : 0;
  const peer = direct && me ? dmPeer(direct, me) : null;
  const peerPerson = peer ? (peer === ASSISTANT_ID ? { name: ASSISTANT_NAME, avatarId: null } : people.get(peer) ?? { name: '?', avatarId: null }) : null;

  const tabs: Array<{ id: Tab; label: string; count: number; icon: typeof Users }> = [
    { id: 'lobby', label: '動態', count: lobbyUnread, icon: MessageCircle },
    { id: 'direct', label: '私訊', count: directUnread, icon: AtSign },
  ];
  if (here) tabs.push({ id: 'here', label: here.kind === 'session' ? '這個對話' : '這張白板', count: hereUnread, icon: here.kind === 'session' ? MessageSquare : Workflow });

  const panel = (
    <aside
      role="dialog"
      aria-label="聊天室"
      data-testid="chat-room-panel"
      className={cn(
        'z-[75] flex flex-col overflow-hidden border-border bg-background animate-in slide-in-from-right-8 fade-in duration-300',
        isMobile ? 'fixed inset-0 shadow-2xl' : 'relative h-full flex-shrink-0 border-l',
      )}
      style={isMobile ? undefined : { width: panelWidth(width) }}
    >
      {!isMobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拉動調整聊天室寬度"
          title="拖曳調整寬度，雙擊恢復預設"
          data-testid="chat-room-resize"
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const box = event.currentTarget.parentElement?.getBoundingClientRect();
            dragging.current = { x: event.clientX, width: box ? box.width : width };
          }}
          onPointerMove={(event) => {
            const start = dragging.current;
            if (start) setWidth(Math.round(start.width + start.x - event.clientX));
          }}
          onPointerUp={(event) => {
            const start = dragging.current;
            if (!start) return;
            dragging.current = null;
            // Save what CSS actually allowed, so a drag past the limits leaves no dead zone next time.
            const px = Math.round(event.currentTarget.parentElement?.getBoundingClientRect().width ?? start.width + start.x - event.clientX);
            setWidth(px);
            saveWidth(px);
          }}
          onDoubleClick={() => {
            setWidth(0);
            saveWidth(0);
          }}
        />
      )}
      <header className="flex items-center gap-2 border-b border-border/70 bg-gradient-to-r from-sky-500/[0.06] via-transparent to-violet-500/[0.06] px-3 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-violet-500 text-white shadow-sm"><MessageCircle className="h-4 w-4" /></span>
        <span className="text-sm font-semibold text-foreground">聊天室</span>
        <button type="button" aria-label="關閉聊天室" onClick={closeChatPanel} className="ml-auto rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </header>
      <nav className="flex gap-1 border-b border-border/70 px-2 py-1.5" role="tablist">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => {
                setTab(item.id);
                if (item.id === 'direct') setDirect(null);
              }}
              className={cn('relative flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition', tab === item.id ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{item.label}</span>
              {item.count > 0 && <span className="rounded-full bg-rose-400/90 px-1.5 text-[10px] font-medium leading-4 text-white">{item.count}</span>}
            </button>
          );
        })}
      </nav>
      {tab === 'here' && here && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <RefIcon kind={here.kind} />
          <span className="truncate">{here.title || '（未命名）'}</span>
          <span className="ml-auto shrink-0">只有看得到這裡的人才看得到</span>
        </div>
      )}
      {tab === 'direct' && direct && peerPerson && (
        <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5">
          <button type="button" aria-label="回私訊列表" onClick={() => setDirect(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>
          {peer && <MemberAvatar id={peer} className="h-6 w-6 text-[10px]" />}
          <span className="truncate text-sm font-medium">{peerPerson.name}</span>
          {peer === ASSISTANT_ID && bots.enabled && (
            <button type="button" data-testid="my-bots-open" aria-pressed={botsOpen} onClick={() => { setBotsNew(false); setBotsOpen((open) => !open); }} className={cn('flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition', botsOpen ? 'border-green-500/60 bg-green-500/15 text-green-700 dark:text-green-300' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')}>
              <Bot className="h-3 w-3" />我的小助理
            </button>
          )}        </div>
      )}
      {tab === 'direct' && direct && peer === ASSISTANT_ID && bots.enabled && !botsOpen && <OfficeRoster talkTo={talkBot?.id ?? ''} onPick={pickTalkTo} onAdd={() => openBots(true)} />}
      {tab === 'lobby' && <LobbyView />}
      {tab === 'direct' && !direct && <DirectList personIds={personIds} onOpen={setDirect} onOpenBots={() => openBots(false)} />}
      {tab === 'direct' && direct && peerPerson && peer === ASSISTANT_ID && bots.enabled && botsOpen && <MyBots key={String(botsNew)} startNew={botsNew} onTry={tryBot} onClose={() => setBotsOpen(false)} />}
      {tab === 'direct' && direct && peerPerson && !(peer === ASSISTANT_ID && bots.enabled && botsOpen) && (
        <RoomView key={direct} roomId={direct} context={null} bubbles callAs={peer === ASSISTANT_ID && talkBot ? { name: talkBot.name, mention: talkBot.mentions[0] } : null} placeholder={`私訊 ${peerPerson.name}…`} empty={`和 ${peerPerson.name} 的私訊從這裡開始。`} emptyExtra={peer === ASSISTANT_ID ? <AssistantStarters roomId={direct} onNewBot={() => openBots(true)} /> : undefined} />
      )}
      {tab === 'here' && here && hereRoom && (
        <RoomView key={hereRoom} roomId={hereRoom} context={here} bubbles placeholder="留話" empty="這裡還沒有人說話。" emptyMore="標記同事，他的側欄會亮紅點。" />
      )}
    </aside>
  );
  return isMobile ? createPortal(panel, document.body) : panel;
}

/**
 * DHC CLI 10/16 聊天室: the right-edge handle under 行事曆 and the panel it opens. Mounted once by the workspace;
 * it also tells the chat store who this page is and what @ / @@ can pick.
 */
/** Handle lights fill these corners in the order they came on: top-left, bottom-left, top-right, bottom-right. */
const LIGHT_CORNERS = ['-left-1 -top-1', '-left-1 -bottom-1', 'right-0 -top-1', 'right-0 -bottom-1'];
const LIGHT_LABELS: Record<string, string> = { direct: '私訊', assistant: '小助理', notice: '公告', cowork: 'Co-Work' };
const LIGHT_COLORS: Record<string, string> = {
  direct: 'bg-rose-500/90',
  assistant: 'bg-emerald-500/90',
  notice: 'bg-amber-500/90',
  cowork: 'bg-violet-500/90',
};

export default function ChatRoom({ projects, isMobile }: { projects: Project[]; isMobile: boolean }) {
  const { open } = useChatPanel();
  const me = useChatMe();
  const chat = useChatState();
  const coSessions = useCoSessions();
  const boardInvites = useBoardInvites(me);
  const personProjects = useMemo(() => projects.filter(isPersonProject), [projects]);
  const personIds = useMemo(() => personProjects.map((project) => project.projectId), [personProjects]);
  const myId = resolveSettingsProjectId(personProjects);

  useEffect(() => startChatSync(), []);
  useEffect(() => setChatMe(myId), [myId]);
  useEffect(() => {
    const seen = new Set<string>();
    const sessions: ChatRef[] = [];
    for (const project of personProjects) {
      for (const session of project.sessions ?? []) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        sessions.push({ kind: 'session', id: session.id, label: sessionLabel(session) });
      }
    }
    for (const [id, record] of Object.entries(coSessions)) {
      if (!seen.has(id) && record.title) sessions.push({ kind: 'session', id, label: record.title });
    }
    setRefCandidates(personIds, sessions);
  }, [personProjects, personIds, coSessions]);

  const lights = useMemo(() => {
    const found = Object.entries(unreadLights(chat, me)).map(([kind, light]) => ({ kind, ...light }));
    if (boardInvites.length > 0) found.push({ kind: 'cowork', count: boardInvites.length, since: boardInvites.reduce((min, invite) => (invite.at < min ? invite.at : min), boardInvites[0].at) });
    return found.sort((a, b) => a.since.localeCompare(b.since)).slice(0, LIGHT_CORNERS.length);
  }, [chat, me, boardInvites]);
  const unread = lights.reduce((sum, light) => sum + light.count, 0);
  useEffect(() => setRailCount('chat', unread), [unread]);

  const people = useCoPeople();
  const directUnread = useMemo(() => unreadDirect(chat, me), [chat, me]);
  const fanIds = useMemo(() => (me ? [ASSISTANT_ID, ...recentContacts(chat, me).filter((id) => personIds.includes(id))] : []), [chat, me, personIds]);
  const [isFanned, setIsFanned] = useState(false);
  const closeTimer = useRef<number | null>(null);
  // The circles sit apart, so leaving one must not fold the fan before the pointer reaches the next.
  const keepFan = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (fanIds.length > 0) setIsFanned(true);
  };
  const foldFanSoon = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setIsFanned(false), 250);
  };
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  const fanned = isFanned && !open;

  return (
    <>
      <div
        data-rail-item
        className={cn('fixed right-0 flex items-center justify-end', fanned ? 'z-[52]' : 'z-50')}
        style={isMobile ? MOBILE_HANDLE_STYLE : DESKTOP_HANDLE_STYLE}
        onMouseEnter={isMobile ? undefined : keepFan}
        onMouseLeave={isMobile ? undefined : foldFanSoon}
      >
        <button
          type="button"
          aria-label="打開聊天室"
          aria-expanded={fanned}
          title={unread > 0 ? `聊天室（${lights.map((light) => `${LIGHT_LABELS[light.kind]} ${light.count}`).join('、')}）` : '聊天室'}
          data-testid="chat-room-handle"
          data-tutorial-tip={isMobile ? '聊天室：點一下展開小助理和常聊的人，再點一下打開' : '聊天室：滑過展開小助理和常聊的人，點一下打開；角標是新訊息數'}
          // Phones have no hover: the first tap fans the circles out, the next opens the room.
          onClick={() => {
            if (isMobile && !fanned && !open && fanIds.length > 0) return keepFan();
            setIsFanned(false);
            if (open) closeChatPanel();
            else openChatPanel();
          }}
          // Same grow-out / shrink-back pill as the 自選功能 handle while the circles are out; shorter so it never covers that handle above.
          className={cn(
            'relative z-10 flex items-center justify-center border border-gray-200 bg-white text-gray-600 shadow-lg transition-all duration-200 ease-out hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
            fanned ? 'h-11 w-8 rounded-l-full border-r-0 pl-1 text-primary dark:text-primary' : 'h-[38px] w-[38px] rounded-l-md',
          )}
        >
          <MessageCircle className="h-4 w-4" />
          {!fanned && lights.map((light, index) => (
            <span key={light.kind} data-light={light.kind} title={`${LIGHT_LABELS[light.kind]} ${light.count}`} aria-label={`${LIGHT_LABELS[light.kind]} ${light.count}`} className={cn('absolute min-w-[1rem] rounded-full px-1 text-[10px] font-medium leading-4 text-white ring-2 ring-background', LIGHT_CORNERS[index], LIGHT_COLORS[light.kind])}>{light.count > 9 ? '9+' : light.count}</span>
          ))}
        </button>

        {/* While fanned, the zone left of the rail counts as hovering, so the gaps between them never fold it. */}
        {fanned && !isMobile && (
          <div
            data-testid="chat-fan-zone"
            className="absolute top-1/2 rounded-l-[5rem]"
            style={{ right: FAN_ZONE.right, width: FAN_ZONE.width, height: FAN_ZONE.height, marginTop: FAN_ZONE.top }}
          />
        )}

        <div className="pointer-events-none absolute right-0 top-1/2 h-0 w-0" aria-hidden={!fanned}>
          {fanIds.map((id, index) => {
            const name = id === ASSISTANT_ID ? ASSISTANT_NAME : people.get(id)?.name ?? '?';
            const roomId = dmRoom(me ?? '', id);
            return (
              <button
                key={id}
                type="button"
                tabIndex={fanned ? 0 : -1}
                data-testid="chat-fan-circle"
                onClick={() => {
                  setIsFanned(false);
                  openChatPanel(roomId);
                }}
                aria-label={`和 ${name} 私聊`}
                className={cn(
                  'group absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full shadow-lg ring-2 ring-white transition-all duration-200 ease-out hover:scale-110 dark:ring-gray-800',
                  fanned ? 'pointer-events-auto' : 'pointer-events-none',
                )}
                style={fanStyle(index, fanned)}
              >
                <MemberAvatar id={id} className="h-8 w-8 text-xs" />
                {(directUnread.get(roomId) ?? 0) > 0 && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-400 ring-2 ring-background" />}
                <span className="pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  {name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {open && <Panel personIds={personIds} isMobile={isMobile} />}
    </>
  );
}
