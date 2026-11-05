import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * DHC CLI 10/24 長對話交接: a conversation past ~200K tokens re-reads everything on every message. Two pieces:
 * 1) `judgeHandoffMoment` asks a Haiku judge (an external judge.cjs, task handoff-moment) whether the last reply is a
 *    natural stopping point; off unless the switch file exists, and any error answers 'now'.
 * 2) `handoffSession` has the OLD session write a handoff note (one turn, no work), saves it to a file, then opens a
 *    NEW session in the same project whose first turn reads the note. The old session is never deleted or archived.
 */
export type HandoffMoment = { choice: 'now' | 'later'; off?: true };
export type HandoffResult = { newSessionId: string; handoffPath: string };
export type HandoffRunOptions = { permissionMode?: string; toolsSettings?: unknown; skipPermissions?: boolean };

type Judge = (task: string, input: unknown, opts: unknown) => Promise<{ choice: string }>;

const judgePath = () => path.resolve(process.env.HANDOFF_JUDGE || path.join(os.homedir(), '.dhc', 'judge.cjs'));
const switchPath = () => process.env.HANDOFF_SWITCH || 'C:\\Users\\demo\\.cloudcli\\handoff-on';
const handoffDir = () => process.env.HANDOFF_DIR || 'C:\\Users\\demo\\.cloudcli\\handoffs';
const TIMEOUT_MS = 6000;
const MAX_USER = 600;
const MAX_ASSISTANT = 1500;

export const HANDOFF_WRITE_PROMPT = '（自動交接）這段對話快滿了，要換新對話接手。只寫交接內容，不要動任何檔案或執行工作。格式：目標／已完成（附檔案路徑）／進行中／下一步／等使用者決定的事／注意事項，800 字內。';

export const buildTakeoverPrompt = (oldId: string, handoffPath: string, text: string): string =>
  `接手前一段對話（舊對話 ${oldId}，交接檔 ${handoffPath}）。交接如下：\n\n${text}\n\n請用三行以內說明目前狀態和下一步，然後等使用者下一句，先不要動手。`;

export async function judgeHandoffMoment(body: unknown): Promise<HandoffMoment> {
  if (!existsSync(switchPath()) || !existsSync(judgePath())) return { choice: 'later', off: true };

  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const lastUser = typeof input.lastUser === 'string' ? input.lastUser.slice(0, MAX_USER) : '';
  const lastAssistant = typeof input.lastAssistant === 'string' ? input.lastAssistant.slice(-MAX_ASSISTANT) : '';
  if (!lastAssistant.trim()) return { choice: 'now' };

  let timer: NodeJS.Timeout | undefined;
  try {
    const { judge } = createRequire(import.meta.url)(judgePath()) as { judge: Judge };
    const verdict = await Promise.race([
      judge('handoff-moment', { lastUser, lastAssistant }, { timeoutMs: TIMEOUT_MS }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS); }),
    ]);
    return { choice: verdict.choice === 'later' ? 'later' : 'now' };
  } catch (error) {
    console.error('[handoff-moment] judge failed:', (error as Error)?.message);
    return { choice: 'now' };
  } finally {
    clearTimeout(timer);
  }
}

type HistoryMessage = { kind?: string; role?: string; content?: unknown };

/** Everything the handoff touches outside this file, so a test can swap in fakes. */
export type HandoffDeps = {
  getSession(sessionId: string): { provider: string; projectPath: string; title: string } | null;
  isRunning(sessionId: string): boolean;
  resolveModel(sessionId: string): Promise<{ model: string | null; effort: string | null }>;
  history(sessionId: string, limit: number): Promise<{ total: number; messages: HistoryMessage[] }>;
  runTurn(sessionId: string, content: string, options: Record<string, unknown>, userId: string | number | null): Promise<{ started: boolean; error: string | null }>;
  createSession(projectPath: string, prompt: string): string;
  rename(sessionId: string, name: string): void;
  broadcast(sessionId: string): Promise<void>;
};

