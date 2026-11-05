import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2, MessageSquare, Play, Send, Square, Upload, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import WhoAmI from '@/modules/sidebar/WhoAmI';
import { askToolAssist, claimsChange } from '@/shared/customTools';
import type { AssistMessage } from '@/shared/customTools';
import { useEscapeClose } from '@/shared/escapeStack';
import { cn } from '@/shared/utils';

export type AssistOptions = {
  /** Tool id the server knows (server/modules/providers/services/tool-assist). */
  tool: string;
  /** What the AI should see right now (the board, the table…); sent as JSON. */
  getContext: () => unknown;
  /** Applies what the AI sent back; returns a note added under its reply (e.g. 「已更新，可按復原」). */
  onResult: (result: unknown) => string | void;
  chat: AssistMessage[];
  onChatChange: (chat: AssistMessage[]) => void;
  /** Shown while the chat is empty. */
  intro: string;
  placeholder?: string;
  busyText?: string;
  /** The person's project: the AI runs there with their CLAUDE.md and memory (tools the server allows it for). */
  projectId?: string | null;
};

export type ImportOptions = {
  /** File input accept list, e.g. ".csv,.tsv,.xlsx". */
  accept: string;
  /** Tooltip on the 匯入 button and the line shown while dragging a file over the window. */
  hint: string;
  /** Reads the files and puts them in the tool; returns a message to show (what came in, or why not). */
  onFiles: (files: File[]) => Promise<string> | string;
};

type ToolFrameProps = {
  icon: LucideIcon;
  title: string;
  profileName: string;
  /** Next to the title: pickers, tabs, buttons. */
  headerExtra?: ReactNode;
  /** Shown in the header when a save failed. */
  failed?: boolean;
  isMobile: boolean;
  onClose: () => void;
  assist?: AssistOptions;
  /** Bottom bar; omitted = no 開工. */
  startWork?: {
    hint: string;
    disabled: boolean;
    /** Null when the profile has no project to start work in. */
    onStart: (() => void) | null;
    label?: string;
  };
  /** 匯入 button in the header, and files dropped anywhere on the window. */
  importer?: ImportOptions;
  /** Extra buttons in the bottom bar, left of 開工. */
  footerExtra?: ReactNode;
  children: ReactNode;
};

const MAX_CHAT = 40;

