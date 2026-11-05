import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { toTraditional } from '@/modules/providers/list/claude/auto-session-title.js';
import { projectPathFor } from '@/modules/providers/services/plan-board-assist.service.js';
import { TOOL_PROMPTS } from '@/modules/providers/services/tool-assist/prompts/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { AppError } from '@/shared/utils.js';

/**
 * DHC CLI 10/14 工具庫: the AI chat beside each tool (專案板、試算工作台…). The page sends its tool id, what the
 * tool shows right now (context), the chat so far and the request; Claude answers with a short reply and, when the
 * request is to change something, a tool-specific result the page applies. Sandboxed like 規劃白板: no tools,
 * no MCP servers, no settings or CLAUDE.md files, nothing saved as a session. 小工具工坊 runs in the person's
 * project folder reading files only (Read, Glob, Grep); 10/24 it no longer loads their settings, hooks and
 * CLAUDE.md files, the prompt names their project CLAUDE.md and memory files instead, so it reads only what it needs.
 */

const TIMEOUT_MS = 300_000;
const MAX_MESSAGE = 4000;
const MAX_CONTEXT = 120_000;
const MAX_HISTORY = 12;
const FULL_TOOLS = new Set(['tool-workshop']);
const READ_TOOLS = 'Read,Glob,Grep';
const EFFORT = 'medium';
// 10/24: Sonnet was not faster on short answers and got line numbers and month-end timing wrong on the long ones
// (an internal design note), so every tool stays on Opus.
const MODEL = 'opus';

const COMMON_RULES = [
  '',
  '一律用繁體中文。只輸出一個 JSON 物件，不要任何其他文字或程式碼框：',
  '{"reply": "給使用者的簡短回覆（1–4 句）", "result": null 或 這個工具規定的內容}（工具另有規定時，可以在 JSON 後面附一個程式碼區塊）',
  '只是問問題或討論時 result 給 null；要改東西時 result 依上面這個工具的格式給。',
  '不知道細節時照常理先做一版，在 reply 說明你的假設。',
].join('\n');

/** The project's CLAUDE.md files, 專案記憶 index and Claude memory index, nearest folder first; only those that exist. */
export function memoryFiles(projectPath: string): string[] {
  const files: string[] = [];
  for (let dir = path.resolve(projectPath); ; dir = path.dirname(dir)) {
    for (const name of ['CLAUDE.md', path.join('專案記憶', 'INDEX.md')]) {
      const file = path.join(dir, name);
      if (existsSync(file)) files.push(file);
    }
    if (path.dirname(dir) === dir) break;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const memory = path.join(configDir, 'projects', path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
  if (existsSync(memory)) files.push(memory);
  return files;
}

const memoryRules = (files: string[]) => [
  '',
  files.length > 0
    ? `使用者的專案說明和記憶在這些檔案（沒有自動載入，需要時自己讀）：\n${files.map((file) => `- ${file}`).join('\n')}`
    : '這個專案沒有 CLAUDE.md 或記憶檔。',
  '要求裡有公司的費率、規則、報表格式、系統或專有名詞時，先用 Read／Glob／Grep 查上面的檔案和它們指到的卡片再做，不要只照字面猜；查不到才在 reply 說明你的假設。',
  '只能讀檔，不能改檔案或執行指令；查詢最多 10 次讀取，最後仍只輸出上面規定的格式。',
].join('\n');

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

type ChatInput = Array<{ role: 'user' | 'assistant'; text: string }>;
function parseChat(value: unknown): ChatInput {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
    .slice(-MAX_HISTORY)
    .map((item) => ({ role: item.role as 'user' | 'assistant', text: str(item.text, 1500) }));
}

/** Long code (a whole web page) is easier for the model to write outside the JSON: a string "@@BLOCK@@" in the JSON
 * stands for the ```block``` written after it. */
const BLOCK_MARK = '@@BLOCK@@';
const hasMark = (value: unknown): boolean =>
  value === BLOCK_MARK || (value !== null && typeof value === 'object' && Object.values(value).some(hasMark));
const fillBlock = (value: unknown, block: string): unknown => {
  if (value === BLOCK_MARK) return block;
  if (Array.isArray(value)) return value.map((item) => fillBlock(item, block));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillBlock(item, block)]));
  return value;
};

