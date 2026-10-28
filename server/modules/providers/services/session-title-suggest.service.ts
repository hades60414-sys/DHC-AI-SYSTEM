import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { tidyTitle, toTraditional } from '@/modules/providers/list/claude/auto-session-title.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { AppError } from '@/shared/utils.js';

/**
 * DHC CLI 10/13 「快速取名」: a short name for what a session is working on *now*, from its latest user messages.
 * Haiku answers through the same Claude Code the app runs on, sandboxed the way the morning check is: no tools, no
 * MCP servers, no settings or CLAUDE.md files, nothing saved as a session. The suggestion only fills the rename
 * box; the user still saves it.
 */

const RECENT_MESSAGES = 6;
const CHARS_PER_MESSAGE = 300;
const TIMEOUT_MS = 45_000;
const inFlight = new Set<string>();

const SYSTEM_PROMPT = [
  '你替一段工作對話取標題。',
  '根據使用者最近說的話（由舊到新，最後幾句最重要），用繁體中文寫一個 6 到 16 字的標題，概括「現在正在做的任務」。',
  '保留專有名詞、主機代號、檔名、系統名。',
  '只輸出標題本身：不要引號、句號、編號或任何解釋。',
].join('\n');

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : ''))
    .join(' ');
};

/** The user's own words in a transcript, oldest first — no tool results, commands, notifications or attachments. */
export function recentUserMessages(transcript: string, limit = RECENT_MESSAGES): string[] {
  const messages: string[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.includes('"type":"user"')) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (data.type !== 'user' || data.isMeta || data.isCompactSummary || data.toolUseResult !== undefined) continue;
    const text = textOf((data.message as { content?: unknown } | undefined)?.content)
      .replace(/<files_input>[\s\S]*?(?:<\/files_input>|$)/g, ' ')
      .replace(/^【[^】\n]{1,30}】\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text.startsWith('<')) continue;
    messages.push(text.slice(0, CHARS_PER_MESSAGE));
  }
  return messages.slice(-limit);
}

const runHaiku = (prompt: string): Promise<string> => new Promise((resolve, reject) => {
  const cli = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
  execFile(
    cli,
    [
      '-p', prompt,
      '--model', 'haiku',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--system-prompt', SYSTEM_PROMPT,
      '--output-format', 'json',
    ],
    {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1' },
    },
    (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const result = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
        if (result.is_error || typeof result.result !== 'string') throw new Error('no title in the answer');
        resolve(result.result);
      } catch (parseError) {
        reject(parseError);
      }
    },
  );
});

export const sessionTitleSuggestService = {
  async suggest(sessionId: string): Promise<{ title: string }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) throw new AppError('Session not found.', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
    if (!session.jsonl_path) {
      throw new AppError('This session has no transcript yet.', { statusCode: 409, code: 'NO_TRANSCRIPT' });
    }
    if (inFlight.has(sessionId)) {
      throw new AppError('A title is already being suggested for this session.', { statusCode: 409, code: 'BUSY' });
    }
    inFlight.add(sessionId);
    try {
      const messages = recentUserMessages(await readFile(session.jsonl_path, 'utf8'));
      if (messages.length === 0) {
        throw new AppError('Nothing to name yet.', { statusCode: 409, code: 'NO_MESSAGES' });
      }
      const prompt = messages.map((message, index) => `${index + 1}. ${message}`).join('\n');
      let answer: string;
      try {
        answer = await runHaiku(prompt);
      } catch (error) {
        throw new AppError(`The quick name did not come back: ${(error as Error).message}`, { statusCode: 502, code: 'SUGGEST_FAILED' });
      }
      const title = tidyTitle(toTraditional(answer.split('\n')[0] ?? ''));
      if (!title) throw new AppError('The quick name came back empty.', { statusCode: 502, code: 'SUGGEST_EMPTY' });
      return { title };
    } finally {
      inFlight.delete(sessionId);
    }
  },
};
