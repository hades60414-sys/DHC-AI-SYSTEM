import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

/**
 * DHC CLI co work (10/12): sharing sends each new member an invitation with an optional message; opening the
 * session or leaving removes it; the last member out ends the sharing.
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('new members get the invitation with the message; existing ones only when there is a message', async () => {
  await co.setCoSessionMembers('s1', SESSION, ['amy'], { from: 'owner', message: '  幫我看第 3 點  ' });
  assert.equal(co.readCoSession('s1')?.invites?.amy?.message, '幫我看第 3 點');
  assert.equal(co.readCoSession('s1')?.invites?.amy?.from, 'owner');

  co.dismissCoInvite('s1', 'amy');
  await settle();
  await co.setCoSessionMembers('s1', SESSION, ['amy', 'bob'], { from: 'owner', message: '' });
  const record = co.readCoSession('s1');
  assert.equal(record?.invites?.amy, undefined, 'amy already opened it and no new message was sent');
  assert.equal(record?.invites?.bob?.message, '', 'bob is new, so he is invited even without a message');

  assert.deepEqual(co.readCoInvites('bob').map((entry) => entry.sessionId), ['s1']);
  assert.deepEqual(co.readCoInvites('amy'), []);
  assert.equal(co.readCoInvites('bob'), co.readCoInvites('bob'), 'same array while nothing changes');
});

test('dismissing removes only that member\'s invitation and survives a reload', async () => {
  co.dismissCoInvite('s1', 'bob');
  await settle();
  await settle();
  await co.loadCoSessions();
  assert.equal(co.readCoSession('s1')?.invites, undefined);
  assert.deepEqual(co.readCoSession('s1')?.members, ['amy', 'bob']);
});

test('leaving drops the member and the last one out ends the sharing', async () => {
  await co.setCoSessionMembers('s2', SESSION, ['amy', 'bob'], { from: 'amy', message: 'hi' });
  await co.leaveCoSession('s2', 'amy');
  assert.deepEqual(co.readCoSession('s2')?.members, ['bob']);
  assert.equal(co.readCoSession('s2')?.invites?.amy, undefined);
  assert.equal(co.readCoSession('s2')?.invites?.bob?.message, 'hi');

  await co.leaveCoSession('s2', 'bob');
  assert.equal(co.readCoSession('s2'), null);
});

test('invites of people who are not members are dropped when parsing', () => {
  const parsed = co.parseCoSessions({
    s: { ownerProjectId: 'o', members: ['a'], invites: { a: { from: 'o', message: 'x', at: '1' }, z: { from: 'o' } } },
  });
  assert.deepEqual(Object.keys(parsed.s.invites ?? {}), ['a']);
});

test('靜音模式 is per person, survives a reload and a re-share, keeps the invitation, and goes when they leave', async () => {
  await co.setCoSessionMembers('s3', SESSION, ['amy', 'bob'], { from: 'owner', message: '看一下' });
  co.setCoMuted('s3', 'amy', true);
  co.setCoMuted('s3', 'owner', true);
  await settle();
  await settle();
  await co.loadCoSessions();
  assert.equal(co.isCoMuted('s3', 'amy'), true, 'muted after a reload');
  assert.equal(co.isCoMuted('s3', 'owner'), true, 'the owner can mute too');
  assert.equal(co.isCoMuted('s3', 'bob'), false, 'only for the person who muted');
  assert.equal(co.readCoSession('s3')?.invites?.amy?.message, '看一下', 'the invitation stays while muted');

  await co.setCoSessionMembers('s3', SESSION, ['amy', 'bob'], { from: 'owner', message: '有新進度' });
  assert.equal(co.isCoMuted('s3', 'amy'), true, 'a new message does not unmute');

  co.setCoMuted('s3', 'amy', false);
  await settle();
  assert.equal(co.isCoMuted('s3', 'amy'), false);

  co.setCoMuted('s3', 'bob', true);
  await settle();
  await co.leaveCoSession('s3', 'bob');
  assert.deepEqual(co.readCoSession('s3')?.muted, ['owner'], 'leaving drops the person from the muted list');
});

test('renaming a shared session saves the new name for everyone; an unshared one is left alone', async () => {
  await co.setCoSessionMembers('s5', SESSION, ['amy'], { from: 'owner', message: '' });
  co.renameCoSession('s5', '資料庫重建任務');
  co.renameCoSession('not-shared', 'x');
  await settle();
  await settle();
  await co.loadCoSessions();
  assert.equal(co.readCoSession('s5')?.title, '資料庫重建任務', 'another page reloading gets the new name');
  assert.deepEqual(co.readCoSession('s5')?.members, ['amy'], 'nothing else changed');
  assert.equal(co.readCoSession('not-shared'), null);
});

test('the Co-Work log keeps every share message and who left, even after the sharing ends', async () => {
  await co.setCoSessionMembers('s4', SESSION, ['amy', 'bob'], { from: 'owner', message: '請看第 3 點' });
  co.dismissCoInvite('s4', 'amy');
  await co.setCoSessionMembers('s4', SESSION, ['amy', 'bob', 'cat'], { from: 'owner', message: '' });
  await co.leaveCoSession('s4', 'amy');
  await co.leaveCoSession('s4', 'bob');
  await co.leaveCoSession('s4', 'cat');
  await settle();
  await co.loadCoSessions();

  assert.equal(co.readCoSession('s4'), null, 'the sharing ended');
  const log = co.readCoLog('s4').map(({ kind, from, to, message }) => ({ kind, from, to, message }));
  assert.deepEqual(log, [
    { kind: 'share', from: 'owner', to: ['amy', 'bob'], message: '請看第 3 點' },
    { kind: 'share', from: 'owner', to: ['cat'], message: '' },
    { kind: 'leave', from: 'amy', to: [], message: '' },
    { kind: 'leave', from: 'bob', to: [], message: '' },
    { kind: 'leave', from: 'cat', to: [], message: '' },
  ]);
  assert.ok(server['dhc.coLog'], 'saved on the server');
});
