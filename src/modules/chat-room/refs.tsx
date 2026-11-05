import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, User, Workflow } from 'lucide-react';

import { BotFace, PersonAvatar } from '@/modules/user-avatar';
import { useCoPeople } from '@/shared/coSessions';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import type { CoPerson } from '@/shared/coSessions';
import { loadCoBoards } from '@/shared/coBoards';
import { loadBoards } from '@/shared/planBoards';
import { readActiveSettingsProfileId } from '@/shared/userSettings';
import {
  ASSISTANT_ID,
  ASSISTANT_NAME,
  REF_DRAG_TYPE,
  clipLabel,
  dmRoom,
  keepMentioned,
  openChatPanel,
  requestOpenBoard,
  splitRefs,
  useBots,
  useChatMe,
} from '@/shared/chatRoom';
import type { ChatRef } from '@/shared/chatRoom';
import { cn } from '@/shared/utils';

// ---- what @ and @@ can pick: people and sessions come from the sidebar's projects, boards load on first use ----
type Candidates = { people: string[]; sessions: ChatRef[]; boards: ChatRef[] | null };
let candidates: Candidates = { people: [], sessions: [], boards: null };
let boardsLoading = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const setCandidates = (next: Partial<Candidates>) => {
  candidates = { ...candidates, ...next };
  listeners.forEach((listener) => listener());
};
export function setRefCandidates(people: string[], sessions: ChatRef[]): void {
  if (JSON.stringify([people, sessions]) === JSON.stringify([candidates.people, candidates.sessions])) return;
  setCandidates({ people, sessions: sessions.map((ref) => ({ ...ref, label: clipLabel(ref.label) })) });
}
export function ensureBoards(me: string | null): void {
  if (candidates.boards || boardsLoading) return;
  const profileId = readActiveSettingsProfileId();
  boardsLoading = true;
  Promise.all([
    profileId ? loadBoards(profileId, me).then((result) => result.boards).catch(() => []) : Promise.resolve([]),
    loadCoBoards(me).catch(() => []),
  ]).then(([own, shared]) => {
    const seen = new Set<string>();
    setCandidates({
      boards: [...shared, ...own]
        .filter((board) => !seen.has(board.id) && seen.add(board.id))
        .map((board) => ({ kind: 'board' as const, id: board.id, label: board.name })),
    });
  }).finally(() => { boardsLoading = false; });
}
export const useRefCandidates = () => useSyncExternalStore(subscribe, () => candidates, () => candidates);

const UNKNOWN: CoPerson = { name: '?', avatarId: null };
const ASSISTANT: CoPerson = { name: ASSISTANT_NAME, avatarId: null };
export const usePerson = (id: string) => {
  const found = useCoPeople().get(id);
  return id === ASSISTANT_ID ? ASSISTANT : found ?? UNKNOWN;
};

/** A face in the chat: a person's avatar, or 「助」 for 團隊小助理 so it never passes for a colleague (10/25: an own bot's answer shows its `face` character). */
export function MemberAvatar({ id, className, face }: { id: string; className?: string; face?: string | null }) {
  const person = usePerson(id);
  if (id !== ASSISTANT_ID) return <PersonAvatar person={person} className={className} />;
  return (
    <span role="img" aria-label={ASSISTANT_NAME} data-testid="assistant-avatar" className={cn('block shrink-0', className)}>
      <BotFace avatar={face} className="h-full w-full" />
    </span>
  );
}

/** What a click on a reference does: a person opens your private chat, a session or whiteboard jumps there. */
export function useRefAction() {
  const navigate = useNavigate();
  const me = useChatMe();
  return (ref: ChatRef) => {
    if (ref.kind === 'person') {
      if (me && ref.id !== me) openChatPanel(dmRoom(me, ref.id));
    } else if (ref.kind === 'session') {
      if (/^[\w-]{1,80}$/.test(ref.id)) navigate(`/session/${encodeURIComponent(ref.id)}`);
    } else {
      requestOpenBoard(ref.id);
    }
  };
}

export const REF_STYLE: Record<ChatRef['kind'], string> = {
  person: 'bg-sky-500/12 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300',
  session: 'bg-violet-500/12 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300',
  board: 'bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300',
};

export function RefIcon({ kind, className }: { kind: ChatRef['kind']; className?: string }) {
  const Icon = kind === 'person' ? User : kind === 'session' ? MessageSquare : Workflow;
  return <Icon className={cn('h-3 w-3 shrink-0', className)} />;
}

