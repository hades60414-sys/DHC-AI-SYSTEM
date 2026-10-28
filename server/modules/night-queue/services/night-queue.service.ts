import { nightQueueDb, sessionsDb } from '@/modules/database/index.js';
import type { NightQueueItemRow, NightQueueModeSettings } from '@/modules/database/index.js';
import {
  clearNightQueueBackoff,
  kickNightQueue,
} from '@/modules/night-queue/services/night-queue-dispatcher.service.js';
import { AppError } from '@/shared/utils.js';

const MAX_CONTENT_LENGTH = 100_000;

/** An alarm further out than this is almost certainly a mistake (the picker offers the next 24 hours). */
const MAX_ALARM_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

export type NightQueueItem = {
  id: string;
  sessionId: string;
  content: string;
  attachmentCount: number;
  status: NightQueueItemRow['status'];
  runNow: boolean;
  /** 1-based place in the whole queue (every session), for waiting items. */
  position: number | null;
  failureReason: string | null;
  /** The alarm this prompt waits for (UTC ISO), or null for the night window. */
  startAt: string | null;
  useBypass: boolean;
  createdAt: string;
};

/** Everything the composer needs for one session: its night-mode settings (null = off) and unfinished items. */
export type NightQueueState = {
  sessionId: string;
  enabled: boolean;
  mode: NightQueueModeSettings | null;
  items: NightQueueItem[];
};

/** One sidebar moon: night mode on and/or prompts not yet finished. */
export type NightQueueMark = {
  sessionId: string;
  enabled: boolean;
  /** Prompts waiting or running. */
  queued: number;
};

const NIGHT_WINDOW_SETTINGS: NightQueueModeSettings = { startAt: null, useBypass: false };

function countAttachments(rawOptions: string): number {
  try {
    const options = JSON.parse(rawOptions) as { attachments?: unknown };
    return Array.isArray(options?.attachments) ? options.attachments.length : 0;
  } catch {
    return 0;
  }
}

function requireSession(sessionId: string): void {
  if (!sessionsDb.getSessionById(sessionId)) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }
}

function hasAttachments(options: unknown): boolean {
  const attachments = (options as { attachments?: unknown } | null | undefined)?.attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

/** A start time from a request: null (none given) or a real instant that is still coming, within 14 days. */
export function readStartAt(raw: unknown, now: Date = new Date()): string | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const startAt = typeof raw === 'string' ? new Date(raw) : null;
  if (!startAt || Number.isNaN(startAt.getTime())) {
    throw new AppError('開跑時間看不懂，請重新寫一次（例如 @12:05）。', { code: 'INVALID_START_AT', statusCode: 400 });
  }
  // A minute of slack: the browser and this host do not share a clock (this one runs ~40 s slow).
  if (startAt.getTime() < now.getTime() - 60_000) {
    throw new AppError('開跑時間已經過了，請重新寫一次。', { code: 'START_AT_PASSED', statusCode: 400 });
  }
  if (startAt.getTime() - now.getTime() > MAX_ALARM_AHEAD_MS) {
    throw new AppError('開跑時間太遠了（最多 14 天內）。', { code: 'START_AT_TOO_FAR', statusCode: 400 });
  }
  return startAt.toISOString();
}

/** Night-mode settings from a request: no start time means the night window. */
export function readModeSettings(raw: unknown, now: Date = new Date()): NightQueueModeSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as { startAt?: unknown; useBypass?: unknown };
  return { startAt: readStartAt(value.startAt, now), useBypass: value.useBypass === true };
}

export const nightQueueService = {
  /** Every session the sidebar marks with a moon — one request for the whole list instead of one per row. */
  listMarks(): NightQueueMark[] {
    return nightQueueDb.listMarkedSessions().map((row) => ({
      sessionId: row.session_id,
      enabled: row.enabled === 1,
      queued: row.queued,
    }));
  },

  getState(sessionId: string): NightQueueState {
    const positions = new Map(nightQueueDb.listPendingInOrder().map((row, index) => [row.id, index + 1]));
    const mode = nightQueueDb.getMode(sessionId);
    return {
      sessionId,
      enabled: mode !== null,
      mode,
      items: nightQueueDb.listForSession(sessionId).map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        content: row.content,
        attachmentCount: countAttachments(row.options),
        status: row.status,
        runNow: row.run_now === 1,
        position: positions.get(row.id) ?? null,
        failureReason: row.failure_reason,
        startAt: row.start_at,
        useBypass: row.use_bypass === 1,
        createdAt: row.created_at,
      })),
    };
  },

  /** Turns night mode on with the given settings (night window or alarm, bypass or not), or off. */
  setEnabled(sessionId: string, enabled: boolean, settings: NightQueueModeSettings = NIGHT_WINDOW_SETTINGS): NightQueueState {
    requireSession(sessionId);
    if (!enabled) {
      // Turning it off while prompts wait would leave them to run later anyway; that choice is "run now"
      // or "cancel all". Guards a tab whose list is stale (items stored from another device).
      if (nightQueueDb.countPending(sessionId) > 0) {
        throw new AppError('這個對話還有已存的 prompt，請選「立即執行」或「全部取消」。', {
          code: 'NIGHT_QUEUE_HAS_PENDING',
          statusCode: 409,
        });
      }
      nightQueueDb.clearMode(sessionId);
    } else {
      nightQueueDb.setMode(sessionId, settings);
    }
    return nightQueueService.getState(sessionId);
  },

  /**
   * Stores one prompt under the session's settings. `mode` is what the composer showed — used when the
   * session has no settings of its own yet (a new chat whose first prompt just created it). `startAt` is
   * this prompt's own time (the user wrote "@12:05" at its start) and wins over the session's default.
   */
  enqueue(input: {
    userId: number;
    sessionId: string;
    content: string;
    options?: unknown;
    mode?: NightQueueModeSettings;
    startAt?: string | null;
  }): NightQueueState {
    const content = input.content.trim();
    if (!content && !hasAttachments(input.options)) {
      throw new AppError('沒有內容可以存。', {
        code: 'CONTENT_REQUIRED',
        statusCode: 400,
      });
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new AppError(`內容太長，夜間排程一則最多 ${MAX_CONTENT_LENGTH.toLocaleString()} 字。`, {
        code: 'CONTENT_TOO_LONG',
        statusCode: 400,
      });
    }
    requireSession(input.sessionId);

    nightQueueDb.enqueue({
      userId: input.userId,
      sessionId: input.sessionId,
      content,
      options: input.options ?? {},
      mode: input.mode ?? NIGHT_WINDOW_SETTINGS,
      startAt: input.startAt ?? null,
    });
    // Stored when it may already start (inside the window, alarm passed) with the lane idle: go now.
    kickNightQueue();
    return nightQueueService.getState(input.sessionId);
  },

  runNow(sessionId: string): NightQueueState {
    requireSession(sessionId);
    nightQueueDb.markRunNow(sessionId);
    clearNightQueueBackoff();
    kickNightQueue();
    return nightQueueService.getState(sessionId);
  },

  cancelAll(sessionId: string): NightQueueState {
    requireSession(sessionId);
    nightQueueDb.cancelAll(sessionId);
    return nightQueueService.getState(sessionId);
  },

  /** Cancels one waiting item, or dismisses a failed one. */
  cancel(id: string): NightQueueState {
    const sessionId = nightQueueDb.cancel(id);
    if (!sessionId) {
      throw new AppError('這則已經跑過或取消了。', {
        code: 'NIGHT_QUEUE_ITEM_NOT_PENDING',
        statusCode: 409,
      });
    }
    return nightQueueService.getState(sessionId);
  },
};
