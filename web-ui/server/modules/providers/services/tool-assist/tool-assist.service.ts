import { execFile } from 'node:child_process';

import { toTraditional } from '@/modules/providers/list/claude/auto-session-title.js';
import { TOOL_PROMPTS } from '@/modules/providers/services/tool-assist/prompts/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { AppError } from '@/shared/utils.js';

/**
 * DHC CLI 10/14 工具庫: the AI chat beside each tool (專案板、試算工作台…). The page sends its tool id, what the
 * tool shows right now (context), the chat so far and the request; Claude answers with a short reply and, when the
 * request is to change something, a tool-specific result the page applies. Sandboxed like 規劃白板: no tools,
 * no MCP servers, no settings or CLAUDE.md files, nothing saved as a session.
 */

const TIMEOUT_MS = 240_000;
const MAX_MESSAGE = 4000;
const MAX_CONTEXT = 120_000;
const MAX_HISTORY = 12;

const COMMON_RULES = [
  '',
  '一律用繁體中文。只輸出一個 JSON 物件，不要任何其他文字或程式碼框：',
  '{"reply": "給使用者的簡短回覆（1–4 句）", "result": null 或 這個工具規定的內容}（工具另有規定時，可以在 JSON 後面附一個程式碼區塊）',
  '只是問問題或討論時 result 給 null；要改東西時 result 依上面這個工具的格式給。',
  '不知道細節時照常理先做一版，在 reply 說明你的假設。',
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
function splitBlock(answer: string): { json: string; block: string | null } {
  const mark = answer.indexOf(BLOCK_MARK);
  if (mark < 0) return { json: answer, block: null };
  const open = answer.indexOf('```', answer.indexOf('}', mark));
  const close = answer.lastIndexOf('```');
  if (open < 0 || close <= open) return { json: answer, block: null };
  const body = answer.slice(answer.indexOf('\n', open) + 1, close);
  return { json: answer.slice(0, open), block: body.replace(/\n$/, '') };
}
const fillBlock = (value: unknown, block: string): unknown => {
  if (value === BLOCK_MARK) return block;
  if (Array.isArray(value)) return value.map((item) => fillBlock(item, block));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillBlock(item, block)]));
  return value;
};

/** The outermost {...} in the answer, tolerating a code fence or a stray sentence around it. */
export function extractToolAnswer(raw: string): { reply: string; result: unknown } {
  const { json: answer, block } = splitBlock(raw);
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return { reply: answer.trim(), result: null };
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1)) as { reply?: unknown; result?: unknown };
    const result = parsed.result ?? null;
    return { reply: typeof parsed.reply === 'string' ? parsed.reply : '', result: block === null ? result : fillBlock(result, block) };
  } catch {
    return { reply: answer.trim(), result: null };
  }
}

const runClaude = (systemPrompt: string, prompt: string): Promise<string> => new Promise((resolve, reject) => {
  const cli = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
  const child = execFile(
    cli,
    [
      '-p',
      '--model', 'opus',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--system-prompt', systemPrompt,
      '--output-format', 'json',
    ],
    {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1' },
    },
    (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const result = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
        if (result.is_error || typeof result.result !== 'string') throw new Error('no answer');
        resolve(result.result);
      } catch (parseError) {
        reject(parseError);
      }
    },
  );
  // The context can be long, so the prompt goes in on stdin instead of the command line.
  child.stdin?.end(prompt);
});

export const toolAssistService = {
  async assist(body: unknown): Promise<{ reply: string; result: unknown }> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const tool = str(input.tool, 64);
    const toolPrompt = Object.prototype.hasOwnProperty.call(TOOL_PROMPTS, tool) ? TOOL_PROMPTS[tool] : null;
    if (!toolPrompt) throw new AppError('Unknown tool.', { statusCode: 400, code: 'UNKNOWN_TOOL' });
    const message = str(input.message, MAX_MESSAGE).trim();
    if (!message) throw new AppError('Say what to do or ask.', { statusCode: 400, code: 'NO_MESSAGE' });
    const context = JSON.stringify(input.context ?? null).slice(0, MAX_CONTEXT);
    const chat = parseChat(input.chat);
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const prompt = [
      `今天是 ${today}（台灣時間）。`,
      '工具目前的內容：',
      context,
      '',
      chat.length > 0 ? `先前的對話：\n${chat.map((m) => `${m.role === 'user' ? '使用者' : '助手'}：${m.text}`).join('\n')}\n` : '',
      `使用者這次說：${message}`,
    ].join('\n');
    let answer: string;
    try {
      answer = await runClaude(`${toolPrompt}\n${COMMON_RULES}`, prompt);
    } catch (error) {
      throw new AppError(`The tool assistant did not answer: ${(error as Error).message}`, { statusCode: 502, code: 'ASSIST_FAILED' });
    }
    const { reply, result } = extractToolAnswer(answer);
    return { reply: toTraditional(reply) || '（沒有回覆文字）', result };
  },
};
