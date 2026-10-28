import { execFile } from 'node:child_process';

import { toTraditional } from '@/modules/providers/list/claude/auto-session-title.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { AppError } from '@/shared/utils.js';

/**
 * DHC CLI 10/13 規劃白板: the small chat beside the canvas. Claude reads the board (boxes with positions, arrows) and
 * the person's request, answers briefly and, when the request is to draw or change something, sends back the whole
 * new board. Runs through the same Claude Code the app uses, sandboxed like 快速取名: no tools, no MCP servers,
 * no settings or CLAUDE.md files, nothing saved as a session. The page decides whether to apply the board.
 */

const TIMEOUT_MS = 180_000;
const MAX_NODES = 200;
const MAX_TEXT = 4000;
const MAX_HISTORY = 12;

const SYSTEM_PROMPT = [
  '你是「規劃白板」裡的助手，幫使用者把系統、流程或決策畫成方框與箭頭的圖，一律用繁體中文。',
  '你會收到目前白板的 JSON（nodes：id、text、x、y、w、h；edges：from、to、text，方向是 from 指向 to）、先前的對話，以及使用者這次的要求。',
  '',
  '只輸出一個 JSON 物件，不要任何其他文字或程式碼框：',
  '{"reply": "給使用者的簡短回覆（1–4 句）", "board": null 或 {"nodes": [...], "edges": [...]}}',
  '',
  '規則：',
  '- 使用者要你畫、加、刪、改、重排時，board 給「完整的新白板」（不是只給差異）；只是問問題或討論時 board 給 null。',
  '- 保留沒有要改的方框的 id、text、x、y、w、h；新方框用新的短 id（例如 n12）。',
  '- 方框預設 w 200、h 80；方框文字簡短（一行標題，必要時第二行補充）。',
  '- 版面：主流程由左到右，欄距 280、列距 140，座標用整數，方框不要重疊；分支往下排。',
  '- 箭頭 text 可以留空，需要時寫條件或資料內容（例如「是」「否」「每日 CSV」）。',
  '- 一張圖最多 40 個方框；要求太大時先畫骨架並在 reply 說明。',
  '- 不知道細節時照常理先畫一版，在 reply 列出你做的假設或建議使用者決定的地方。',
].join('\n');

type BoardInput = {
  nodes: Array<{ id: string; text: string; x: number; y: number; w: number; h: number }>;
  edges: Array<{ from: string; to: string; text: string }>;
};
type ChatInput = Array<{ role: 'user' | 'assistant'; text: string }>;

const str = (value: unknown, max = MAX_TEXT) => (typeof value === 'string' ? value.slice(0, max) : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0);

function parseBoardInput(value: unknown): BoardInput {
  const raw = (value && typeof value === 'object' ? value : {}) as { nodes?: unknown; edges?: unknown };
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, MAX_NODES).map((item) => {
    const node = (item ?? {}) as Record<string, unknown>;
    return { id: str(node.id, 64), text: str(node.text, 500), x: num(node.x), y: num(node.y), w: num(node.w), h: num(node.h) };
  }).filter((node) => node.id);
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).slice(0, MAX_NODES * 3).map((item) => {
    const edge = (item ?? {}) as Record<string, unknown>;
    return { from: str(edge.from, 64), to: str(edge.to, 64), text: str(edge.text, 200) };
  }).filter((edge) => edge.from && edge.to);
  return { nodes, edges };
}

function parseChatInput(value: unknown): ChatInput {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
    .slice(-MAX_HISTORY)
    .map((item) => ({ role: item.role as 'user' | 'assistant', text: str(item.text, 1500) }));
}

/** The first {...} in the answer, tolerating a code fence or a stray sentence around it. */
export function extractAnswerJson(answer: string): { reply: string; board: unknown } {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return { reply: answer.trim(), board: null };
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1)) as { reply?: unknown; board?: unknown };
    return { reply: typeof parsed.reply === 'string' ? parsed.reply : '', board: parsed.board ?? null };
  } catch {
    return { reply: answer.trim(), board: null };
  }
}

const runClaude = (prompt: string): Promise<string> => new Promise((resolve, reject) => {
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
      '--system-prompt', SYSTEM_PROMPT,
      '--output-format', 'json',
    ],
    {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
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
  // The board can be long, so the prompt goes in on stdin instead of the command line.
  child.stdin?.end(prompt);
});

export const planBoardAssistService = {
  async assist(body: unknown): Promise<{ reply: string; board: unknown }> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const message = str(input.message).trim();
    if (!message) throw new AppError('Say what to draw or ask.', { statusCode: 400, code: 'NO_MESSAGE' });
    const board = parseBoardInput(input.board);
    const chat = parseChatInput(input.chat);
    const prompt = [
      '目前白板：',
      JSON.stringify(board),
      '',
      chat.length > 0 ? `先前的對話：\n${chat.map((m) => `${m.role === 'user' ? '使用者' : '助手'}：${m.text}`).join('\n')}\n` : '',
      `使用者這次說：${message}`,
    ].join('\n');
    let answer: string;
    try {
      answer = await runClaude(prompt);
    } catch (error) {
      throw new AppError(`The board assistant did not answer: ${(error as Error).message}`, { statusCode: 502, code: 'ASSIST_FAILED' });
    }
    const { reply, board: next } = extractAnswerJson(answer);
    return { reply: toTraditional(reply) || '（沒有回覆文字）', board: next };
  },
};
