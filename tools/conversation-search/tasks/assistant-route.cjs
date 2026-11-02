'use strict';
// Route one chat-room message for the 小助理. Choices run from least to most capable; rule floors only raise.
const MONEY = /損益|部位|對帳|勾稽|VaR|限額|超限|保證金|淨資本|曝險|盈虧|P&L|PnL|\bPL\b|報酬率|ROA|ROE|Greeks|Delta|Gamma|Vega|市值|評價|淨值|差額|沖銷|資本適足|BIS|風險值|壓力測試/i;

module.exports = {
  id: 'assistant-route',
  choices: ['quick', 'local', 'remote', 'opus', 'handoff'],
  default: 'remote',
  minConfidence: 0.6,
  // Haiku below 0.75, or malformed, gets one Sonnet opinion before falling back to the default route.
  escalate: { model: 'sonnet', below: 0.75 },
  timeoutMs: 15000,
  cacheTtlMs: 10 * 60 * 1000,
  ruleField: 'text',
  rules: [
    { id: 'money', re: MONEY, floor: 'opus' },
    { id: 'calc-logic', re: /寫.{0,6}(SQL|語法|公式|程式)|(SQL|公式|計算).{0,6}(怎麼寫|幫我寫|改寫)|哪幾筆加起來/i, floor: 'opus' },
    { id: 'secret', re: /密碼|PWD|帳密|token|金鑰/i, floor: 'opus' },
    { id: 'build', re: /(帶我|幫我|要|重新)(做)?配對|配對精簡版|\bpair\b|安裝包|打包|部署|建置|重新上線/i, floor: 'opus' },
    { id: 'host', re: /\b(srv-[a-z0-9]+|pc-[a-z]+)\b|outlook|信箱|寄給我|寄的信|EKB|SSMS|ragent|代理程式/i, floor: 'remote' },
  ],
  system: [
    '你是公司內部聊天室「小助理」的分派器，只負責選路線，不回答問題本身。',
    '讀使用者這一則訊息（text），必要時參考最近 3 則（recent），選一條路線：',
    'quick：打招呼、閒聊、「測試一下」、問小助理能做什麼、改寫一句話、一般常識；不需要任何工具或檔案就能答。',
    'local：要讀或寫本機的檔案、記憶（「記住」「大家都要知道」）、SOP、這台主機自己的排程與夜間分流紀錄、網頁或上網查；不需要真的連公司遠端主機。只問遠端主機怎麼操作、看 SOP 就能答的知識題也算 local。',
    'remote：要用公司遠端主機或內部系統：srv-db／srv-rag／srv-main／pc-mgr／srv-src／srv-db2、同事電腦、Outlook 信件、EKB、SQL Server 資料庫、代理程式狀態。配對或安裝流程進行中，使用者貼回指令輸出或回「好了」「成功」，也算 remote（繼續帶步驟）。',
    'opus：牽涉金額、部位、損益、風險、限額、對帳勾稽的數字；要寫 SQL 或計算邏輯；需要多步推理或判斷的複雜問題；要求印出密碼帳密這類敏感請求。',
    'handoff：會超過 5 分鐘的長工作：配對新電腦（包括「我要讓這台電腦能用 Outlook／被讀檔案」而還沒接好）、安裝、建置或部署、修改 DHC CLI／聊天室／小工具的功能、寫排程或自動化程式、改好幾個檔案、做大報表或整份簡報。應另開一個獨立的 Opus 對話。',
    '拿不準時往能力較強的路線選，不要往下選。訊息含糊（例如「幫我把那個報表弄好」）時看 recent；仍不清楚就選 remote。',
    '只輸出一行 JSON，不要其他文字：{"choice":"quick|local|remote|opus|handoff","confidence":0到1,"reason":"15 字內理由"}',
  ].join('\n'),
  prompt(input) {
    const recent = (input.recent || []).slice(-3).map((s) => String(s).slice(0, 200));
    return JSON.stringify({
      text: String(input.text || '').slice(0, 1500),
      roomKind: input.roomKind || 'dm',
      recent,
      hasAttachment: !!input.hasAttachment,
    });
  },
};
