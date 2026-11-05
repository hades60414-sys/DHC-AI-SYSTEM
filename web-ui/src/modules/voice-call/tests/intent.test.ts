import assert from 'node:assert/strict';

import { test } from 'vitest';

import { classify, type Intent, type PendingIntent } from '@/modules/voice-call/intent';

const cases: Array<[string, Intent, PendingIntent?]> = [
  // Stop speaking only stops the audio.
  ['先別說了', 'stop_speaking'],
  ['好，先別說了吧', 'stop_speaking'],
  ['停一下', 'stop_speaking'],
  ['安靜', 'stop_speaking'],
  ['不要講了', 'stop_speaking'],
  ['Stop.', 'stop_speaking'],
  ['stop talking', 'stop_speaking'],
  ['先别说了', 'stop_speaking'],
  // Cancelling a task needs a task word.
  ['取消剛剛的任務', 'cancel_task'],
  ['取消剛才的任務。', 'cancel_task'],
  ['取消任務', 'cancel_task'],
  ['停止任務', 'cancel_task'],
  ['把任務停掉', 'cancel_task'],
  ['幫我 cancel 任務', 'cancel_task'],
  ['cancel the task', 'cancel_task'],
  ['Stop the job', 'cancel_task'],
  ['取消刚刚的任务', 'cancel_task'],
  // Bare cancel words could mean either.
  ['取消', 'ambiguous_cancel'],
  ['算了', 'ambiguous_cancel'],
  ['不要了', 'ambiguous_cancel'],
  ['never mind', 'ambiguous_cancel'],
  ['結束通話', 'end_call'],
  ['掛斷', 'end_call'],
  ['bye', 'end_call'],
  // Messages that only mention the words stay messages.
  ['請幫我寫一個取消任務的功能', 'message'],
  ['查一下 2330 昨天的部位，還有取消任務的紀錄', 'message'],
  ['幫我查 10 月 3 號的 P&L', 'message'],
  ['好', 'message'],
  ['', 'message'],
  // Answers while a confirmation is pending.
  ['好', 'confirm_yes', 'confirm_cancel'],
  ['是的', 'confirm_yes', 'confirm_cancel'],
  ['確定', 'confirm_yes', 'confirm_cancel'],
  ['對，確定。', 'confirm_yes', 'confirm_cancel'],
  ['好的好的', 'confirm_yes', 'confirm_cancel'],
  ['不要', 'confirm_no', 'confirm_cancel'],
  ['yes', 'confirm_yes', 'confirm_cancel'],
  ['停止', 'confirm_yes', 'confirm_cancel'],
  ['不要', 'confirm_no', 'confirm_cancel'],
  ['繼續', 'confirm_no', 'confirm_cancel'],
  ['no', 'confirm_no', 'confirm_cancel'],
  ['取消任務', 'cancel_task', 'ask_stop_or_cancel'],
  ['停止播音', 'stop_speaking', 'ask_stop_or_cancel'],
  ['別說了', 'stop_speaking', 'ask_stop_or_cancel'],
];

test.each(cases)('「%s」 → %s (pending %s)', (text, expected, pendingIntent) => {
  assert.equal(classify(text, { pendingIntent }), expected);
});
