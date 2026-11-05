import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgyTranscriptEntry } from '@/modules/providers/list/agy/agy-events.js';

/**
 * agy keeps conversations as protobuf blobs in per-conversation sqlite files,
 * which are not a stable format to read. The web app therefore keeps its own
 * JSONL transcript (user prompts + the raw stream-json events) per agy
 * conversation id, and rebuilds history from that.
 */
export const AGY_TRANSCRIPT_ROOT =
  process.env.AGY_TRANSCRIPT_ROOT || path.join(os.homedir(), '.cloudcli', 'agy-sessions');

const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/;

/** Returns the transcript path for a conversation id, or null when the id is not a plain id. */
export function agyTranscriptPath(conversationId: string, root: string = AGY_TRANSCRIPT_ROOT): string | null {
  return SAFE_ID.test(conversationId) ? path.join(root, `${conversationId}.jsonl`) : null;
}

/** First line of a transcript file; lets the synchronizer recover the project path and model. */
export type AgyTranscriptMeta = { t: 'meta'; ts: string; conversationId: string; cwd: string; model?: string };

export async function appendAgyTranscript(
  conversationId: string,
  entry: AgyTranscriptEntry | AgyTranscriptMeta,
  root: string = AGY_TRANSCRIPT_ROOT,
): Promise<void> {
  const file = agyTranscriptPath(conversationId, root);
  if (!file) {
    return;
  }
  await mkdir(root, { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readAgyTranscript(file: string): Promise<{
  meta: AgyTranscriptMeta | null;
  entries: AgyTranscriptEntry[];
}> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return { meta: null, entries: [] };
  }

  let meta: AgyTranscriptMeta | null = null;
  const entries: AgyTranscriptEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { t?: string };
      if (parsed.t === 'meta' && !meta) {
        meta = parsed as AgyTranscriptMeta;
      } else if (parsed.t === 'user' || parsed.t === 'event') {
        entries.push(parsed as AgyTranscriptEntry);
      }
    } catch {
      // A torn last line from a run that was killed mid-write is skipped.
    }
  }
  return { meta, entries };
}
