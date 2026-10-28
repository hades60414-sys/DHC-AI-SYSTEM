import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type NightQueueItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type NightQueueItemRow = {
  id: string;
  user_id: number;
  session_id: string;
  content: string;
  options: string;
  status: NightQueueItemStatus;
  run_now: number;
  attempts: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  start_at: string | null;
  use_bypass: number;
};

/** How a session's stored prompts start: an alarm instant (UTC ISO) or, when null, the night window. */
export type NightQueueModeSettings = {
  startAt: string | null;
  useBypass: boolean;
};

const COLUMNS =
  'id, user_id, session_id, content, options, status, run_now, attempts, failure_reason, created_at, updated_at, start_at, use_bypass';

/**
 * Storage for DHC CLI's night queue.
 *
 * Order is insertion order (rowid): the user asked for prompts to run in the
 * order they were stored, and created_at only has one-second resolution.
 */
export const nightQueueDb = {
  /** The session's night-mode settings, or null when night mode is off. */
  getMode(sessionId: string): NightQueueModeSettings | null {
    const row = getConnection()
      .prepare('SELECT start_at, use_bypass FROM night_queue_sessions WHERE session_id = ?')
      .get(sessionId) as { start_at: string | null; use_bypass: number } | undefined;
    return row ? { startAt: row.start_at, useBypass: row.use_bypass === 1 } : null;
  },

  setMode(sessionId: string, settings: NightQueueModeSettings): void {
    getConnection()
      .prepare(
        `INSERT INTO night_queue_sessions (session_id, start_at, use_bypass) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET start_at = excluded.start_at, use_bypass = excluded.use_bypass`,
      )
      .run(sessionId, settings.startAt, settings.useBypass ? 1 : 0);
  },

  clearMode(sessionId: string): void {
    getConnection().prepare('DELETE FROM night_queue_sessions WHERE session_id = ?').run(sessionId);
  },

  /**
   * An alarm is one-shot: once its time comes the session leaves night mode, so what the user types
   * afterwards is sent normally again. The prompts it held keep their own start time and still run.
   */
  expireAlarms(now: Date): number {
    return getConnection()
      .prepare('DELETE FROM night_queue_sessions WHERE start_at IS NOT NULL AND start_at <= ?')
      .run(now.toISOString()).changes;
  },

  /**
   * Stores a prompt at the back of the queue under the session's night-mode settings. Storing one is what
   * night mode means, so a session without a mode row (a new chat's first prompt) gets one from `mode`.
   * `startAt`, when given, is this prompt's own start time and overrides the session's.
   */
  enqueue(input: {
    userId: number;
    sessionId: string;
    content: string;
    options: unknown;
    mode: NightQueueModeSettings;
    startAt?: string | null;
  }): NightQueueItemRow {
    const db = getConnection();
    const id = randomUUID();

    db.transaction(() => {
      let mode = nightQueueDb.getMode(input.sessionId);
      if (!mode) {
        nightQueueDb.setMode(input.sessionId, input.mode);
        mode = input.mode;
      }
      db.prepare(
        `INSERT INTO night_queue_items (id, user_id, session_id, content, options, start_at, use_bypass)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.userId,
        input.sessionId,
        input.content,
        JSON.stringify(input.options ?? {}),
        input.startAt ?? mode.startAt,
        mode.useBypass ? 1 : 0,
      );
    })();

    return db.prepare(`SELECT ${COLUMNS} FROM night_queue_items WHERE id = ?`).get(id) as NightQueueItemRow;
  },

  /** What the composer shows for one session: everything not yet finished, plus failures until dismissed. */
  listForSession(sessionId: string): NightQueueItemRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM night_queue_items
         WHERE session_id = ? AND status IN ('pending', 'running', 'failed')
         ORDER BY rowid ASC`,
      )
      .all(sessionId) as NightQueueItemRow[];
  },

  /** Every waiting item in dispatch order: "run now" items first, then the order they were stored in. */
  listPendingInOrder(): NightQueueItemRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM night_queue_items
         WHERE status = 'pending'
         ORDER BY run_now DESC, rowid ASC`,
      )
      .all() as NightQueueItemRow[];
  },

  /** DHC CLI sidebar moon: every session with night mode on or prompts not yet finished (waiting or running). */
  listMarkedSessions(): Array<{ session_id: string; enabled: number; queued: number }> {
    return getConnection()
      .prepare(
        `SELECT session_id, MAX(enabled) AS enabled, SUM(queued) AS queued FROM (
           SELECT session_id, 1 AS enabled, 0 AS queued FROM night_queue_sessions
           UNION ALL
           SELECT session_id, 0, 1 FROM night_queue_items WHERE status IN ('pending', 'running')
         ) GROUP BY session_id`,
      )
      .all() as Array<{ session_id: string; enabled: number; queued: number }>;
  },

  /** Moves a pending item to running. False when something else already took it or it was cancelled. */
  claim(id: string): boolean {
    return getConnection()
      .prepare(
        `UPDATE night_queue_items
         SET status = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
      )
      .run(id).changes > 0;
  },

  /** Puts back an item whose run never started (the session was busy after all), without counting the attempt. */
  release(id: string): void {
    getConnection()
      .prepare(
        `UPDATE night_queue_items
         SET status = 'pending', attempts = MAX(attempts - 1, 0), updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'running'`,
      )
      .run(id);
  },

  /** A run that failed on the way (usage limit, API error) waits to be tried again; the reason stays visible. */
  requeue(id: string, reason: string): void {
    getConnection()
      .prepare(
        `UPDATE night_queue_items
         SET status = 'pending', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'running'`,
      )
      .run(reason.slice(0, 500), id);
  },

  countPending(sessionId: string): number {
    const row = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM night_queue_items WHERE session_id = ? AND status = 'pending'`)
      .get(sessionId) as { n: number };
    return row.n;
  },

  finish(id: string, status: 'done' | 'failed', reason: string | null = null): void {
    getConnection()
      .prepare(
        `UPDATE night_queue_items
         SET status = ?, failure_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(status, reason ? reason.slice(0, 500) : null, id);
  },

  /** "Run now": the session's waiting items jump the queue, and new prompts in it are sent normally again. */
  markRunNow(sessionId: string): number {
    const db = getConnection();
    return db.transaction(() => {
      nightQueueDb.clearMode(sessionId);
      return db
        .prepare(
          `UPDATE night_queue_items SET run_now = 1, updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ? AND status = 'pending'`,
        )
        .run(sessionId).changes;
    })();
  },

  /** "Cancel all": drops the session's waiting items and failure notices, and turns night mode off. */
  cancelAll(sessionId: string): number {
    const db = getConnection();
    return db.transaction(() => {
      nightQueueDb.clearMode(sessionId);
      return db
        .prepare(
          `UPDATE night_queue_items SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ? AND status IN ('pending', 'failed')`,
        )
        .run(sessionId).changes;
    })();
  },

  /** Cancels one waiting item, or dismisses a failed one. Returns its session, or null if it had already run. */
  cancel(id: string): string | null {
    const db = getConnection();
    const row = db.prepare('SELECT session_id FROM night_queue_items WHERE id = ?').get(id) as
      | { session_id: string }
      | undefined;
    const changed = db
      .prepare(
        `UPDATE night_queue_items SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('pending', 'failed')`,
      )
      .run(id).changes;
    return changed > 0 && row ? row.session_id : null;
  },

  /**
   * After a restart nothing is really running, so items left as `running` were cut off. They go back
   * to waiting, unless they have already been cut off `maxAttempts` times.
   */
  recoverInterrupted(maxAttempts: number): { requeued: number; failed: number } {
    const db = getConnection();
    return db.transaction(() => {
      const failed = db
        .prepare(
          `UPDATE night_queue_items
           SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
           WHERE status = 'running' AND attempts >= ?`,
        )
        .run(`連續 ${maxAttempts} 次執行到一半被中斷（DHC CLI 重啟），已停止重試。`, maxAttempts).changes;
      const requeued = db
        .prepare(
          `UPDATE night_queue_items SET status = 'pending', updated_at = CURRENT_TIMESTAMP
           WHERE status = 'running'`,
        )
        .run().changes;
      return { requeued, failed };
    })();
  },
};
