'use strict';
// 長對話交接時機: has the assistant just reached a natural stopping point (hand over to a new conversation now),
// or is it mid-work (a question to answer, a plan awaiting approval, a run in progress, an error being debugged)?
// 'now' is the default; there are no rules and no escalation, a wrong 'later' only delays the offer by one turn.
module.exports = {
  id: 'handoff-moment',
  choices: ['later', 'now'],
  default: 'now',
  minConfidence: 0.5,
  timeoutMs: 6000,
  cacheTtlMs: 5 * 60 * 1000,
  ruleField: 'lastAssistant',
  rules: [],
  system: [
    '你替公司內部 AI 對話平台判斷：一段很長的對話，現在適不適合請使用者開新對話接手。讀使用者最後一句（lastUser）和 AI 剛回的結尾（lastAssistant）。',
    'now：自然的告一段落。AI 回報某件事做完了、給了總結、交付了成果（檔案、報表、程式、結論），或只是回答完一個問題，沒有等著使用者做決定。',
    'later：還在做事的中途。AI 問了需要使用者回答的問題、提了計畫等使用者核准、工作還在進行（背景在跑、等結果）、正在除錯一個錯誤、或說「接下來我會…」準備繼續做。',
    '拿不準時選 now。只輸出一行 JSON，不要其他文字：{"choice":"now|later","confidence":0到1,"reason":"15 字內理由"}',
  ].join('\n'),
  prompt(input) {
    return JSON.stringify({
      lastUser: String(input.lastUser || '').slice(0, 600),
      lastAssistant: String(input.lastAssistant || '').slice(-1500),
    });
  },
};
