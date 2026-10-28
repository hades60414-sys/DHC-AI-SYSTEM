/**
 * DHC CLI 10/13: a new session is first named after the start of its first message (buildCloudCliSessionName),
 * which reads badly — a long Chinese sentence, a greeting, a file wrapper. Claude Code writes its own short title
 * into the transcript (`ai-title` lines), so a name that is still that automatic prefix gets replaced by it.
 * A name the user typed is never a prefix of the first message, so it is left alone.
 */

const SPEAKER_MARK = /^【[^】\n]{1,30}】\s*/;
const MIN_AUTO_NAME_CHARS = 2;

const normalize = (text: string) => text.replace(SPEAKER_MARK, '').replace(/\s+/g, ' ').trim();

/** True when `name` is the automatic one: the start of the first message (or the untitled placeholder). */
export function isAutoSessionName(name: string | null | undefined, firstPrompt: string | null | undefined): boolean {
  if (!name || name === 'Untitled Session' || name === 'Untitled Claude Session') return true;
  // The short name given at creation (round 2) is automatic too.
  if (firstPrompt && name === fallbackTitle(firstPrompt)) return true;
  const normalizedName = normalize(name);
  const normalizedPrompt = normalize(firstPrompt ?? '');
  if (normalizedName.length < MIN_AUTO_NAME_CHARS || !normalizedPrompt) return false;
  return normalizedPrompt.startsWith(normalizedName);
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : ''))
    .join(' ');
};

/** The newest `ai-title` and the first real user message of one session transcript. */
export function readTitleInputs(transcript: string, sessionId: string): { aiTitle: string | null; firstPrompt: string | null } {
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;
  for (const line of transcript.split(/\r?\n/)) {
    if (!line) continue;
    const isTitle = line.includes('"ai-title"');
    if (!isTitle && firstPrompt !== null) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (data.type === 'ai-title' && (data.sessionId === undefined || data.sessionId === sessionId)) {
      const title = typeof data.aiTitle === 'string' ? data.aiTitle.trim() : '';
      if (title) aiTitle = title;
    } else if (firstPrompt === null && data.type === 'user' && !data.isMeta && !data.isCompactSummary) {
      const text = textOf((data.message as { content?: unknown } | undefined)?.content).trim();
      if (text && !text.startsWith('<')) firstPrompt = text;
    }
  }
  return { aiTitle, firstPrompt };
}

/**
 * Claude Code now and then titles a Chinese conversation in simplified characters. The common ones that only
 * exist in simplified Chinese are swapped for their traditional forms (ambiguous ones such as 后 / 里 / 干 are left).
 */
const SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = Object.fromEntries(
  [
    '与與', '联聯', '会會', '设設', '计計', '这這', '个個', '们們', '时時', '现現', '问問', '题題', '数數', '据據',
    '库庫', '务務', '简簡', '体體', '为為', '说說', '经經', '济濟', '价價', '应應', '变變', '边邊', '进進', '选選',
    '择擇', '项項', '开開', '关關', '单單', '报報', '测測', '试試', '读讀', '写寫', '处處', '优優', '从從', '险險',
    '风風', '场場', '级級', '构構', '脑腦', '电電', '网網', '页頁', '历歷', '录錄', '询詢', '产產', '资資', '讯訊',
    '对對', '话話', '统統', '图圖', '档檔', '汇匯', '总總', '规規', '则則', '权權', '训訓', '练練', '实實', '验驗',
    '检檢', '证證', '认認', '账帳', '户戶', '号號', '码碼', '错錯', '误誤', '获獲', '储儲', '输輸', '转轉', '换換',
    '执執', '运運', '营營', '维維', '护護', '态態', '审審', '标標', '签簽', '类類', '链鏈', '节節', '点點', '线線',
    '画畫', '键鍵', '机機', '业業', '东東', '车車', '买買', '卖賣', '额額', '识識', '别別', '层層', '虑慮', '虚虛',
    '质質', '损損', '盈盈', '亏虧', '债債', '币幣', '汇匯', '贷貸', '还還', '归歸', '组組', '织織', '员員', '门門',
    '间間', '闻聞', '问問', '阅閱', '页頁', '题題', '论論', '议議', '让讓', '记記', '设設', '详詳', '请請', '谁誰',
    '调調', '读讀', '课課', '让讓', '认認', '识識', '语語', '译譯', '订訂', '计計', '讨討', '讲講', '许許', '诉訴',
    '这這', '进進', '远遠', '连連', '过過', '达達', '迁遷', '适適', '递遞', '逻邏', '辑輯', '导導', '寻尋', '属屬',
    '岁歲', '岛島', '广廣', '庄莊', '应應', '库庫', '废廢', '张張', '弹彈', '归歸', '录錄', '彻徹', '征徵', '径徑',
    '惯慣', '态態', '恢恢', '战戰', '户戶', '扩擴', '护護', '报報', '择擇', '换換', '摄攝', '撑撐', '数數', '断斷',
    '时時', '显顯', '晓曉', '条條', '杂雜', '权權', '极極', '构構', '标標', '样樣', '档檔', '桥橋', '检檢', '楼樓',
    '历歷', '归歸', '气氣', '决決', '况況', '净淨', '凭憑', '击擊', '创創', '删刪', '剧劇', '劝勸', '办辦', '务務',
    '动動', '劳勞', '势勢', '区區', '协協', '单單', '卫衛', '压壓', '厂廠', '县縣', '发發', '变變', '叠疊', '号號',
  ].map((pair) => [pair[0], pair[1]]),
);

