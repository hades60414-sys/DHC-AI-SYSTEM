import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * DHC CLI Co-workspace: a shared session is one record under the global key `dhc.coSessions`. These tests hold
 * the store to what the sidebar and the chat rely on: who a session is shared with, merging with a share made
 * on another device, who each person is, and the speaker mark on a shared session's messages.
 */

const server: Record<string, unknown> = {};

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: structuredClone(server) }) }),
      savePreferences: async (updates: Record<string, unknown>) => {
        Object.assign(server, structuredClone(updates));
        return { ok: true, json: async () => ({ success: true }) };
      },
    },
  },
}));

const co = await import('@/shared/coSessions');

const SESSION = { ownerProjectId: 'owner', title: '月報', provider: 'claude' as const };
const stored = () => server['dhc.coSessions'] as Record<string, { members: string[]; ownerProjectId: string }>;

test('sharing lists the session for each member, and an empty pick stops sharing', async () => {
  await co.setCoSessionMembers('s1', SESSION, ['amy', 'bob', 'owner', 'amy']);

  assert.deepEqual(stored().s1.members, ['amy', 'bob'], 'the owner and repeats are not members');
  assert.deepEqual(co.readCoSession('s1')?.members, ['amy', 'bob']);

  await co.setCoSessionMembers('s1', SESSION, []);

  assert.equal(stored().s1, undefined);
  assert.equal(co.readCoSession('s1'), null);
});

test('a share made here keeps the one another device made in the meantime', async () => {
  await co.loadCoSessions();
  // Another device shares s9 after this tab loaded.
  server['dhc.coSessions'] = { s9: { ...SESSION, members: ['bob'], sharedAt: '2026-10-08T01:00:00.000Z' } };

  await co.setCoSessionMembers('s2', SESSION, ['amy']);

  assert.deepEqual(Object.keys(stored()).sort(), ['s2', 's9']);
  assert.deepEqual(co.readCoSession('s9')?.members, ['bob'], 'and it shows up here once the save lands');
});

test('changing the members keeps when the session was first shared', async () => {
  server['dhc.coSessions'] = { s3: { ...SESSION, members: ['amy'], sharedAt: '2026-10-01T00:00:00.000Z' } };
  await co.loadCoSessions();

  await co.setCoSessionMembers('s3', SESSION, ['bob']);

  assert.equal(co.readCoSession('s3')?.sharedAt, '2026-10-01T00:00:00.000Z');
});

test('a deleted session is no longer shared', async () => {
  server['dhc.coSessions'] = { s4: { ...SESSION, members: ['amy'], sharedAt: '' } };
  await co.loadCoSessions();

  co.forgetCoSession('s4');

  await vi.waitFor(() => assert.equal(stored().s4, undefined));
});

test('a record without members or without an owner is dropped when read', () => {
  const parsed = co.parseCoSessions({
    ok: { ...SESSION, members: ['amy'], sharedAt: '' },
    nobody: { ...SESSION, members: [] },
    onlyOwner: { ...SESSION, members: ['owner'] },
    broken: { members: ['amy'] },
  });

  assert.deepEqual(Object.keys(parsed), ['ok']);
});

test('a person is the profile linked to their project: its name and its avatar', () => {
  const people = co.parseCoPeople({
    'dhc.profiles': [
      { id: 'pa', name: 'Amy', projectId: 'amy' },
      { id: 'pb', name: 'Bob', projectId: 'bob' },
      { id: 'px', name: '共用機' },
    ],
    'p:pa:userAvatar': 'fox',
    'p:pb:userAvatar': '',
  });

  assert.deepEqual(people.get('amy'), { name: 'Amy', avatarId: 'fox' });
  assert.deepEqual(people.get('bob'), { name: 'Bob', avatarId: null });
  assert.equal(people.size, 2, 'a profile without a project is nobody');
});

test('a person without a linked profile still has their project name', async () => {
  server['dhc.profiles'] = [{ id: 'pa', name: 'Amy', projectId: 'amy' }];
  server['p:pa:userAvatar'] = 'fox';
  await co.loadCoSessions();

  co.setCoProjectNames([{ projectId: 'amy', displayName: 'amy-folder' }, { projectId: 'bob', displayName: 'Bob 的資料夾' }]);

  const people = renderHook(() => co.useCoPeople()).result.current;
  assert.deepEqual(people.get('amy'), { name: 'Amy', avatarId: 'fox' }, 'the profile wins over the folder name');
  assert.deepEqual(people.get('bob'), { name: 'Bob 的資料夾', avatarId: null });
});

test('the speaker mark is added once and split back off', () => {
  const marked = co.withSenderPrefix('幫我看這張表', 'Amy');

  assert.equal(marked, '【Amy】幫我看這張表');
  assert.equal(co.withSenderPrefix(marked, 'Bob'), marked, 'an already marked message is left alone');
  assert.equal(co.withSenderPrefix('沒有名字', '  '), '沒有名字');
  assert.deepEqual(co.parseSenderPrefix(marked), { name: 'Amy', body: '幫我看這張表' });
  assert.equal(co.parseSenderPrefix('一般訊息'), null);
});

test('a marked message belongs to that participant; an unmarked one to the owner', () => {
  const session = { ...SESSION, members: ['amy'], sharedAt: '' };
  const people = new Map([
    ['owner', { name: 'Olive', avatarId: 'owl' }],
    ['amy', { name: 'Amy', avatarId: 'fox' }],
  ]);

  assert.deepEqual(co.resolveCoSender(session, people, '【Amy】好'), { person: { name: 'Amy', avatarId: 'fox' }, body: '好' });
  assert.deepEqual(co.resolveCoSender(session, people, '分享前寫的'), { person: { name: 'Olive', avatarId: 'owl' }, body: '分享前寫的' });
  assert.deepEqual(
    co.resolveCoSender(session, people, '【路人】嗨'),
    { person: { name: '路人', avatarId: null }, body: '嗨' },
    'someone who is not a participant keeps the name they wrote, without a face',
  );
});
