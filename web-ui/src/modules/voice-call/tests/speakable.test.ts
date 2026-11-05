import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  CAP_NOTICE,
  CODE_PLACEHOLDER,
  emptySpeechBuffer,
  feedSpeech,
  flushSpeech,
  looksLikeQuota,
  TABLE_PLACEHOLDER,
} from '@/modules/voice-call/speakable';

/** Streams the text in the given pieces and returns everything that would be spoken, in order. */
function speakAll(pieces: string[], max = 600): string[] {
  let buffer = emptySpeechBuffer();
  const out: string[] = [];
  for (const piece of pieces) {
    const fed = feedSpeech(buffer, piece, max);
    buffer = fed.buffer;
    out.push(...fed.sentences);
  }
  out.push(...flushSpeech(buffer, max).sentences);
  return out;
}

test('complete sentences come out while the text is still streaming', () => {
  let buffer = emptySpeechBuffer();
  const first = feedSpeech(buffer, '結論：昨天部位正常。明細', 600);
  assert.deepEqual(first.sentences, ['結論：昨天部位正常。']);
  buffer = first.buffer;
  const second = feedSpeech(buffer, '在畫面上', 600);
  assert.deepEqual(second.sentences, [], 'half a sentence waits');
  assert.deepEqual(flushSpeech(second.buffer, 600).sentences, ['明細在畫面上']);
});

test('markdown is read as plain words', () => {
  const spoken = speakAll(['## 結果\n', '**總損益**是 [報表](https://x.example/r) 上的數字。\n', '- 第一項\n1. 第二項\n']);
  assert.deepEqual(spoken, ['結果', '總損益是 報表 上的數字。', '第一項', '第二項']);
});

test('code blocks and tables are announced, not read', () => {
  const spoken = speakAll([
    '改好了。\n```ts\nconst a = 1;\nconsole.log(a);\n```\n',
    '| 代號 | 損益 |\n|---|---|\n| 2330 | 100 |\n',
    '請確認。',
  ]);
  assert.deepEqual(spoken, ['改好了。', CODE_PLACEHOLDER, TABLE_PLACEHOLDER, '請確認。']);
});

test('a code fence split across stream chunks is never read aloud', () => {
  const spoken = speakAll(['先看這段：\n``', '`py\nprint("秘密。")\n', '```\n完成。']);
  assert.deepEqual(spoken, ['先看這段：', CODE_PLACEHOLDER, '完成。']);
});

test('long answers stop at the cap and point to the screen', () => {
  const sentence = '這是一句大約二十個字的測試句子用來測上限。';
  const spoken = speakAll([sentence.repeat(10)], 100);
  assert.equal(spoken[spoken.length - 1], CAP_NOTICE);
  assert.equal(spoken.filter((s) => s === CAP_NOTICE).length, 1);
  assert.ok(spoken.slice(0, -1).join('').length <= 100);
});

test('English sentences split on periods followed by space', () => {
  assert.deepEqual(speakAll(['Done. Check the screen for details.']), ['Done.', 'Check the screen for details.']);
});

test('quota and usage-limit errors are recognized', () => {
  assert.equal(looksLikeQuota('Claude AI usage limit reached|1793246881'), true);
  assert.equal(looksLikeQuota('API Error: 429 Too Many Requests'), true);
  assert.equal(looksLikeQuota('額度不足'), true);
  assert.equal(looksLikeQuota('File not found: report.xlsx'), false);
});
