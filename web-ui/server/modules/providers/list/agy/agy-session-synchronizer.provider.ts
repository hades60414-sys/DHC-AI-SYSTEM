import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { AGY_TRANSCRIPT_ROOT, readAgyTranscript } from '@/modules/providers/list/agy/agy-transcript.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { normalizeSessionName } from '@/shared/utils.js';

/** Indexes the transcripts the Google agy runtime wrote under `~/.cloudcli/agy-sessions`. */
export class AgySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'agy' as const;

  async synchronize(since?: Date): Promise<number> {
    let names: string[];
    try {
      names = await readdir(AGY_TRANSCRIPT_ROOT);
    } catch {
      return 0;
    }

    let processed = 0;
    for (const name of names.filter((entry) => entry.endsWith('.jsonl'))) {
      const file = path.join(AGY_TRANSCRIPT_ROOT, name);
      try {
        if (since && (await stat(file)).mtime < since) {
          continue;
        }
        if (await this.upsertFile(file)) {
          processed += 1;
        }
      } catch (error) {
        console.warn('[AgyProvider] Failed to index transcript:', name, error instanceof Error ? error.message : error);
      }
    }
    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    return this.upsertFile(filePath);
  }

  private async upsertFile(file: string): Promise<string | null> {
    const { meta, entries } = await readAgyTranscript(file);
    const conversationId = meta?.conversationId;
    if (!meta || !conversationId || !meta.cwd) {
      return null;
    }

    // The runtime may announce the conversation before this scan runs; bind the id
    // to the fresh app row so the sidebar does not show a second entry.
    const pending = sessionsDb.getSessionByProviderSessionId(conversationId)
      ?? sessionsDb.getSessionById(conversationId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, meta.cwd);
    if (pending && !pending.provider_session_id) {
      sessionsDb.assignProviderSessionId(pending.session_id, conversationId);
    }

    const existing = sessionsDb.getSessionByProviderSessionId(conversationId)
      ?? sessionsDb.getSessionById(conversationId);
    const firstUser = entries.find((entry) => entry.t === 'user');
    const fallbackTitle = 'Google agy 對話';
    const title = existing?.custom_name && existing.custom_name !== fallbackTitle
      ? existing.custom_name
      : normalizeSessionName(firstUser?.t === 'user' ? firstUser.text : undefined, fallbackTitle);
    const updatedAt = (await stat(file)).mtime.toISOString();

    return sessionsDb.createSession(conversationId, this.provider, meta.cwd, title, meta.ts, updatedAt, file);
  }
}