export function RefChip({ chip }: { chip: ChatRef }) {
  const act = useRefAction();
  const hint = chip.kind === 'person' ? `和 ${chip.label} 私聊` : chip.kind === 'session' ? `跳到對話「${chip.label}」` : `打開白板「${chip.label}」`;
  return (
    <button
      type="button"
      title={hint}
      onClick={(event) => {
        event.stopPropagation();
        act(chip);
      }}
      className={cn('mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-px align-baseline text-[0.92em] font-medium transition-colors', REF_STYLE[chip.kind])}
    >
      {chip.kind === 'person' ? <MemberAvatar id={chip.id} className="h-3.5 w-3.5 text-[8px]" /> : <RefIcon kind={chip.kind} />}
      <span className="truncate">{chip.kind === 'person' ? '@' : ''}{chip.label}</span>
    </button>
  );
}

/** Text with its references as chips; line breaks kept. */
export function RefText({ text, refs, className }: { text: string; refs: ChatRef[]; className?: string }) {
  const parts = useMemo(() => splitRefs(text, refs), [text, refs]);
  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {parts.map((part, index) => ('ref' in part ? <RefChip key={index} chip={part.ref} /> : <span key={index}>{part.text}</span>))}
    </span>
  );
}

/** A reference carried by a drag: a session row from the sidebar, or a chip. */
export function readDroppedRef(event: DragEvent): ChatRef | null {
  const raw = event.dataTransfer.getData(REF_DRAG_TYPE);
  if (raw) {
    try {
      const ref = JSON.parse(raw) as ChatRef;
      if (ref && ref.id && ref.label) return { ...ref, label: clipLabel(ref.label) };
    } catch {
      // Not ours.
    }
  }
  const sessionId = event.dataTransfer.getData('application/x-dhc-session');
  if (sessionId) return { kind: 'session', id: sessionId, label: candidates.sessions.find((item) => item.id === sessionId)?.label ?? '對話' };
  return null;
}
export const carriesRef = (event: DragEvent) => event.dataTransfer.types.includes(REF_DRAG_TYPE) || event.dataTransfer.types.includes('application/x-dhc-session');

/** 10/25: `text` is set for a team role or a bot: picking it types its first mention as plain text (no chip), with `face` as its avatar. */
type Suggestion = { ref: ChatRef; hint: string; text?: string; face?: string };
export type Query = { start: number; kind: 'person' | 'item'; text: string };

