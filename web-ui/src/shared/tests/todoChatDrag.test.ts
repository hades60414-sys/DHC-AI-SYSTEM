import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readTodoChatDrag, todoFocusText, todoPlanPrompt, TODO_CHAT_DRAG_TYPE } from '@/shared/todoChatDrag';

/** DHC CLI 10/08: a todo dragged into the chat becomes a plan-mode turn (empty chat) or a focus line (existing). */

const transfer = (raw: string) => ({ types: [TODO_CHAT_DRAG_TYPE], getData: () => raw }) as unknown as DataTransfer;

test('plan prompt lists the parent and nested open subtasks as an indented list', () => {
  const prompt = todoPlanPrompt({ text: '打磨待辦', trail: '', subtasks: ['方框移到後面', '矩陣改名', '  移動位置'] });
  assert.match(prompt, /^幫我規劃這個待辦任務：打磨待辦\n\n子任務：\n- 方框移到後面\n- 矩陣改名\n {2}- 移動位置\n\n先弄清楚/);
  assert.doesNotMatch(prompt, /屬於/);
});

test('focus text names the parent of a subtask and is one line without subtasks', () => {
  assert.equal(todoFocusText({ text: '矩陣改名', trail: '打磨待辦', subtasks: [] }), '接下來聚焦這個任務：矩陣改名（屬於：打磨待辦）');
});

test('a drop without a usable task is ignored', () => {
  assert.equal(readTodoChatDrag(transfer('')), null);
  assert.equal(readTodoChatDrag(transfer('not json')), null);
  assert.equal(readTodoChatDrag(transfer(JSON.stringify({ text: '  ' }))), null);
  assert.deepEqual(readTodoChatDrag(transfer(JSON.stringify({ text: ' 任務 ', subtasks: ['a', 3] }))), { text: '任務', trail: '', subtasks: ['a'] });
});
