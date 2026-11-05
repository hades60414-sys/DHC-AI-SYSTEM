import {
  foldAgyHistory,
  normalizeAgyEvent,
} from '@/modules/providers/list/agy/agy-events.js';
import { agyTranscriptPath, readAgyTranscript } from '@/modules/providers/list/agy/agy-transcript.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { sliceTailPage } from '@/shared/utils.js';

export class AgySessionsProvider implements IProviderSessions {
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    return normalizeAgyEvent(rawMessage, sessionId);
  }

  /**
   * History comes from the transcript the runtime wrote, keyed by agy's
   * conversation id (the provider-native id, never the app session id).
   */
  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const conversationId = options.providerSessionId ?? sessionId;
    const file = agyTranscriptPath(conversationId);
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    if (!file) {
      return { messages: [], total: 0, hasMore: false, offset: normalizedOffset, limit: normalizedLimit };
    }

    const { entries } = await readAgyTranscript(file);
    const all = foldAgyHistory(entries, sessionId);
    const { page, hasMore } = sliceTailPage(all, normalizedLimit, normalizedOffset);
    return { messages: page, total: all.length, hasMore, offset: normalizedOffset, limit: normalizedLimit };
  }
}
