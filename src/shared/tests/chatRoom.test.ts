import { describe, expect, it } from 'vitest';

import { applyBots, botFace, callsAssistant, dmPeer, mentionAt, dmRoom, keepMentioned, parseMessages, parseNotes, splitRefs, unreadDirect, unreadMentions } from '@/shared/chatRoom';
import type { ChatRef } from '@/shared/chatRoom';

const amy: ChatRef = { kind: 'person', id: 'amy', label: 'Amy' };
const session: ChatRef = { kind: 'session', id: 's1', label: '月報整理' };

describe('chat room refs', () => {
  it('splits @name and @@title into chips, the session first when both could match', () => {
    const parts = splitRefs('請 @Amy 看 @@月報整理 謝謝', [amy, session]);
    expect(parts).toEqual([{ text: '請 ' }, { ref: amy }, { text: ' 看 ' }, { ref: session }, { text: ' 謝謝' }]);
  });

  it('drops a ref whose @name was deleted from the text, and duplicates', () => {
    expect(keepMentioned('只剩 @@月報整理', [amy, session, session])).toEqual([session]);
  });

  it('pairs private rooms the same way from either side', () => {
    expect(dmRoom('bob', 'amy')).toBe(dmRoom('amy', 'bob'));
    expect(dmPeer(dmRoom('amy', 'bob'), 'amy')).toBe('bob');
    expect(dmPeer('lobby', 'amy')).toBeNull();
  });
});

describe('unread', () => {
  const rooms = {
    's:s1': parseMessages({ msgs: [{ id: 'm1', by: 'bob', text: '@Amy 看一下', at: '2026-10-16T02:00:00Z', refs: [amy] }] }),
    [dmRoom('amy', 'bob')]: parseMessages({ msgs: [{ id: 'm2', by: 'bob', text: 'hi', at: '2026-10-16T02:00:00Z', refs: [] }] }),
  };
  const notes = parseNotes({ items: [{ id: 'n1', target: { kind: 'board', id: 'b1', title: '流程' }, by: 'bob', text: '@Amy', refs: [amy], color: 'pink', w: 200, h: 120, at: '2026-10-16T03:00:00Z' }] });

  it('counts mentions of me by place (session room, board note) until I look', () => {
    const unread = unreadMentions({ rooms, notes, seen: {} }, 'amy');
    expect(unread.get('s:s1')).toBe(1);
    expect(unread.get('b:b1')).toBe(1);
    const after = unreadMentions({ rooms, notes, seen: { 's:s1': '2026-10-16T02:30:00Z' } }, 'amy');
    expect(after.has('s:s1')).toBe(false);
    expect(unreadMentions({ rooms, notes, seen: {} }, 'bob').size).toBe(0);
  });

  it('counts private messages from the other person only', () => {
    expect(unreadDirect({ rooms, notes, seen: {} }, 'amy').get(dmRoom('amy', 'bob'))).toBe(1);
    expect(unreadDirect({ rooms, notes, seen: {} }, 'bob').size).toBe(0);
  });

  it('keeps notes on sane sizes and known colours', () => {
    const [note] = parseNotes({ items: [{ id: 'x', target: { kind: 'session', id: 's', title: '' }, by: 'a', text: '', refs: [], color: 'neon', w: 10, h: 10, at: 'z' }] });
    expect(note.color).toBe('yellow');
    expect(note.w).toBeGreaterThanOrEqual(120);
    expect(note.h).toBeGreaterThanOrEqual(56);
  });
});

describe('chat files', () => {
  const base = { id: 'm1', by: 'amy', text: '', at: '2026-10-19T02:00:00Z' };
  it('keeps file references and drops damaged ones', () => {
    const [message] = parseMessages({
      msgs: [{
        ...base,
        files: [
          { name: '圖.png', stored: '1-圖.png', size: 12, type: 'image/png' },
          { name: 'x', stored: '../secret.txt', size: 1, type: 'text/plain' },
          { name: 'y', stored: 'a/b.txt', size: 1, type: 'text/plain' },
          { name: 'z', stored: '', size: 1, type: '' },
          'oops',
          null,
          { stored: 'only.bin', size: 'big' },
        ],
      }],
    });
    expect(message.files).toEqual([
      { name: '圖.png', stored: '1-圖.png', size: 12, type: 'image/png' },
      { name: 'only.bin', stored: 'only.bin', size: 0, type: '' },
    ]);
  });

  it('leaves files off when the field is missing or not a list', () => {
    expect(parseMessages({ msgs: [base] })[0].files).toBeUndefined();
    expect(parseMessages({ msgs: [{ ...base, files: 'nope' }] })[0].files).toBeUndefined();
    expect(parseMessages({ msgs: [{ ...base, files: [{ stored: '../x' }] }] })[0].files).toBeUndefined();
  });
});

