import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fallbackTitle,
  finalizeTitle,
  isAutoSessionName,
  isTitleEligible,
  readTitleInputs,
  tidyTitle,
  toTraditional,
} from '@/modules/providers/list/claude/auto-session-title.js';

/**
 * DHC CLI 10/13 session names: a new session starts with a short phrase from its first message and takes Claude
 * Code's own title once there is one; a name the user typed always stays; sessions older than the rollout are not
 * touched. These hold the pieces the synchronizer and the session service rely on.
 */

const line = (value: unknown) => JSON.stringify(value);

test('the automatic name is the start of the first message or the creation phrase; a typed name is not', () => {
  const prompt = '我有一個新任務，是要做乾淨版RAG跟OUTLOOK信件資料存儲，這包會建立在另一台電腦上';
  assert.equal(isAutoSessionName('我有一個新任務，是要做乾淨版RAG跟OUTLOOK信件資料存儲，這包', prompt), true, 'old style: a prefix');
  assert.equal(isAutoSessionName(fallbackTitle(prompt), prompt), true, 'new style: the creation phrase');
  assert.equal(isAutoSessionName('【同事A】我有一個新任務', '【同事A】 我有一個新任務，是要做'), true, 'the Co-Work speaker mark is ignored');
  assert.equal(isAutoSessionName('select  日期,sum(權益數)', 'select 日期,sum(權益數) as 權益數'), true, 'spacing is ignored');
  assert.equal(isAutoSessionName('Untitled Session', 'anything'), true);
  assert.equal(isAutoSessionName('資料庫重建任務', '接續之前的資料庫重建專案，目的地是新主機'), false, 'renamed by hand');
  assert.equal(isAutoSessionName('我', '我想問一下'), false, 'one character is too little to tell');
});

test('reads the newest ai-title and the first real user message', () => {
  const transcript = [
    line({ type: 'user', isMeta: true, message: { content: '<command-name>/clear</command-name>' }, sessionId: 's' }),
    line({ type: 'user', message: { content: '<local-command-stdout></local-command-stdout>' }, sessionId: 's' }),
    line({ type: 'user', message: { content: [{ type: 'text', text: '幫我查 DB1 的交易日曆' }] }, sessionId: 's' }),
    line({ type: 'ai-title', aiTitle: '交易日曆查詢', sessionId: 's' }),
    line({ type: 'ai-title', aiTitle: 'DB1 交易日曆查詢', sessionId: 's' }),
    line({ type: 'ai-title', aiTitle: '別的對話', sessionId: 'other' }),
    'not json',
  ].join('\n');
  assert.deepEqual(readTitleInputs(transcript, 's'), { aiTitle: 'DB1 交易日曆查詢', firstPrompt: '幫我查 DB1 的交易日曆' });
});

test('round 1: titles are tidied and cut by display width at a natural break', () => {
  assert.equal(tidyTitle('  「月報 數據蒐集測試」 '), '月報 數據蒐集測試', 'quotes wrapping the whole title go');
  assert.equal(tidyTitle('主視窗「正式」區的「送出」'), '主視窗「正式」區的「送出」', 'brackets inside stay');
  assert.equal(tidyTitle('改網頁： 把預測頁面換成Q3。'), '改網頁：把預測頁面換成Q3', 'space after a colon and the final stop go');
  assert.equal(tidyTitle('demo_tbl_monthly_report 契約調整邏輯檢視'), 'demo_tbl_monthly_report 契約調整邏輯檢視', '40 columns fit');
  assert.equal(tidyTitle('CCS and RAG integration progress'), 'CCS and RAG integration progress', 'English is not cut twice as early');
  const long = tidyTitle('這是一個非常非常長的標題，裡面有很多很多的字，一直講一直講停不下來');
  assert.ok([...long].length <= 24 && !long.endsWith('，'), long);
  assert.equal(tidyTitle('到DB1的資料庫查詢domain.dbo.tradingdate_history_table'), '到DB1的資料庫查詢', 'a code name is not cut in half');
});

test('round 2: the creation phrase drops greetings, links, code and files and keeps the point', () => {
  assert.equal(fallbackTitle('python 昨天晚上九點出現這個錯誤，Connection unexpectedly closed，但我今天早上重跑卻沒事'), 'python 昨天晚上九點出現這個錯誤');
  assert.equal(fallbackTitle('我想清理我這邊過多但沒在用的SESSION，建議怎麼取捨？'), '清理我這邊過多但沒在用的SESSION');
  assert.equal(fallbackTitle('需要你幫我改網頁：http://intranet.example.com/report 把預測頁面換成Q3'), '改網頁：把預測頁面換成Q3');
  assert.equal(fallbackTitle('你可以幫我去Chat取得資料嗎?'), '去Chat取得資料');
  assert.equal(fallbackTitle('【同事A】接續之前的資料庫重建專案，目的地是新主機'), '接續之前的資料庫重建專案');
  assert.equal(fallbackTitle('看這個\n<files_input>The user attached 1 file(s)</files_input>'), '看這個');
  assert.equal(fallbackTitle('test'), 'test');
  assert.equal(fallbackTitle('   '), 'Untitled Session');
});

test('the ai-title is made traditional and tidied; simplified-only characters are swapped', () => {
  assert.equal(finalizeTitle('X1 RAG处理与DB2电脑操作架构优化', ''), 'X1 RAG處理與DB2電腦操作架構優化');
  assert.equal(finalizeTitle('Session cleanup strategy', '我想清理'), 'Session cleanup strategy', 'English titles are kept');
  assert.equal(finalizeTitle(null, 'x'), null);
  assert.equal(toTraditional('ABC 測試工單核准'), 'ABC 測試工單核准');
});

test('round 3: only sessions created after the rollout are renamed', () => {
  delete process.env.DHC_AUTO_TITLE_SINCE;
  assert.equal(isTitleEligible('2026-10-13 03:34:59'), false, 'just before the rollout (UTC, as the table stores it)');
  assert.equal(isTitleEligible('2026-10-13 03:35:00'), true);
  assert.equal(isTitleEligible('2026-10-20T08:00:00Z'), true, 'an ISO time works too');
  assert.equal(isTitleEligible('2026-09-01 10:00:00'), false);
  assert.equal(isTitleEligible(null), false);
  process.env.DHC_AUTO_TITLE_SINCE = '2020-01-01T00:00:00Z';
  assert.equal(isTitleEligible('2026-09-01 10:00:00'), true, 'the cut-off can be overridden');
  delete process.env.DHC_AUTO_TITLE_SINCE;
});