/** Index of the "}" closing the object that opens at `start`, skipping braces inside strings; -1 when unclosed. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The code after the JSON: the first fenced block (its closing fence may be missing), or bare HTML with no fence. */
function blockAfter(rest: string, jsonWasFenced: boolean): string | null {
  const text = jsonWasFenced ? rest.replace(/^\s*```[ \t]*(?=\n|$)/, '') : rest;
  const open = /```[^\n]*\n/.exec(text);
  if (!open) {
    const bare = text.trim();
    return bare.startsWith('<') ? bare : null;
  }
  const bodyStart = open.index + open[0].length;
  const close = text.lastIndexOf('```');
  const body = close >= bodyStart ? text.slice(bodyStart, close) : text.slice(bodyStart);
  return body.replace(/\s+$/, '') || null;
}

export type ToolAnswer = {
  reply: string;
  result: unknown;
  /** The model sent a result that could not be read (broken JSON, or "@@BLOCK@@" with no code after it). */
  lostResult: boolean;
};

/** The first {...} in the answer, tolerating a code fence or a stray sentence around it and CRLF line ends. */
export function extractToolAnswer(raw: string): ToolAnswer {
  const answer = raw.replace(/\r\n?/g, '\n');
  const start = answer.indexOf('{');
  const end = start < 0 ? -1 : objectEnd(answer, start);
  let parsed: { reply?: unknown; result?: unknown } | null = null;
  try {
    if (end > start) parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    const quoted = /"reply"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(answer)?.[1];
    let reply = answer.trim();
    try {
      if (quoted) reply = JSON.parse(quoted) as string;
    } catch { /* keep the raw text */ }
    return { reply, result: null, lostResult: /"result"\s*:\s*[{[]/.test(answer) };
  }
  const reply = typeof parsed.reply === 'string' ? parsed.reply : '';
  const result = parsed.result ?? null;
  if (!hasMark(result)) return { reply, result, lostResult: false };
  const block = blockAfter(answer.slice(end + 1), answer.slice(0, start).includes('```'));
  return block === null ? { reply, result: null, lostResult: true } : { reply, result: fillBlock(result, block), lostResult: false };
}

export type AssistFailure = 'timeout' | 'quota' | 'auth' | 'format' | 'aborted' | 'other';
const FAILURE_CODES: Record<AssistFailure, string> = {
  timeout: 'ASSIST_TIMEOUT',
  quota: 'ASSIST_QUOTA',
  auth: 'ASSIST_AUTH',
  format: 'ASSIST_FORMAT',
  aborted: 'ASSIST_ABORTED',
  other: 'ASSIST_FAILED',
};

export class AssistRunError extends Error {
  constructor(readonly kind: AssistFailure, detail: string) {
    super(detail.trim().slice(0, 300) || kind);
  }
}

/** Claude CLI's own words for a spent quota or a dead login (strings found in claude.exe 2.1.293). */
export function failureKind(text: string): AssistFailure {
  if (/hit your .{0,20}limit|usage limit|spend limit|limit reached|rate.?limit/i.test(text)) return 'quota';
  if (/\/login|not logged in|oauth|invalid api key|authenticat|token.{0,20}expired|\b401\b/i.test(text)) return 'auth';
  return 'other';
}

type RunOptions = { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number };

/** Runs a `claude -p --output-format json` style CLI; rejects with an AssistRunError saying why it gave no answer. */
export const runCli = (cli: string, args: string[], input: string, options: RunOptions): Promise<string> => new Promise((resolve, reject) => {
  const child = execFile(
    cli,
    args,
    {
      timeout: options.timeoutMs ?? TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    (error, stdout, stderr) => {
      if (options.signal?.aborted) {
        reject(new AssistRunError('aborted', 'stopped by the person'));
        return;
      }
      if (error && (error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT')) {
        reject(new AssistRunError('timeout', `no answer within ${Math.round((options.timeoutMs ?? TIMEOUT_MS) / 1000)} s`));
        return;
      }
      let parsed: { result?: unknown; is_error?: unknown } | null = null;
      try {
        parsed = JSON.parse(String(stdout)) as { result?: unknown; is_error?: unknown };
      } catch {
        parsed = null;
      }
      if (parsed && !parsed.is_error && typeof parsed.result === 'string' && !error) {
        resolve(parsed.result);
        return;
      }
      // execFile's own message starts with the whole command line (the system prompt), so it is never shown.
      const detail = parsed
        ? String(parsed.result ?? '')
        : String(stderr || stdout || '').trim() || (error ? `exit code ${String((error as NodeJS.ErrnoException).code ?? '?')}` : '');
      const kind = failureKind(`${detail}\n${String(stderr)}`);
      reject(new AssistRunError(!error && !parsed && kind === 'other' ? 'format' : kind, detail || 'empty answer'));
    },
  );
  // The context can be long, so the prompt goes in on stdin instead of the command line.
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
});

export function claudeArgs(systemPrompt: string, readsFiles: boolean): string[] {
  return [
    '-p',
    '--model', MODEL,
    ...(readsFiles ? ['--tools', READ_TOOLS, '--allowedTools', READ_TOOLS, '--effort', EFFORT] : ['--tools', '']),
    '--setting-sources', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt', systemPrompt,
    '--output-format', 'json',
  ];
}

export const toolAssistService = {
  async assist(body: unknown, signal?: AbortSignal): Promise<{ reply: string; result: unknown; lostResult: boolean }> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const tool = str(input.tool, 64);
    const toolPrompt = Object.prototype.hasOwnProperty.call(TOOL_PROMPTS, tool) ? TOOL_PROMPTS[tool] : null;
    if (!toolPrompt) throw new AppError('Unknown tool.', { statusCode: 400, code: 'UNKNOWN_TOOL' });
    const message = str(input.message, MAX_MESSAGE).trim();
    if (!message) throw new AppError('Say what to do or ask.', { statusCode: 400, code: 'NO_MESSAGE' });
    const context = JSON.stringify(input.context ?? null).slice(0, MAX_CONTEXT);
    const chat = parseChat(input.chat);
    const projectPath = FULL_TOOLS.has(tool) ? projectPathFor(str(input.projectId, 128), null) : null;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const prompt = [
      `今天是 ${today}（台灣時間）。`,
      '工具目前的內容：',
      context,
      '',
      chat.length > 0 ? `先前的對話：\n${chat.map((m) => `${m.role === 'user' ? '使用者' : '助手'}：${m.text}`).join('\n')}\n` : '',
      `使用者這次說：${message}`,
    ].join('\n');
    const systemPrompt = `${toolPrompt}\n${COMMON_RULES}${projectPath ? memoryRules(memoryFiles(projectPath)) : ''}`;
    const cli = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
    const started = Date.now();
    const log = (outcome: string) => console.log(`[tool-assist] tool=${tool} model=${MODEL} ms=${Date.now() - started} ${outcome}`);
    let answer: string;
    try {
      answer = await runCli(cli, claudeArgs(systemPrompt, projectPath !== null), prompt, {
        cwd: projectPath ?? undefined,
        env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1' },
        signal,
      });
    } catch (error) {
      const kind = error instanceof AssistRunError ? error.kind : 'other';
      log(`err=${kind}`);
      throw new AppError((error as Error).message, { statusCode: 502, code: FAILURE_CODES[kind] });
    }
    const { reply, result, lostResult } = extractToolAnswer(answer);
    log(result !== null ? 'ok' : lostResult ? 'ok-lost-result' : 'ok-no-result');
    return { reply: toTraditional(reply) || '（沒有回覆文字）', result, lostResult };
  },
};
