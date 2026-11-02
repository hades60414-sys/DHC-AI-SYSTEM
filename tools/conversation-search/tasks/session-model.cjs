'use strict';
// 開對話建議模型: is Sonnet enough for a new conversation's first message, or does it need Opus? Opus is the
// default and what every conversation ran with before; the rules below only ever raise the answer to opus.
const routeMoney = require('./assistant-route.cjs').rules.find((r) => r.id === 'money').re;
const MONEY = new RegExp(routeMoney.source + '|金額|稅額|降稅|庫存|加總|湊出|會計|\\bBOOK\\b', 'i');

module.exports = {
  id: 'session-model',
  choices: ['sonnet', 'opus'],
  default: 'opus',
  minConfidence: 0.6,
  escalate: { model: 'sonnet', below: 0.75 },
  timeoutMs: 6000,
  cacheTtlMs: 10 * 60 * 1000,
  ruleField: 'text',
  rules: [
    { id: 'money', re: MONEY, floor: 'opus' },
    { id: 'code-change', re: /改程式|寫程式|修\s*bug|部署|建置|重構|php\b|\.tsx?\b|\bSQL\b|公式|預存程序|stored procedure|\bselect\b[\s\S]{1,200}\bfrom\b|Traceback|Exception|Error\b|報錯|python|(做|寫|改).{0,4}網頁/i, floor: 'opus' },
  ],
  system: [
    '你替公司內部 AI 對話平台選模型。讀使用者開新對話的第一則訊息（text）、所在專案資料夾（project）、有沒有附件（hasAttachment），判斷這個對話用 Sonnet 夠不夠，還是需要 Opus。',
    'sonnet：問答、查資料或查設定、解釋概念或機制、問某個功能怎麼用、看 SOP 一步一步帶做、摘要或整理一段文字、改寫文字、列簡單的表、上網查新聞或案例、打招呼與測試。',
    'opus：要寫或修改程式、網頁、SQL、預存程序、排程或系統功能（包括 UI 改動、修 bug、看錯誤訊息找原因）；牽涉金額、部位、損益、庫存、對帳勾稽、風險數字的計算或核對（包括「是不是加總」「為什麼差這麼多」）；要設計計算邏輯或公式；多步驟的設計規劃或評估；會跑很久的長任務（照任務書開工、整夜跑、做簡報或影片）。',
    '拿不準時選 opus。只輸出一行 JSON，不要其他文字：{"choice":"sonnet|opus","confidence":0到1,"reason":"15 字內理由"}',
  ].join('\n'),
  prompt(input) {
    return JSON.stringify({
      text: String(input.text || '').slice(0, 1500),
      project: String(input.project || ''),
      hasAttachment: !!input.hasAttachment,
    });
  },
};
