import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { toTraditional } from '@/modules/providers/list/claude/auto-session-title.js';
import { recentUserMessages } from '@/modules/providers/services/session-title-suggest.service.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { AppError } from '@/shared/utils.js';

/**
 * DHC CLI 10/13 規劃白板: the small chat beside the canvas. Claude reads the board (boxes with positions, arrows) and
 * the person's request, answers briefly and, when the request is to draw or change something, sends back the whole
 * new board. Runs through the same Claude Code the app uses, no MCP servers, nothing saved as a session. 10/14: it
 * runs in the person's project folder with their settings, CLAUDE.md and memory and may read files (Read, Glob,
 * Grep only), so it knows the names on the board instead of guessing; when the board was opened from a conversation,
 * that conversation's latest messages come along. The page decides whether to apply the board. 10/19: it also gets
 * the loose things on the canvas (free text, stray lines, freehand) with ids it can move or clear, box shapes and
 * fills, and a screenshot of the board to Read, so it can see overlaps and text that does not fit.
 */

const TIMEOUT_MS = 300_000;
const RECENT_CONVERSATION = 8;
const READ_TOOLS = 'Read,Glob,Grep';
const MAX_NODES = 200;
const MAX_LOOSE = 200;
const MAX_IMAGE_BASE64 = 4 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);
const LOOSE_KINDS = new Set(['text', 'line', 'arrow', 'freedraw']);
const MAX_LINKABLES = 80;
const MAX_TEXT = 4000;
const MAX_HISTORY = 12;

const SYSTEM_PROMPT = [
  '你是「規劃白板」裡的助手，幫使用者把系統、流程或決策畫成方框與箭頭的圖，一律用繁體中文。',
  '你會收到目前白板的 JSON（nodes：id、text、x、y、w、h、shape，有填色時另有 fill；edges：from、to、text，方向是 from 指向 to；loose：白板上不是方框、也不是兩端都接到方框的箭頭的東西，kind 是 text 自由文字、line 線、arrow 沒接好的箭頭、freedraw 手繪，各有 id 和位置）、先前的對話，以及使用者這次的要求。',
  '',
  '只輸出一個 JSON 物件，不要任何其他文字或程式碼框：',
  '{"reply": "給使用者的簡短回覆（1–4 句）", "board": null 或 {"nodes": [...], "edges": [...], "notes": [...], "remove": [...]}}',
  'notes 和 remove 可省略。notes 是 [{"id": 選填, "text", "x", "y"}]，要保留、新增或移動的自由文字，沿用 loose 裡的舊 id 就是移動或改字，不帶 id 就是新增；remove 是要刪掉的 loose 項目 id。',
  '',
  '規則：',
  '- 使用者要你畫、加、刪、改、重排時，board 給「完整的新白板」（不是只給差異）；只是問問題或討論時 board 給 null。',
  '- 保留沒有要改的方框的 id、text、x、y、w、h；新方框用新的短 id（例如 n12）。',
  '- 方框預設 w 200、h 80；方框文字簡短（一行標題，必要時第二行補充）。每行字數 ≤ (w−40)/20，超過就加大 w 或分行；h 依行數估，每行 25px 再加 40。',
  '- 判斷、分支、是否的節點用菱形（shape "diamond"），其他用方框；沒要改的方框保留原本的 shape。',
  '- loose 裡的線和註記不會跟著方框重畫。使用者要整理、重排時，主動用 remove 清掉多餘、過時或指向已刪方框的線和註記，要留的註記用 notes 移到合適的位置。',
  '- 版面：主流程由左到右，欄距 280、列距 140，座標用整數，方框不要重疊；分支往下排。',
  '- 箭頭有文字時，兩個方框之間的空隙至少要「文字字數 × 20 + 60」，文字才不會壓到方框；箭頭文字盡量 2–6 個字。',
  '- 使用者有選取方框時，「這個」「它們」指的是選取的方框，只改它們和相關的箭頭。',
  '- 箭頭 text 可以留空，需要時寫條件或資料內容（例如「是」「否」「每日 CSV」）。',
  '- 一張圖最多 40 個方框；要求太大時先畫骨架並在 reply 說明。',
  '- 不知道細節時照常理先畫一版，在 reply 列出你做的假設或建議使用者決定的地方。',
  '- 方框可以連到使用者的對話或白板：方框帶 "link": {"kind", "id"}，只能從另外給的 linkables 清單挑，不能自己編 id；"link": null 是取消連結，不寫 link 就維持原本的連結（nodes 裡已有的 link 就是目前連著的）。方框內容明顯對應清單裡某個對話或白板（名稱或主題相符）時就連上，並在 reply 說連了哪些；不確定就不連。',
  '',
  '輸出 board 前逐項確認：方框不重疊、間距 ≥ 40；箭頭不穿過第三個方框；每個方框的文字塞得下；沒有留下指向已刪方框的線。',
].join('\n');

