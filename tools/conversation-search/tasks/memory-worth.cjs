'use strict';
// Decide whether a finished exchange holds durable facts worth remembering (hermes MEMORY_SCHEMA rule).
// Answer carries `items`: up to 3 fact statements, returned to callers as result.extra.items.
module.exports = {
  id: 'memory-worth',
  choices: ['skip', 'save'],
  default: 'skip',
  minConfidence: 0.7,
  timeoutMs: 20000,
  cacheTtlMs: 60 * 60 * 1000,
  ruleField: 'user',
  rules: [
    { id: 'secret', re: /密碼|PWD|帳密|token|金鑰|PAIRING_SHA256/i, force: 'skip' },
  ],
  extra: { items: { maxItems: 3, maxLen: 120, requiredFor: ['save'] } },
  system: [
    '你判斷一段剛結束的對話（user 問、assistant 答）裡，有沒有值得長期記住的事實。',
    '只記「以後每次對話都適用」的事：使用者的角色與職責、偏好、固定的規則或約定、名詞代稱（例如「41 就是某台主機」）。',
    '不記：這次工作的進度、完成紀錄、暫時待辦、一次性的查詢結果、數字金額、密碼帳密、人名。',
    '每條寫成陳述事實（「使用者負責月底 ReportBI 勾稽」），不要寫成指令（「記得提醒他」），每條 40 字內，最多 3 條。',
    '沒有值得記的就選 skip，items 給空陣列。',
    '只輸出一行 JSON：{"choice":"save|skip","confidence":0到1,"reason":"15 字內理由","items":["..."]}',
  ].join('\n'),
  prompt(input) {
    return JSON.stringify({ user: String(input.user || '').slice(0, 2000), assistant: String(input.assistant || '').slice(0, 2000) });
  },
};
