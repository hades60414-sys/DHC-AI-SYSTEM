import { describe, expect, it } from 'vitest';

import {
  bindFreshStart,
  clearFreshStart,
  FRESH_IDLE_MS,
  freshStartFor,
  freshStartPrompt,
  markFreshStart,
  shouldStartFresh,
  stripFreshStartNote,
} from '@/modules/chat/utils/freshStart';

const now = Date.parse('2026-10-31T12:00:00Z');
const base = { provider: 'claude', used: 200_000, lastActivity: now - FRESH_IDLE_MS - 1, now, text: '幫我查一下明天有哪些股票要除權息，並列出每股配息金額', hasAttachments: false, busy: false };

describe('閒置換新對話', () => {
  it('moves a new request in a long conversation idle over an hour', () => {
    expect(shouldStartFresh(base)).toBe(true);
  });

  it('stays put when short, recent, busy, with attachments, a slash command, another provider or a follow-up', () => {
    expect(shouldStartFresh({ ...base, used: 149_999 })).toBe(false);
    expect(shouldStartFresh({ ...base, lastActivity: now - FRESH_IDLE_MS + 1000 })).toBe(false);
    expect(shouldStartFresh({ ...base, lastActivity: undefined })).toBe(false);
    expect(shouldStartFresh({ ...base, busy: true })).toBe(false);
    expect(shouldStartFresh({ ...base, hasAttachments: true })).toBe(false);
    expect(shouldStartFresh({ ...base, text: '/compact' })).toBe(false);
    expect(shouldStartFresh({ ...base, provider: 'codex' })).toBe(false);
    expect(shouldStartFresh({ ...base, text: '剛剛那張表再改一下欄位' })).toBe(false);
    expect(shouldStartFresh({ ...base, text: '繼續' })).toBe(false);
  });

  it('keeps short or referential follow-ups in the original chat', () => {
    for (const text of ['再算一次', '改成百分比', '用同樣資料做圖', '第二項為什麼不符', '幫我查明天的除權息']) {
      expect(shouldStartFresh({ ...base, text })).toBe(false);
    }
    expect(shouldStartFresh({ ...base, text: '用同樣的資料再幫我整理成一份給主管看的簡報大綱' })).toBe(false);
  });

  it('the first message starts with the question and hides the pointer back', () => {
    const prompt = freshStartPrompt('s-old', 'x'.repeat(700), ' 新問題 ');
    expect(prompt.startsWith('新問題\n')).toBe(true);
    expect(prompt).toContain('舊對話 s-old');
    expect(prompt).toContain('…');
    expect(freshStartPrompt('s-old', '', '新問題')).not.toContain('上一則回覆摘錄');
    expect(stripFreshStartNote(prompt)).toBe('新問題');
    expect(stripFreshStartNote(prompt.replace(/\n/g, '\r\n'))).toBe('新問題');
    expect(stripFreshStartNote('一般訊息\n第二行')).toBe('一般訊息\n第二行');
  });

  it('binds the hand-over to the new conversation only', () => {
    clearFreshStart();
    markFreshStart('p1', 's-old', '新問題');
    bindFreshStart('p2', 's-new');
    bindFreshStart('p1', 's-old');
    expect(freshStartFor('s-new')).toBeNull();
    bindFreshStart('p1', 's-new');
    expect(freshStartFor('s-new')).toEqual({ fromSessionId: 's-old', text: '新問題' });
    expect(freshStartFor('s-other')).toBeNull();
  });

  it('still finds the way back after a reload (memory gone, storage kept)', () => {
    clearFreshStart();
    markFreshStart('p1', 's-old', '新問題');
    bindFreshStart('p1', 's-reload');
    clearFreshStart();
    expect(freshStartFor('s-reload')).toEqual({ fromSessionId: 's-old', text: '新問題' });
  });
});