// Added when the board runs in the person's project with their memory and read-only tools.
const MEMORY_PROMPT = [
  '',
  '你和使用者在 DHC AI System 其他對話共用同一份記憶：CLAUDE.md、你的記憶檔（MEMORY.md 索引）、專案記憶（C:\\Users\\demo\\DHC Workspace\\專案記憶\\INDEX.md）。',
  '白板或要求裡有不熟的系統、主機、工具名稱時，先用 Read／Glob／Grep 查記憶和專案檔再畫，不要說「我沒有記憶」，也不要只照字面猜；查不到才在 reply 說查不到並問使用者。',
  '只能讀檔，不能改檔案或執行指令；查詢最多 10 次讀取，最後仍只輸出上面規定的 JSON。',
].join('\n');

type Linkable = { kind: 'session' | 'board'; id: string; label: string };
type BoardInput = {
  nodes: Array<{ id: string; text: string; x: number; y: number; w: number; h: number; shape?: string; fill?: string; link?: Linkable }>;
  edges: Array<{ from: string; to: string; text: string }>;
  loose: Array<{ id: string; kind: string; text?: string; x: number; y: number; w: number; h: number }>;
};
type ChatInput = Array<{ role: 'user' | 'assistant'; text: string }>;

const str = (value: unknown, max = MAX_TEXT) => (typeof value === 'string' ? value.slice(0, max) : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0);

/** A conversation or whiteboard @@ can link a box to; anything else is null. */
function parseLinkable(value: unknown): Linkable | null {
  const raw = (value ?? {}) as Record<string, unknown>;
  const id = str(raw.id, 128);
  if ((raw.kind !== 'session' && raw.kind !== 'board') || !id) return null;
  return { kind: raw.kind, id, label: str(raw.label, 80) };
}

export function parseBoardInput(value: unknown): BoardInput {
  const raw = (value && typeof value === 'object' ? value : {}) as { nodes?: unknown; edges?: unknown; loose?: unknown };
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, MAX_NODES).map((item) => {
    const node = (item ?? {}) as Record<string, unknown>;
    const fill = str(node.fill, 10);
    const link = node.link ? parseLinkable(node.link) : null;
    return {
      id: str(node.id, 64), text: str(node.text, 500), x: num(node.x), y: num(node.y), w: num(node.w), h: num(node.h),
      ...(SHAPES.has(str(node.shape, 16)) ? { shape: str(node.shape, 16) } : {}),
      ...(fill.startsWith('#') && fill.length <= 9 ? { fill } : {}),
      ...(link ? { link } : {}),
    };
  }).filter((node) => node.id);
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).slice(0, MAX_NODES * 3).map((item) => {
    const edge = (item ?? {}) as Record<string, unknown>;
    return { from: str(edge.from, 64), to: str(edge.to, 64), text: str(edge.text, 200) };
  }).filter((edge) => edge.from && edge.to);
  const loose = (Array.isArray(raw.loose) ? raw.loose : []).map((item) => {
    const thing = (item ?? {}) as Record<string, unknown>;
    const text = str(thing.text, 300);
    return {
      id: str(thing.id, 64), kind: str(thing.kind, 16), ...(text ? { text } : {}),
      x: num(thing.x), y: num(thing.y), w: num(thing.w), h: num(thing.h),
    };
  }).filter((thing) => thing.id && LOOSE_KINDS.has(thing.kind)).slice(0, MAX_LOOSE);
  return { nodes, edges, loose };
}

export function parseLinkables(value: unknown): Linkable[] {
  return (Array.isArray(value) ? value : []).map(parseLinkable).filter((ref): ref is Linkable => ref !== null).slice(0, MAX_LINKABLES);
}

/** The board's screenshot (base64 PNG from the page) in a temp file for Read; null when absent, too big or not a PNG. */
export async function saveBoardImage(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || value === '' || value.length > MAX_IMAGE_BASE64) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < PNG_MAGIC.length || PNG_MAGIC.some((byte, index) => bytes[index] !== byte)) return null;
  const file = path.join(os.tmpdir(), `dhc-board-${randomBytes(8).toString('hex')}.png`);
  await writeFile(file, bytes);
  return file;
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

