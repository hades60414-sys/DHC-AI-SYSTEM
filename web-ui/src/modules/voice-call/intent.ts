export type Intent =
  | 'stop_speaking'
  | 'cancel_task'
  | 'ambiguous_cancel'
  | 'confirm_yes'
  | 'confirm_no'
  | 'end_call'
  | 'message';

export type PendingIntent = 'confirm_cancel' | 'ask_stop_or_cancel';

// STT may hand back simplified characters (Android, whisper before normalization); only the ones the commands use.
const SIMPLIFIED: Record<string, string> = {
  别: '別', 说: '說', 讲: '講', 务: '務', 结: '結', 话: '話', 断: '斷', 执: '執', 刚: '剛', 这: '這',
  个: '個', 现: '現', 继: '繼', 续: '續', 确: '確', 认: '認', 对: '對', 静: '靜', 挂: '掛', 关: '關',
  闭: '閉', 没: '沒', 错: '錯', 见: '見', 终: '終', 语: '語', 声: '聲', 读: '讀', 销: '銷', 掰: '掰',
};

export function normalizeUtterance(text: string): string {
  return Array.from(text.toLowerCase())
    .map((ch) => SIMPLIFIED[ch] ?? ch)
    .join('')
    .replace(/[\s，。！？、；：,.!?;:~～…「」『』"'“”‘’()（）\-]/g, '');
}

// Politeness and filler words around a short command; stripped so 「好，先別說了吧」 still reads as the command.
const LEAD = /^(那個|那|好啦|好|嗯|欸|喂|請你|請|你|幫我|麻煩|先|ok|okay)+/;
const TAIL = /(吧|啦|了|喔|哦|啊|呀|好嗎|好不好|一下下|please)+$/;

// Commands are short; a long sentence that mentions 「取消任務」 is a message about it, not a command.
const MAX_COMMAND_CHARS = 16;

const STOP_SPEAKING = [
  /^(別|不要|不用|甭)(再)?(說|講|念|唸|讀|播)(了)?$/,
  /^停一下$/, /^停$/, /^暫停$/, /^安靜(一下|點)?$/, /^閉嘴$/, /^噓+$/,
  /^停止(播放|播音|朗讀|說話|講話|唸|念)$/, /^(不要|別)吵$/,
  /^stop(talking|speaking|reading)?$/, /^shh+$/, /^shutup$/, /^quiet$/, /^bequiet$/,
];

const TASK_WORD = '(任務|工作|執行|操作|作業|指令|task|job|run|it)';
const CANCEL_VERB = '(取消|停止|中止|終止|停掉|中斷|撤銷|cancel|stop|abort|kill)';
const CANCEL_TASK = [
  new RegExp(`^${CANCEL_VERB}(掉)?(剛剛|剛才|目前|現在|這個|那個|正在跑的|正在執行的|the|this|that|current)?(的)?${TASK_WORD}$`),
  new RegExp(`^(把)?(剛剛|剛才|目前|現在|這個|那個)?(的)?${TASK_WORD}${CANCEL_VERB}(掉)?$`),
  /^abort$/,
];

const AMBIGUOUS_CANCEL = [/^(取消|算了|不要了|不用了|cancel|nevermind|forgetit|forgetaboutit)$/];

const END_CALL = [
  /^(結束|關閉|掛斷|掛掉)(通話|語音|電話)?$/, /^掛電話$/, /^(再見|拜拜|掰掰)$/,
  /^(bye|byebye|goodbye|hangup|endcall|endthecall)$/,
];

// 「對，確定」「好的好的」: a run of yes words is still one yes.
const YES = [/^(是的|是|對的|對啊|對|好的|好|要|確定|確認|沒錯|可以|停吧|停止|停|取消吧|取消|嗯|yes|yeah|yep|ok|okay|sure|confirm)+$/];
const NO = [/^(不|不要|不用|否|不是|先不要|別|不行|繼續|沒有|no|nope|dont|keepgoing|continue)$/];

const matches = (patterns: RegExp[], text: string) => patterns.some((pattern) => pattern.test(text));

function core(text: string): string {
  return text.replace(LEAD, '').replace(TAIL, '');
}

/**
 * Reads a spoken utterance as a call command or a message for the agent. Stop-speaking and cancel-task stay
 * apart on purpose: only an explicit task word ever leads to an abort, and the abort still needs a yes.
 */
export function classify(text: string, ctx: { pendingIntent?: PendingIntent | null } = {}): Intent {
  const normalized = normalizeUtterance(text);
  if (!normalized) return 'message';
  if (normalized.length > MAX_COMMAND_CHARS * 2) return 'message';
  const candidates = [normalized, core(normalized)].filter((c, i, all) => c && all.indexOf(c) === i);
  const any = (patterns: RegExp[]) => candidates.some((c) => c.length <= MAX_COMMAND_CHARS && matches(patterns, c));

  if (ctx.pendingIntent === 'confirm_cancel') {
    if (any(NO)) return 'confirm_no';
    if (any(YES) || any(CANCEL_TASK)) return 'confirm_yes';
  }
  if (ctx.pendingIntent === 'ask_stop_or_cancel' && normalized.length <= MAX_COMMAND_CHARS) {
    if (/(任務|工作|執行|task|job)/.test(normalized)) return 'cancel_task';
    if (/(播|說|講|念|唸|聲音|speak|talk|voice|audio)/.test(normalized)) return 'stop_speaking';
  }

  if (any(END_CALL)) return 'end_call';
  if (any(CANCEL_TASK)) return 'cancel_task';
  if (any(STOP_SPEAKING)) return 'stop_speaking';
  if (any(AMBIGUOUS_CANCEL)) return 'ambiguous_cancel';
  return 'message';
}