/** The @ or @@ being typed just before the caret, if any. */
export function queryAt(value: string, caret: number): Query | null {
  const before = value.slice(0, caret);
  const match = /(^|[\s(（，,。])(@@?)([^\s@]{0,20})$/.exec(before);
  if (!match) return null;
  const start = before.length - match[2].length - match[3].length;
  return { start, kind: match[2] === '@@' ? 'item' : 'person', text: match[3].toLowerCase() };
}

type RefInputProps = {
  value: string;
  refs: ChatRef[];
  onChange: (value: string, refs: ChatRef[]) => void;
  onSubmit?: () => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  autoFocus?: boolean;
  /** Extra controls under the suggestions, e.g. the send button row. */
  children?: ReactNode;
  textareaClassName?: string;
};

/**
 * A text box that knows references: @ lists people, @@ lists sessions and whiteboards, and a session dragged in
 * from the sidebar drops in as @@title. Enter sends (Shift+Enter is a new line) when `onSubmit` is given.
 */
export function RefInput({ value, refs, onChange, onSubmit, placeholder, className, rows = 2, autoFocus, children, textareaClassName }: RefInputProps) {
  const box = useRef<HTMLTextAreaElement>(null);
  const me = useChatMe();
  const people = useCoPeople();
  const { people: personIds, sessions, boards } = useRefCandidates();
  const bots = useBots();
  const [query, setQuery] = useState<Query | null>(null);
  const [cursor, setCursor] = useState(0);
  const [dropping, setDropping] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (pendingCaret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  useEffect(() => {
    if (query?.kind === 'item') ensureBoards(me);
  }, [query?.kind, me]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!query) return [];
    const match = (label: string) => label.toLowerCase().includes(query.text);
    if (query.kind === 'person') {
      const persons = [ASSISTANT_ID, ...personIds.filter((id) => id !== ASSISTANT_ID)]
        .map((id) => ({ ref: { kind: 'person' as const, id, label: id === ASSISTANT_ID ? ASSISTANT_NAME : people.get(id)?.name ?? id }, hint: id === me ? '你自己' : id === ASSISTANT_ID ? 'AI 同事' : '' }))
        .filter((item) => match(item.ref.label))
        .slice(0, 6);
      // 10/25: the team roles, then (with 自建小助理 on) my bots and the others' public ones, found by name or mention.
      const helper = (id: string, name: string, mentions: string[], hint: string, face: string): Suggestion => ({ ref: { kind: 'person', id: `helper:${id}`, label: name }, hint, text: mentions[0], face });
      const helpers = [
        ...bots.team.map((role) => helper(role.id, role.name, role.mentions, '團隊角色', Array.from(role.name)[0] ?? '')),
        ...(bots.enabled ? bots.mine.map((bot) => helper(bot.id, bot.name, bot.mentions, `我的${bot.visibility === 'private' ? '（私人）' : ''}`, bot.avatar)) : []),
        ...(bots.enabled ? bots.public.map((bot) => helper(bot.id, bot.name, bot.mentions, `${bot.ownerName || '同事'}的`, bot.avatar)) : []),
      ].filter((item) => item.text && (match(item.ref.label) || match(item.text) || match(item.text.slice(1))));
      return [...persons, ...helpers.slice(0, 5)];
    }
    return [
      ...sessions.filter((item) => match(item.label)).slice(0, 6).map((ref) => ({ ref, hint: '對話' })),
      ...(boards ?? []).filter((item) => match(item.label)).slice(0, 4).map((ref) => ({ ref, hint: '白板' })),
    ];
  }, [query, personIds, people, me, sessions, boards, bots]);

  const insert = (ref: ChatRef, at?: Query | null, text?: string) => {
    const token = text ? `${text} ` : `${ref.kind === 'person' ? '@' : '@@'}${ref.label} `;
    const el = box.current;
    const caret = el?.selectionStart ?? value.length;
    const from = at ? at.start : caret;
    const next = value.slice(0, from) + token + value.slice(caret);
    onChange(next, keepMentioned(next, text ? refs : [...refs, ref]));
    setQuery(null);
    // Put the caret after the token as soon as the new value is in the box (a later frame would race fast typing).
    pendingCaret.current = from + token.length;
  };

  const update = (next: string, caret: number) => {
    onChange(next, keepMentioned(next, refs));
    setQuery(queryAt(next, caret));
    setCursor(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (query && suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insert(suggestions[cursor].ref, query, suggestions[cursor].text);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setQuery(null);
        return;
      }
    }
    // 11/01: same rule as the main composer (read at the key press, so the quick setting takes effect at once):
    // Ctrl/⌘+Enter always sends, a bare Enter sends unless 「使用 Ctrl+Enter 傳送」 is on.
    if (onSubmit && event.key === 'Enter' && !event.shiftKey && (event.ctrlKey || event.metaKey || !readStoredUiPreferences().sendByCtrlEnter)) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={cn('relative', className)}>
      <textarea
        ref={box}
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(event) => update(event.target.value, event.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        onDragOver={(event) => {
          if (!carriesRef(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          const ref = readDroppedRef(event);
          setDropping(false);
          if (!ref) return;
          event.preventDefault();
          event.stopPropagation();
          insert(ref);
        }}
        className={cn(
          'w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70',
          dropping && 'rounded-md ring-2 ring-violet-400/60',
          textareaClassName,
        )}
      />
      {query && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
          <div className="px-2 pb-1 pt-0.5 text-[10px] text-muted-foreground">{query.kind === 'person' ? '標記人或叫小助理（@）' : '標記對話或白板（@@）'}</div>
          {suggestions.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{query.kind === 'item' && !boards ? '載入中…' : '沒有符合的'}</div>
          ) : suggestions.map((item, index) => (
            <button
              key={`${item.ref.kind}:${item.ref.id}`}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                insert(item.ref, query, item.text);
              }}
              onMouseEnter={() => setCursor(index)}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs', index === cursor ? 'bg-accent text-accent-foreground' : 'text-foreground')}
            >
              {item.text
                ? <BotFace avatar={item.face} className="h-5 w-5 shrink-0 text-[10px]" />
                : item.ref.kind === 'person'
                ? <MemberAvatar id={item.ref.id} className="h-5 w-5 text-[10px]" />
                : <span className={cn('flex h-5 w-5 items-center justify-center rounded-full', REF_STYLE[item.ref.kind])}><RefIcon kind={item.ref.kind} /></span>}
              <span className="min-w-0 flex-1 truncate">{item.ref.label}{item.text && <span className="ml-1 text-[10px] text-sky-600 dark:text-sky-300">{item.text}</span>}</span>
              {item.hint && <span className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

/** Relative time in Chinese: 剛剛, 5 分鐘前, 14:05, 10/12. */
export function shortTime(at: string): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return '';
  const diff = Date.now() - time.getTime();
  if (diff < 60_000) return '剛剛';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  const sameDay = new Date().toDateString() === time.toDateString();
  const hm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${time.getMonth() + 1}/${time.getDate()} ${hm}`;
}