/** In a project folder: the person's settings, CLAUDE.md and memory, reading files only. Without one: Read only, for the screenshot. */
const runClaude = (prompt: string, projectPath: string | null): Promise<string> => new Promise((resolve, reject) => {
  const cli = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
  const sandbox = projectPath
    ? ['--tools', READ_TOOLS, '--allowedTools', READ_TOOLS, '--setting-sources', 'user,project']
    : ['--tools', 'Read', '--allowedTools', 'Read', '--setting-sources', ''];
  const { CLAUDE_CODE_DISABLE_CLAUDE_MDS: _unused, ...env } = process.env;
  const child = execFile(
    cli,
    [
      '-p',
      '--model', 'opus',
      ...sandbox,
      '--strict-mcp-config',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--system-prompt', projectPath ? SYSTEM_PROMPT + MEMORY_PROMPT : SYSTEM_PROMPT,
      '--output-format', 'json',
    ],
    {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...(projectPath ? { cwd: projectPath } : {}),
      env: projectPath
        ? { ...env, DISABLE_AUTOUPDATER: '1' }
        : { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1' },
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

/** The folder to run in: the person's project, else the open conversation's; null if neither exists on disk. */
export function projectPathFor(projectId: string, session: { project_path: string | null } | null): string | null {
  const candidates = [projectId ? projectsDb.getProjectPathById(projectId) : null, session?.project_path ?? null];
  return candidates.find((path): path is string => typeof path === 'string' && path !== '' && existsSync(path)) ?? null;
}

/** What the person was saying in the conversation the board was opened from, oldest first. */
async function conversationContext(session: { jsonl_path: string | null } | null): Promise<string[]> {
  if (!session?.jsonl_path) return [];
  try {
    return recentUserMessages(await readFile(session.jsonl_path, 'utf8'), RECENT_CONVERSATION);
  } catch {
    return [];
  }
}

export const planBoardAssistService = {
  async assist(body: unknown): Promise<{ reply: string; board: unknown }> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const message = str(input.message).trim();
    if (!message) throw new AppError('Say what to draw or ask.', { statusCode: 400, code: 'NO_MESSAGE' });
    const board = parseBoardInput(input.board);
    const chat = parseChatInput(input.chat);
    const selected = (Array.isArray(input.selected) ? input.selected : []).map((id) => str(id, 64)).filter(Boolean).slice(0, MAX_NODES);
    const sessionId = str(input.sessionId, 128);
    const session = sessionId ? sessionsDb.getSessionById(sessionId) : null;
    const projectPath = projectPathFor(str(input.projectId, 128), session);
    const conversation = await conversationContext(session);
    const linkables = parseLinkables(input.linkables);
    // Without the screenshot the AI still has the JSON, so a failed write is not an error.
    const image = await saveBoardImage(input.image).catch(() => null);
    const prompt = [
      '目前白板：',
      JSON.stringify(board),
      '',
      image ? `白板目前的截圖在 ${image}，回答前先用 Read 看這張圖，對照 JSON 檢查重疊、壓字、箭頭穿框、多餘的線。\n` : '',
      linkables.length > 0 ? `方框可以連到的對話和白板（linkables）：\n${JSON.stringify(linkables)}\n` : '',
      selected.length > 0 ? `使用者目前選取的方框 id：${selected.join('、')}\n` : '',
      conversation.length > 0
        ? `使用者是從一段對話打開白板的，那段對話最近說過（由舊到新）：\n${conversation.map((text, index) => `${index + 1}. ${text}`).join('\n')}\n`
        : '',
      chat.length > 0 ? `先前的對話：\n${chat.map((m) => `${m.role === 'user' ? '使用者' : '助手'}：${m.text}`).join('\n')}\n` : '',
      `使用者這次說：${message}`,
    ].join('\n');
    let answer: string;
    try {
      answer = await runClaude(prompt, projectPath);
    } catch (error) {
      throw new AppError(`The board assistant did not answer: ${(error as Error).message}`, { statusCode: 502, code: 'ASSIST_FAILED' });
    } finally {
      if (image) await rm(image, { force: true });
    }
    const { reply, board: next } = extractAnswerJson(answer);
    return { reply: toTraditional(reply) || '（沒有回覆文字）', board: next };
  },
};
