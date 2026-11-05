import { describe, expect, it } from 'vitest';
import { ASSISTANT_ID, LOBBY, dmRoom, recentContacts } from '@/shared/chatRoom';

const msg = (id: string, by: string, at: string) => ({ id, by, at, text: 'hi', refs: [] });

describe('recentContacts', () => {
  it('lists the two latest private chats, newest first, without 團隊小助理 or other rooms', () => {
    const state = {
      rooms: {
        [dmRoom('me', 'ann')]: [msg('1', 'ann', '2026-10-22T01:00:00Z')],
        [dmRoom('me', 'bob')]: [msg('2', 'me', '2026-10-22T03:00:00Z')],
        [dmRoom('me', 'cat')]: [msg('3', 'cat', '2026-10-22T02:00:00Z')],
        [dmRoom('me', ASSISTANT_ID)]: [msg('4', ASSISTANT_ID, '2026-10-22T09:00:00Z')],
        [dmRoom('ann', 'bob')]: [msg('5', 'ann', '2026-10-22T08:00:00Z')],
        [dmRoom('me', 'dan')]: [],
        [LOBBY]: [msg('6', 'dan', '2026-10-22T07:00:00Z')],
      },
      notes: [],
      seen: {},
    } as never;
    expect(recentContacts(state, 'me')).toEqual(['bob', 'cat']);
    expect(recentContacts(state, null)).toEqual([]);
  });
});
