import assert from 'node:assert/strict';

import { test } from 'vitest';

import { emptyReview, reviewSummary } from '@/modules/tool-library/tools/codeReviewModel';
import { boardSummary, emptyBoard, emptyItem } from '@/modules/tool-library/tools/projectBoardModel';

/** 10/25 R4 (稽核 P1-1): what 送到… → 貼到聊天室／問團隊小助理 carries from 程式差異審閱台 and 專案板. */
test('a review summary lists the findings, then where the two versions differ', () => {
  const review = { ...emptyReview('改 SP'), before: 'a\nb', after: 'a\nc', findings: [{ side: 'after' as const, line: 2, severity: 'high' as const, title: '少了 WHERE', detail: '會\n全表更新' }] };
  const text = reviewSummary(review);
  assert.match(text, /^語言：/);
  assert.match(text, /【AI 標的問題】高 1\n1\. \[高\] 少了 WHERE（新版第 2 行）：會 全表更新/);
  assert.match(text, /【兩版差異】\n共 1 處差異/);
  assert.doesNotMatch(reviewSummary({ ...review, findings: [] }), /AI 標的問題/);
});

test('a board summary goes column by column; an empty board says so', () => {
  const board = { ...emptyBoard('十月'), items: [emptyItem('對帳'), emptyItem('寫週報', 'done')] };
  const text = boardSummary(board);
  assert.match(text, /^【待辦】\n- \[待辦\] 對帳/);
  assert.match(text, /【完成】\n- \[完成\] 寫週報/);
  assert.ok(text.indexOf('對帳') < text.indexOf('寫週報'));
  assert.equal(boardSummary(emptyBoard('空')), '（板上還沒有工作）');
});