describe('calling the assistant', () => {
  it('calls the assistant by its new name, the old one, or 小助理, and not by plain text', () => {
    for (const text of ['@團隊小助理 對帳', '@團隊小助手 對帳', '@小助理 對帳']) expect(callsAssistant('lobby', text, 'me')).toBe(true);
    expect(callsAssistant('lobby', '團隊小助理 對帳', 'me')).toBe(false);
    for (const text of ['@覆核 對一下', '請 @審查 看這段', '@值班 網站慢']) expect(callsAssistant('lobby', text, 'me')).toBe(true);
  });

  it('10/25: once the server lists the mentions, own bots call too and the fallback list is replaced', () => {
    applyBots({ enabled: true, mine: [], public: [], team: [{ id: 'r', name: '覆核員', mentions: ['@覆核'], prompt: 'x' }], mentions: ['@覆核', '@算帳', '@華仔', 7, 'nope'], faces: { 算帳仔: '算' }, myStyle: '短一點' });
    expect(callsAssistant('lobby', '@算帳 今天的差異', 'me')).toBe(true);
    expect(callsAssistant('lobby', '找 @華仔 借', 'me')).toBe(true);
    expect(callsAssistant('lobby', '@覆核 對一下', 'me')).toBe(true);
    expect(callsAssistant('lobby', '@值班 網站慢', 'me')).toBe(false);
    expect(callsAssistant('lobby', '@團隊小助理 嗨', 'me')).toBe(true);
    expect(callsAssistant('lobby', 'nope', 'me')).toBe(false);
    expect(botFace('【算帳仔】差異兩筆', { 算帳仔: '算' })).toBe('算');
    expect(botFace('【覆核員】對得上', { 算帳仔: '算' })).toBeNull();
    expect(botFace('先講結論', { 算帳仔: '算' })).toBeNull();
    // Switched off on the server: only the team roles are left.
    applyBots({ enabled: false, mentions: ['@覆核', '@審查', '@值班'] });
    expect(callsAssistant('lobby', '@算帳 今天的差異', 'me')).toBe(false);
    expect(callsAssistant('lobby', '@值班 網站慢', 'me')).toBe(true);
  });

  it('10/25: a mention calls unless an ASCII letter, digit or ._%+- is right before it (same rule as the server)', () => {
    // R4: right after Chinese also calls.
    expect(callsAssistant('lobby', '請@覆核', 'me')).toBe(true);
    expect(mentionAt('麻煩@算帳看一下', '@算帳')).toBe(2);
    for (const text of ['mail x@算帳', '1@算帳', 'a.b@算帳', 'a_@算帳', 'a%@算帳', 'a+@算帳', 'a-@算帳']) expect(mentionAt(text, '@算帳')).toBe(-1);
    expect(callsAssistant('lobby', 'mail x@覆核', 'me')).toBe(false);
    expect(mentionAt('寄到 x@算帳.com', '@算帳')).toBe(-1);
    expect(mentionAt('@@算帳', '@算帳')).toBe(-1);
    expect(mentionAt('x@算帳 和 @算帳', '@算帳')).toBe(7);
    for (const text of ['@算帳 嗨', '嗨 @算帳', '（@算帳）', '好，@算帳']) expect(mentionAt(text, '@算帳')).toBeGreaterThanOrEqual(0);
    expect(callsAssistant('lobby', '寄 ab@團隊小助理.tw', 'me')).toBe(false);
    expect(callsAssistant('lobby', '信箱 me@覆核.tw', 'me')).toBe(false);
    expect(callsAssistant('lobby', '好，@覆核 看一下', 'me')).toBe(true);
  });
});

describe('announcements', () => {
  const post = (id: string, by: string, text: string) => ({ id, by, text, at: '2026-10-21T07:00:00Z', refs: [] });
  it('@ALL in 動態 is an announcement, not from 團隊小助理 and not elsewhere', async () => {
    const { isAnnouncement, LOBBY, ASSISTANT_ID } = await import('@/shared/chatRoom');
    expect(isAnnouncement(LOBBY, post('a', 'amy', '@ALL 新功能上線'))).toBe(true);
    expect(isAnnouncement(LOBBY, post('b', 'amy', '請看@all'))).toBe(true);
    expect(isAnnouncement(LOBBY, post('c', 'amy', '@ALLEN 你好'))).toBe(false);
    expect(isAnnouncement(LOBBY, post('d', ASSISTANT_ID, '@ALL 報告'))).toBe(false);
    expect(isAnnouncement('dm:amy~bob', post('e', 'amy', '@ALL'))).toBe(false);
  });
  it('an announcement stays unread for others until 已讀, opening the room does not clear it', async () => {
    const { announcementKey, LOBBY } = await import('@/shared/chatRoom');
    const rooms = { [LOBBY]: [post('a', 'amy', '@ALL 新功能')] };
    expect(unreadMentions({ rooms, notes: [], seen: { [LOBBY]: '2099-01-01T00:00:00Z' } }, 'bob').get(LOBBY)).toBe(1);
    expect(unreadMentions({ rooms, notes: [], seen: {} }, 'amy').size).toBe(0);
    expect(unreadMentions({ rooms, notes: [], seen: { [announcementKey('a')]: '2026-10-21T08:00:00Z' } }, 'bob').size).toBe(0);
  });
});