export function toTraditional(text: string): string {
  return text.replace(/[\u4e00-\u9fff]/g, (char) => SIMPLIFIED_TO_TRADITIONAL[char] ?? char);
}

/**
 * Round 3: every session created after the rollout gets the new names; anything older keeps whatever it is called
 * (the user's call: old sessions are not touched). `DHC_AUTO_TITLE_SINCE` (an ISO time) overrides the cut-off.
 */
const ROLLOUT_AT = '2026-10-13T03:35:00Z';

/** `createdAt` as the sessions table stores it: `YYYY-MM-DD HH:MM:SS` in UTC (an ISO string also works). */
export function isTitleEligible(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false;
  const created = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(createdAt) ? createdAt : `${createdAt.replace(' ', 'T')}Z`);
  const since = Date.parse(process.env.DHC_AUTO_TITLE_SINCE || ROLLOUT_AT);
  return Number.isFinite(created) && Number.isFinite(since) && created >= since;
}


const MAX_TITLE_WIDTH = 48;
const widthOf = (char: string) => (/[\u2e80-\uffef]/u.test(char) ? 2 : 1);
const LEADING_JUNK = /^[\s\-–—:：,，.。、;；]+/u;
const TRAILING_JUNK = /[\s\-–—:：,，.。、;；!！?？]+$/u;
const WRAPPING_QUOTES = /^["'“‘「『](.+)["'”’」』]$/u;

/**
 * Round 1: one line, no edge punctuation, no quotes wrapping the whole title, at most 48 columns wide (a Chinese
 * character is two) — cut at a
 * natural break (space, comma, colon) when there is one late enough. Brackets inside the title are left alone.
 */
export function tidyTitle(title: string): string {
  let text = title.replace(/\s+/g, ' ').replace(/\s*([：:，,、；;])\s*/gu, '$1').trim();
  const wrapped = WRAPPING_QUOTES.exec(text);
  if (wrapped && !/["'“”‘’「」『』]/u.test(wrapped[1])) text = wrapped[1];
  text = text.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '');
  const chars = [...text];
  let fit = 0;
  for (let width = 0; fit < chars.length && width + widthOf(chars[fit]) <= MAX_TITLE_WIDTH; fit += 1) width += widthOf(chars[fit]);
  if (fit < chars.length) {
    const head = chars.slice(0, fit).join('');
    const breakAt = Math.max(head.lastIndexOf(' '), head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf('：'));
    // No natural break: do not cut a code name or an English word in half — stop before it instead.
    const word = /[A-Za-z0-9_.]+$/.exec(head);
    const cutsWord = word !== null && /[A-Za-z0-9_.]/.test(chars[fit] ?? '') && word.index >= 6;
    const cut = breakAt >= 12 ? breakAt : cutsWord ? word.index : head.length;
    text = head.slice(0, cut).replace(TRAILING_JUNK, '');
  }
  return text;
}

const FILLER = /^(?:請問|請|麻煩你?|需要你|幫我|幫忙|你(?:可以|能不能|能|幫我)|可以|可不可以|能不能|我想要|我想|我要|我需要|想請你|想問一下|想問|嗨|哈囉|hi|hello|hey)[\s,，、:：]*/iu;
const UNTITLED = 'Untitled Session';

/**
 * Round 2: a short name from the first message itself, for the moment a session is created and for sessions that
 * never get an ai-title — its first sentence without greetings, links, code or attached-file blocks, cut at the
 * first comma once it says something.
 */
export function fallbackTitle(prompt: string): string {
  const text = prompt
    .replace(SPEAKER_MARK, '')
    .replace(/<files_input>[\s\S]*?(?:<\/files_input>|$)/g, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#+\s*/gm, '');
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  let sentence = firstLine.split(/[。！？!?]/u)[0].trim();
  for (let round = 0; round < 3; round += 1) sentence = sentence.replace(FILLER, '');
  if ([...sentence].length > 16) {
    const clause = /^(.{6,24}?)[，,、；;]/u.exec(sentence);
    if (clause) sentence = clause[1];
  }
  sentence = sentence.replace(/[嗎呢吧啊喔哦]+$/u, '');
  return tidyTitle(sentence) || tidyTitle(firstLine) || UNTITLED;
}

/** The name the session gets from its transcript: the ai-title, in traditional characters and tidied. */
export function finalizeTitle(aiTitle: string | null | undefined, _firstPrompt: string | null | undefined): string | null {
  if (!aiTitle) return null;
  return tidyTitle(toTraditional(aiTitle)) || null;
}
