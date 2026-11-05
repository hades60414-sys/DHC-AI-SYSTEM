import { describe, expect, it } from 'vitest';
import { ASSISTANT_ID, LOBBY, dmRoom, unreadLights } from '@/shared/chatRoom';

const msg = (id: string, by: string, at: string, text = 'hi', refs: Array<{ kind: 'person'; id: string; label: string }> = []) => ({ id, by, at, text, refs });

describe('unreadLights', () => {
  it('splits 私訊, 小助理, 公告 and keeps the oldest unread time', () => {
    const state = {
      rooms: {
        [dmRoom('me', 'ann')]: [msg('1', 'ann', '2026-10-22T03:00:00Z'), msg('2', 'ann', '2026-10-22T04:00:00Z')],
        [dmRoom('me', ASSISTANT_ID)]: [msg('3', ASSISTANT_ID, '2026-10-22T01:00:00Z')],
        [LOBBY]: [msg('4', 'ann', '2026-10-22T02:00:00Z', '@ALL 下午停機'), msg('5', 'ann', '2026-10-22T05:00:00Z', 'hey @me', [{ kind: 'person', id: 'me', label: 'me' }])],
      },
      notes: [],
      seen: {},
    } as never;
    expect(unreadLights(state, 'me')).toEqual({
      direct: { count: 3, since: '2026-10-22T03:00:00Z' },
      assistant: { count: 1, since: '2026-10-22T01:00:00Z' },
      notice: { count: 1, since: '2026-10-22T02:00:00Z' },
    });
  });

  it('goes dark once seen, and the announcement only after 已讀', () => {
    const state = {
      rooms: {
        [dmRoom('me', ASSISTANT_ID)]: [msg('3', ASSISTANT_ID, '2026-10-22T01:00:00Z')],
        [LOBBY]: [msg('4', 'ann', '2026-10-22T02:00:00Z', '@ALL 下午停機')],
      },
      notes: [],
      seen: { [dmRoom('me', ASSISTANT_ID)]: '2026-10-22T09:00:00Z', [LOBBY]: '2026-10-22T09:00:00Z' },
    } as never;
    expect(unreadLights(state, 'me')).toEqual({ notice: { count: 1, since: '2026-10-22T02:00:00Z' } });
  });
});
