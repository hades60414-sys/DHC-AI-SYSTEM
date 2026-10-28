import { nightQueueDb, sessionsDb } from '@/modules/database/index.js';
import type { NightQueueItemRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/** The night window, in the server's local time: items start from 02:00 and none start at or after 07:00. */
export const NIGHT_START_HOUR = 2;
export const NIGHT_END_HOUR = 7;

const POLL_INTERVAL_MS = 30_000;

/**
 * A question (AskUserQuestion / ExitPlanMode) waits for an answer indefinitely, so one the running item asks
 * would hold up the whole single-lane queue until someone looks. It is answered for the user after a minute
 * for prompts that started on their own (night window, alarm) — nobody is there — and after five for one the
 * user started with "run now", who may be watching. Ordinary tool approvals time out by themselves (55 s).
 */
export const QUESTION_WAIT_UNATTENDED_MS = 60_000;
export const QUESTION_WAIT_RUN_NOW_MS = 5 * 60_000;

/** Runs of one item that may be cut off (restart) or fail (usage limit, API error) before it is given up. */
export const MAX_ATTEMPTS = 3;

/**
 * After a failed run nothing starts for this long. A usage limit or an API outage fails every prompt within
 * seconds; without a pause the whole queue would be used up in a minute. "Run now" lifts the pause.
 */
export const RETRY_BACKOFF_MS = 15 * 60_000;

export const RESUME_NOTE =
  '【夜間分流】上一次執行這則沒有完成（DHC CLI 重新啟動或執行出錯）。請先檢查目前進度，已完成的部分不要重做，接著完成下面這個原本的指示：';

export const UNATTENDED_NOTE =
  '這是夜間分流排程的工作，沒有人在線上可以回答或核准。不要等待：採用你判斷最合理的做法繼續完成工作，並在最後的回覆列出你替使用者做的假設，以及被略過、需要人工確認的步驟。';

/**
 * Told to the model up front on every queued run — as an appended system prompt for Claude, ahead of the
 * prompt text for other providers — so it does not stop to ask, gets as far as it can, leaves irreversible
 * or outward actions to the user, and ends with a summary the user reads in the morning.
 */
export const UNATTENDED_SYSTEM_NOTE = [
  '這個工作是 DHC CLI 排程（夜間分流／鬧鐘）自動送出的，執行時沒有人在線上，也沒有人能回答問題或按「允許」。',
  '- 不要發問、不要等待確認：採用最合理的假設繼續做，並記下你的假設。',
  '- 盡量把能做的做完。某一步卡住就換個做法，或先完成其他部分，不要整個停下來。',
  '- 除非使用者在 prompt 裡明確要求，否則不可逆或對外的動作一律不做，改成記下來留給使用者：刪除或覆寫重要資料、付款或下單、修改權限或帳號設定、寄信／發訊息／對外發布、推送到遠端。',
  '- 需要登入、密碼、驗證碼或人工確認的步驟也先跳過並記錄。',
  '- 最後的回覆要有一段「排程進度摘要」：已完成、未完成、卡住的原因、需要使用者決定的事。',
].join('\n');

const STOPPED_REASON = '執行中被停止（有人按了停止，或在這個對話送出了新訊息）。';
const GENERIC_FAILURE = '執行沒有正常結束（可能是用量上限或 API 錯誤），詳見對話。';

export function isNightWindow(now: Date): boolean {
  const hour = now.getHours();
  return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
}

/** The one item running right now. The queue is a single lane: nothing else starts until it settles. */
let active: { itemId: string; sessionId: string; runNow: boolean } | null = null;

/** Epoch ms before which nothing starts, after a failed run. */
let pausedUntil = 0;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRuntime: ProviderRuntimeGateway | null = null;
let unsubscribeRunCompleted: (() => void) | null = null;

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Lifts the pause that follows a failed run — "run now" means now. */
export function clearNightQueueBackoff(): void {
  pausedUntil = 0;
}

type RunRecord = ReturnType<typeof chatRunRegistry.getRun>;

/**
 * How a finished run went, from its own event log: the first `complete` is authoritative (exit code, aborted),
 * and an `error` event or the last assistant text says why. Null when the turn finished normally.
 */
export function readRunFailure(run: RunRecord): { reason: string; stopped: boolean } | null {
  let complete: { exitCode?: unknown; aborted?: unknown } | null = null;
  let errorText = '';
  let lastText = '';
  for (const event of run?.events ?? []) {
    if (event.kind === 'complete') {
      complete ??= event as { exitCode?: unknown; aborted?: unknown };
    } else if (event.kind === 'error' && typeof event.content === 'string') {
      errorText = event.content;
    } else if (event.kind === 'text' && event.role === 'assistant' && typeof event.content === 'string') {
      lastText = event.content;
    }
  }

  if (!complete) {
    return null;
  }
  if (complete.aborted) {
    return { reason: STOPPED_REASON, stopped: true };
  }
  if (complete.exitCode !== 0) {
    const reason = (errorText || lastText).trim();
    return { reason: reason ? reason.slice(0, 300) : GENERIC_FAILURE, stopped: false };
  }
  return null;
}

/** "Run now" items at any hour; alarm items from their time on (no cutoff); the rest inside the night window. */
function isDue(item: NightQueueItemRow, now: Date): boolean {
  if (item.run_now) {
    return true;
  }
  if (item.start_at) {
    return new Date(item.start_at).getTime() <= now.getTime();
  }
  return isNightWindow(now);
}

/**
 * The next item allowed to start, in dispatch order, and nothing while paused after a failure. A session that
 * is busy (someone is chatting in it) is skipped for now — all of its items together, so they still run in
 * their stored order — and the next session's item goes instead.
 */
export function pickNextItem(now: Date): NightQueueItemRow | null {
  if (now.getTime() < pausedUntil) {
    return null;
  }
  for (const item of nightQueueDb.listPendingInOrder()) {
    if (isDue(item, now) && !chatRunRegistry.isProcessing(item.session_id)) {
      return item;
    }
  }
  return null;
}

/**
 * The turn as it is sent: the resume note after a cut-off or failed try, bypass when the user agreed to it
 * (plan mode stays plan — it only ever plans), and the unattended instructions.
 */
export function buildRunInput(item: NightQueueItemRow): { content: string; options: Record<string, unknown> } {
  let content = item.attempts > 0 ? `${RESUME_NOTE}\n\n${item.content}` : item.content;
  const options = readOptions(item.options);
  if (item.use_bypass === 1 && options.permissionMode !== 'plan') {
    options.permissionMode = 'bypassPermissions';
  }
  if (sessionsDb.getSessionById(item.session_id)?.provider === 'claude') {
    options.appendSystemPrompt = UNATTENDED_SYSTEM_NOTE;
  } else {
    content = `【無人值守排程】\n${UNATTENDED_SYSTEM_NOTE}\n\n---\n\n${content}`;
  }
  return { content, options };
}

/** Runs one claimed item to the end. False when its run never started because the session got busy first. */
async function runItem(item: NightQueueItemRow, runtime: ProviderRuntimeGateway, now: Date): Promise<boolean> {
  // `item` is the row as it was before the claim: an earlier attempt means that run did not finish.
  const attempt = item.attempts + 1;
  const { content, options } = buildRunInput(item);

  try {
    const settled = runDetachedChatTurn(
      {
        sessionId: item.session_id,
        userId: item.user_id,
        content,
        options,
      },
      { runtime },
    );
    // The run is registered synchronously inside the call above, so when it started at all this is ours —
    // kept by reference, because another run may take the session's slot as soon as ours ends.
    const run = chatRunRegistry.getRun(item.session_id);
    const result = await settled;

    if (!result.started && /already in progress/i.test(result.error ?? '')) {
      nightQueueDb.release(item.id);
      return false;
    }
    if (!result.started) {
      nightQueueDb.finish(item.id, 'failed', result.error ?? '這個對話已不存在，無法執行。');
      return true;
    }

    const failure = result.error
      ? { reason: result.error, stopped: false }
      : readRunFailure(run);
    if (!failure) {
      nightQueueDb.finish(item.id, 'done');
      return true;
    }
    if (failure.stopped) {
      nightQueueDb.finish(item.id, 'failed', failure.reason);
      return true;
    }

    // Whatever failed this run (a usage limit, an outage) will fail the next one too: pause the lane first.
    // Timed from whichever is later, the dispatch clock or the moment of failure.
    pausedUntil = Math.max(now.getTime(), Date.now()) + RETRY_BACKOFF_MS;
    if (attempt >= MAX_ATTEMPTS) {
      nightQueueDb.finish(item.id, 'failed', `試了 ${attempt} 次都沒有完成：${failure.reason}`);
    } else {
      nightQueueDb.requeue(item.id, failure.reason);
    }
    return true;
  } catch (error) {
    nightQueueDb.finish(item.id, 'failed', error instanceof Error ? error.message : String(error));
    return true;
  }
}

/**
 * Starts the next item if the lane is free, and resolves when that item's run settles.
 * Exported so a test can drive one pass with a chosen clock.
 */
export async function dispatchNightQueue(runtime: ProviderRuntimeGateway, now: Date = new Date()): Promise<boolean> {
  if (active) {
    return false;
  }
  const item = pickNextItem(now);
  if (!item || !nightQueueDb.claim(item.id)) {
    return false;
  }

  active = { itemId: item.id, sessionId: item.session_id, runNow: item.run_now === 1 };
  try {
    return await runItem(item, runtime, now);
  } finally {
    active = null;
  }
}

/** Answers, on the user's behalf, a question the running item has been waiting on for too long. */
export function answerStalledQuestions(runtime: ProviderRuntimeGateway, now: Date = new Date()): number {
  if (!active) {
    return 0;
  }

  const waitMs = active.runNow ? QUESTION_WAIT_RUN_NOW_MS : QUESTION_WAIT_UNATTENDED_MS;
  let answered = 0;
  for (const request of runtime.getPendingApprovalsForSession(active.sessionId)) {
    const { requestId, receivedAt } = (request ?? {}) as { requestId?: unknown; receivedAt?: unknown };
    const waitingSince = new Date(receivedAt as string | number | Date).getTime();
    if (
      typeof requestId !== 'string'
      || !Number.isFinite(waitingSince)
      || now.getTime() - waitingSince < waitMs
    ) {
      continue;
    }
    runtime.resolveToolApproval(requestId, { allow: false, message: UNATTENDED_NOTE });
    answered += 1;
  }
  return answered;
}

function poll(): void {
  const runtime = pollRuntime;
  if (!runtime) {
    return;
  }

  try {
    nightQueueDb.expireAlarms(new Date());
    answerStalledQuestions(runtime);
  } catch (error) {
    console.error('[NightQueue] Housekeeping pass failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  void dispatchNightQueue(runtime)
    .then((settled) => {
      // Straight on to the next item instead of waiting for the timer (a pause after a failure still holds).
      if (settled) poll();
    })
    .catch((error: unknown) => {
      console.error('[NightQueue] Dispatch pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/** Looks for work at once — after "run now", or a prompt stored inside the window. No-op before startup. */
export function kickNightQueue(): void {
  poll();
}

/**
 * Starts the night queue. Items the last server process left running were cut off, so they go back to
 * waiting first; inside the window (or marked "run now") they are picked up again on the first poll.
 */
export function initializeNightQueueDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }
  pollRuntime = runtime;

  const recovered = nightQueueDb.recoverInterrupted(MAX_ATTEMPTS);
  if (recovered.requeued || recovered.failed) {
    console.log('[NightQueue] Recovered items cut off by a restart', recovered);
  }

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  // A session that was busy frees up when its run ends; the item waiting on it should not wait for the timer.
  unsubscribeRunCompleted = chatRunRegistry.onRunCompleted(() => poll());
  poll();
}

export function closeNightQueueDispatcher(): void {
  unsubscribeRunCompleted?.();
  unsubscribeRunCompleted = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollRuntime = null;
}