/** Imported lazily (relative paths: the staged transpile only rewrites static `@/` imports) so the websocket barrel does not load in a cycle. */
const defaultDeps: HandoffDeps = {
  getSession(sessionId) {
    const row = sessionsDb.getSessionById(sessionId);
    return row ? { provider: row.provider, projectPath: row.project_path ?? '', title: row.custom_name?.trim() ?? '' } : null;
  },
  isRunning(sessionId) {
    return sessionsService.listRunningSessions().some((run) => run.sessionId === sessionId);
  },
  async resolveModel(sessionId) {
    const resolved = await providerModelsService.resolveSessionModel('claude', { sessionId });
    return { model: resolved.model ?? null, effort: resolved.effort ?? null };
  },
  async history(sessionId, limit) {
    const page = await sessionsService.fetchHistory(sessionId, { limit, offset: 0 });
    return { total: page.total, messages: page.messages as HistoryMessage[] };
  },
  async runTurn(sessionId, content, options, userId) {
    const { providerRuntimeService } = await import('./provider-runtime.service.js');
    const { runDetachedChatTurn } = await import('../../websocket/index.js');
    return runDetachedChatTurn({ sessionId, userId, content, options }, { runtime: providerRuntimeService });
  },
  createSession: (projectPath, prompt) => sessionsService.createAppSession('claude', projectPath, prompt).sessionId,
  rename: (sessionId, name) => { sessionsService.renameSessionById(sessionId, name); },
  async broadcast(sessionId) {
    const { broadcastSessionUpserted } = await import('../../websocket/index.js');
    await broadcastSessionUpserted(sessionId);
  },
};

const fail = (message: string, statusCode = 400): never => {
  throw new AppError(message, { code: 'SESSION_HANDOFF_FAILED', statusCode });
};

const textOf = (content: unknown): string => (typeof content === 'string' ? content.trim() : '');

/** The newest assistant text block, or '' when the tail holds none. */
const lastAssistantText = (messages: HistoryMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.kind === 'text' && m.role === 'assistant' && textOf(m.content)) return textOf(m.content);
  }
  return '';
};

const stamp = (date: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}`;
};

/**
 * The turns run with the old session's recorded model and effort. The permission mode is a browser-side setting the
 * server does not keep, so the page sends its current one with the request; without it the CLI default
 * (bypassPermissions) applies, as for the assistant's own sessions.
 */
const runOptions = async (deps: HandoffDeps, sessionId: string, given: HandoffRunOptions): Promise<Record<string, unknown>> => {
  const { model, effort } = await deps.resolveModel(sessionId);
  const toolsSettings = given.toolsSettings && typeof given.toolsSettings === 'object'
    ? given.toolsSettings
    : { allowedTools: [], disallowedTools: [], skipPermissions: false };
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    permissionMode: typeof given.permissionMode === 'string' && given.permissionMode ? given.permissionMode : 'bypassPermissions',
    toolsSettings,
    skipPermissions: given.skipPermissions === true,
    attachments: [],
  };
};

export async function handoffSession(
  sessionId: string,
  given: HandoffRunOptions = {},
  userId: string | number | null = null,
  deps: HandoffDeps = defaultDeps,
  now: Date = new Date(),
): Promise<HandoffResult> {
  const session = deps.getSession(sessionId);
  if (!session) return fail('找不到這個對話。', 404);
  if (session.provider !== 'claude') return fail('只有 Claude 對話可以交接。');
  if (!session.projectPath.trim()) return fail('這個對話沒有所屬專案，無法開新對話。');
  if (deps.isRunning(sessionId)) return fail('對話還在執行中，等它停下來再交接。', 409);

  try {
    const options = await runOptions(deps, sessionId, given);
    const before = (await deps.history(sessionId, 1)).total;

    const ran = await deps.runTurn(sessionId, HANDOFF_WRITE_PROMPT, options, userId);
    if (!ran.started || ran.error) return fail(`舊對話寫交接失敗：${ran.error ?? '沒有啟動'}`, 502);

    const tail = await deps.history(sessionId, 40);
    const text = tail.total > before ? lastAssistantText(tail.messages) : '';
    if (!text) return fail('舊對話沒有寫出交接內容，沒有開新對話。', 502);

    const handoffPath = path.join(handoffDir(), `${sessionId}-${stamp(now)}.md`);
    await mkdir(path.dirname(handoffPath), { recursive: true });
    await writeFile(handoffPath, `${text}\n`, 'utf8');

    const prompt = buildTakeoverPrompt(sessionId, handoffPath, text);
    const newSessionId = deps.createSession(session.projectPath, prompt);
    if (session.title) {
      try { deps.rename(newSessionId, `${session.title}（接手）`); } catch { /* the name is cosmetic */ }
    }
    // Not awaited: the new session's first turn runs for as long as it needs, the page only needs its id.
    void deps.runTurn(newSessionId, prompt, options, userId).then((result) => {
      if (!result.started || result.error) console.error('[handoff] new session did not start:', result.error);
    }).catch((error) => console.error('[handoff] new session failed:', (error as Error)?.message));
    void deps.broadcast(newSessionId).catch(() => undefined);

    return { newSessionId, handoffPath };
  } catch (error) {
    if (error instanceof AppError) throw error;
    return fail(`交接失敗：${(error as Error)?.message ?? '未知錯誤'}`, 500);
  }
}
