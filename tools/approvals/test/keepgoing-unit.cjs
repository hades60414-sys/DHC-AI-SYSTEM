// 時限續做單元測試：講法解析（不登記）＋ tick 的判斷（假對話紀錄、--dry，不送訊息）
const { parse } = require(require('path').join(require('os').homedir(), '.claude/hooks/keepgoing-detect.js'));
const NOW = Date.parse('2026-11-03T00:20:00Z'); // 台灣 08:20
const tw = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
let bad = 0;
const t = (s, want) => { const r = parse(s, NOW); const got = !r ? null : r.cancel ? 'cancel' : tw(r.until); if (got !== want) bad++; console.log(got === want ? 'OK ' : 'BAD', s, '→', got); };
t('不然你再試個兩小時？', '10:20');
t('再做 3 小時', '11:20');
t('繼續跑一個半小時', '09:50');
t('反正到明天早上八點前隨便你玩', '08:00'); // 08:00 已過 → 明天 08:00（日期不顯示，時間對即可）
t('到 10 點前你自己做', '10:00');
t('到下午3點半前隨便你', '15:30');
t('停', 'cancel');
t('先停。', 'cancel');
t('這兩小時的資料幫我整理', null);
t('到10點的報表', null);
t('再試一次', null);
t('停車場的資料', null);
console.log(bad ? `FAIL ${bad}` : 'ALL PASS'); process.exitCode = bad ? 1 : 0;