/** Stays mounted while the chat is hidden so a running answer still lands; unmounting (closing the tool) stops it. */
function AssistPanel({ assist, isMobile, hidden }: { assist: AssistOptions; isMobile: boolean; hidden: boolean }) {
  const [message, setMessage] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = useRef<AbortController | null>(null);
  const busy = startedAt !== null;
  const chatRef = useRef(assist.chat);
  chatRef.current = assist.chat;
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [assist.chat, busy]);

  useEffect(() => {
    if (startedAt === null) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [startedAt]);

  useEffect(() => () => {
    const controller = running.current;
    running.current = null;
    controller?.abort();
  }, []);

  const send = async () => {
    const text = message.trim();
    if (!text || busy) return;
    const history = chatRef.current;
    const withQuestion = [...history, { role: 'user' as const, text }].slice(-MAX_CHAT);
    assist.onChatChange(withQuestion);
    setMessage('');
    const controller = new AbortController();
    running.current = controller;
    const started = Date.now();
    setStartedAt(started);
    setNow(started);
    const answer = await askToolAssist(assist.tool, { message: text, context: assist.getContext(), chat: history, projectId: assist.projectId }, controller.signal);
    // Closed while waiting: nobody is looking at this answer any more.
    if (running.current !== controller) return;
    running.current = null;
    setStartedAt(null);
    if (controller.signal.aborted) {
      assist.onChatChange([...chatRef.current, { role: 'assistant' as const, text: '已停止，這次沒有套用任何修改。' }].slice(-MAX_CHAT));
      return;
    }
    let reply = answer.reply || '（沒有回覆文字）';
    if (answer.result !== null && answer.result !== undefined) {
      try {
        const note = assist.onResult(answer.result);
        if (note) reply += `\n（${note}）`;
      } catch {
        reply += '\n（AI 給的內容格式不對，沒有套用）';
      }
    } else if (answer.lostResult || claimsChange(reply)) {
      reply += '\n（AI 有回覆但沒產生可套用的結果，工具沒有變動）';
    }
    assist.onChatChange([...chatRef.current, { role: 'assistant' as const, text: reply }].slice(-MAX_CHAT));
  };

  const waited = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <div className={cn('flex min-h-0 flex-col border-l border-border bg-background', isMobile ? 'absolute inset-x-0 bottom-0 z-20 h-1/2 border-t' : 'w-80 shrink-0', hidden && 'hidden')} data-tutorial-tip="AI 助手：跟它說要做什麼，它會幫你改這個工具的內容">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {assist.chat.length === 0 && <p data-tutorial className="text-xs leading-relaxed text-muted-foreground">{assist.intro}</p>}
        {assist.chat.map((item, index) => (
          <div
            key={index}
            className={cn(
              'whitespace-pre-wrap rounded-lg px-2.5 py-1.5',
              item.role === 'user' ? 'ml-6 bg-primary text-primary-foreground' : 'mr-6 bg-muted text-foreground',
            )}
          >
            {item.text}
          </div>
        ))}
        {busy && (
          <div className="mr-6 flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {assist.busyText ?? 'AI 正在想（通常 10–30 秒）'}，已等 {waited} 秒
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="flex items-end gap-1.5 border-t border-border p-2">
        <textarea
          aria-label="跟 AI 說"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={assist.placeholder ?? '要做什麼？'}
          className="min-h-0 flex-1 resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => running.current?.abort()}
            aria-label="停止"
            title="停止這次 AI 回覆"
            className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground hover:bg-muted"
          >
            <Square className="h-3.5 w-3.5" />
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!message.trim()}
            aria-label="送出"
            className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * DHC CLI 10/14 工具庫: the full-screen window every tool shares, like 規劃白板: header (name, whose, extras,
 * close), the tool itself, the AI chat on the right, and a bottom bar with 開工.
 */
export default function ToolFrame({
  icon: Icon, title, profileName, headerExtra, failed, isMobile, onClose, assist, startWork, importer, footerExtra, children,
}: ToolFrameProps) {
  const [showChat, setShowChat] = useState(!isMobile);
  const [dragging, setDragging] = useState(false);
  const [importNote, setImportNote] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const takeFiles = async (files: File[]) => {
    if (!importer || files.length === 0) return;
    setImportNote('匯入中…');
    try {
      setImportNote(await importer.onFiles(files));
    } catch (error) {
      setImportNote(`匯入失敗：${(error as Error).message || '讀不懂這個檔案'}`);
    }
  };
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  useEscapeClose(onClose);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-background"
      role="dialog"
      aria-label={title}
      onDragEnter={importer ? (event) => { if (!hasFiles(event)) return; dragDepth.current += 1; setDragging(true); } : undefined}
      onDragLeave={importer ? () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); } : undefined}
      onDragOver={importer ? (event) => { if (hasFiles(event)) event.preventDefault(); } : undefined}
      onDrop={importer ? (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void takeFiles(Array.from(event.dataTransfer.files));
      } : undefined}
    >
      {dragging && importer && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 text-sm text-foreground">
          放開就匯入：{importer.hint}
        </div>
      )}
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3">
        <Icon className="h-4 w-4 shrink-0 text-primary" />
        <span className="shrink-0 text-sm font-semibold text-foreground">{title}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title="跟著這台裝置的專案設定（帳號）走，別人看不到">{profileName}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">{headerExtra}</div>
        {importer && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={importer.accept}
              className="hidden"
              data-testid="tool-import-input"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void takeFiles(files);
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              title={`${importer.hint}（也可以直接把檔案拖進視窗）`}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
            >
              <Upload className="h-3.5 w-3.5" />
              匯入
            </button>
          </>
        )}
        {importNote && (
          <button type="button" onClick={() => setImportNote('')} title="按一下關掉" className="max-w-[24rem] truncate text-xs text-muted-foreground hover:text-foreground">
            {importNote}
          </button>
        )}
        {failed && <span className="truncate text-xs text-destructive">有變更沒存到伺服器，請稍後重新整理再確認。</span>}
        <button type="button" onClick={onClose} aria-label={`關閉${title}`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-auto">{children}</div>
        {assist && <AssistPanel assist={assist} isMobile={isMobile} hidden={!showChat} />}
      </div>
      {(assist || startWork || footerExtra) && (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-border bg-muted/40 px-3 py-2">
          {assist && (
            <button
              type="button"
              onClick={() => setShowChat(!showChat)}
              className={cn('flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted', showChat && 'border-primary text-primary')}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              AI 對話
            </button>
          )}
          {/* 10/25: no project for this device yet: pick it right here instead of 設定 → 專案設定. */}
          {startWork && !startWork.onStart
            ? <WhoAmI note="開工要知道你的專案，選好就能開工。" className="min-w-0 flex-1" />
            : <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{startWork?.hint}</span>}
          {footerExtra}
          {startWork && (
            <button
              type="button"
              onClick={() => startWork.onStart?.()}
              disabled={startWork.disabled || !startWork.onStart}
              className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
              {startWork.label ?? '開工'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
