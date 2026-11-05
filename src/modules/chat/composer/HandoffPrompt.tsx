import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquarePlus } from 'lucide-react';

import { LONG_CONTEXT_TOKENS } from '@/modules/chat/composer/TokenUsageSummary';
import {
  fetchHandoffMoment,
  lastTurnTexts,
  readHandoffSnooze,
  requestHandoff,
  shouldAskHandoffMoment,
  shouldShowHandoff,
  writeHandoffSnooze,
} from '@/modules/chat/utils/handoffPrompt';

type HandoffPromptProps = {
  sessionId: string;
  /** Tokens in the conversation now (tokenBudget.used). */
  used: number;
  isProcessing: boolean;
  messages: Array<{ type: string; content?: unknown; isToolUse?: boolean; isThinking?: boolean }>;
  /** What the page sends the handoff turns with, so they run like this conversation's normal turns. */
  getRunOptions: () => { permissionMode?: string; toolsSettings?: unknown; skipPermissions?: boolean };
  onOpenSession: (sessionId: string) => void;
};

/**
 * DHC CLI 10/24 長對話交接: the card under the composer that offers a new conversation once a long one reaches a
 * stopping point. Render it with key={sessionId}: a card, a snooze check or a running handoff never carry over to
 * another conversation. The old conversation is left as it is.
 */
export default function HandoffPrompt({ sessionId, used, isProcessing, messages, getRunOptions, onOpenSession }: HandoffPromptProps) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Set when a turn ends while this view is open; cleared once the judge has been asked (or the next turn starts).
  const [turnEnded, setTurnEnded] = useState(false);
  const wasProcessing = useRef(isProcessing);
  const latest = useRef({ used, messages });
  latest.current = { used, messages };
  // The request is not cancelled when the effect re-runs (it clears turnEnded itself); only an unmount drops the answer.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (wasProcessing.current && !isProcessing) setTurnEnded(true);
    if (!wasProcessing.current && isProcessing) setTurnEnded(false);
    wasProcessing.current = isProcessing;
  }, [isProcessing]);

  // `used` moves a moment after the turn ends, so this also runs when it changes while a turn-end is waiting.
  useEffect(() => {
    if (!shouldAskHandoffMoment({
      used,
      longTokens: LONG_CONTEXT_TOKENS,
      isProcessing,
      turnJustCompleted: turnEnded,
      snoozedAt: readHandoffSnooze(sessionId),
      cardVisible: visible || busy,
    })) return;
    setTurnEnded(false);
    void fetchHandoffMoment(lastTurnTexts(latest.current.messages)).then((answer) => {
      if (alive.current && shouldShowHandoff(answer, latest.current.used)) setVisible(true);
    });
  }, [busy, isProcessing, sessionId, turnEnded, used, visible]);

  const startHandoff = useCallback(async () => {
    setBusy(true);
    setError('');
    const outcome = await requestHandoff(sessionId, getRunOptions());
    if (outcome.ok) {
      onOpenSession(outcome.newSessionId);
      return;
    }
    setBusy(false);
    setError(outcome.message);
  }, [getRunOptions, onOpenSession, sessionId]);

  const snooze = useCallback(() => {
    writeHandoffSnooze(sessionId, latest.current.used);
    setError('');
    setVisible(false);
  }, [sessionId]);

  // 10/31: the always-on "對話 xxK，換件事時開新對話" line is gone (nobody acted on it); only the stopping-point card stays.
  if (!visible && !busy) return null;
  const k = `${Math.round(used / 1000)}K`;
  return (
    <div className="px-4 pb-2">
      <div className="mx-auto flex w-full max-w-[54.25rem] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {busy ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            <span>交接中…舊對話正在寫交接（約 1 分鐘）</span>
          </div>
        ) : (
          <>
            <MessageSquarePlus className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-foreground">剛好告一段落</span>
              <span className="ml-2">對話 {k}，開新對話接手，之後每句都更省額度</span>
              {error && <div role="alert" className="mt-0.5 text-red-600 dark:text-red-400">{error}</div>}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <button type="button" onClick={snooze} className="rounded-md px-2.5 py-1 hover:bg-muted hover:text-foreground">
                暫緩
              </button>
              <button
                type="button"
                onClick={() => { void startHandoff(); }}
                className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:opacity-90"
              >
                開新對話接手
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
