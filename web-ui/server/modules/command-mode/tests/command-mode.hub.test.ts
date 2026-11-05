import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CALLER_LINGER_MS,
  CommandModeHub,
  parseFrame,
  type CommandModeOutbound,
  type HubSocket,
} from '@/modules/command-mode/command-mode.hub.js';

const P = 'C:/demo/project-a';
const A = 'profile-a';
const B = 'profile-b';
const JPEG = 'data:image/jpeg;base64,/9j/AAAA';

function setup() {
  let clock = 1_000;
  const inbox = new Map<HubSocket, CommandModeOutbound[]>();
  const hub = new CommandModeHub({
    send: (socket, message) => { inbox.get(socket)?.push(message); },
    now: () => clock,
  });
  const socket = (): HubSocket => { const s = {}; inbox.set(s, []); return s; };
  const lastState = (s: HubSocket) => [...(inbox.get(s) ?? [])].reverse().find((m) => m.kind === 'command_mode_state');
  const frames = (s: HubSocket) => (inbox.get(s) ?? []).filter((m) => m.kind === 'command_frame');
  return { hub, socket, lastState, frames, tick: (ms: number) => { clock += ms; } };
}

const frame = (id: string) => ({ id, capturedAt: 1, width: 1280, height: 720, dataUrl: JPEG });

test('desktop sees the switch only while another connection in the same project is in a call', () => {
  const { hub, socket, lastState } = setup();
  const desk = socket();
  const phone = socket();
  hub.watch(desk, P, A);
  assert.equal(lastState(desk)?.kind === 'command_mode_state' && lastState(desk)?.phoneLive, false);
  hub.call(phone, 'C:/demo/other', true, A);
  assert.equal((lastState(desk) as { phoneLive: boolean }).phoneLive, false, 'a call in another project does not count');
  hub.call(phone, P, true, A);
  assert.equal((lastState(desk) as { phoneLive: boolean }).phoneLive, true);
  assert.equal((lastState(phone) as { phoneLive: boolean }).phoneLive, false, 'the caller itself is not offered the switch');
});

test('sharing is refused without a live phone, and frames reach only live callers', () => {
  const { hub, socket, lastState, frames } = setup();
  const desk = socket();
  const phone = socket();
  hub.watch(desk, P, A);
  hub.share(desk, P, true, A);
  assert.equal((lastState(desk) as { sharing: boolean }).sharing, false, 'desktop cannot enter on its own');
  assert.equal(hub.frame(desk, P, frame('f0'), A), false);

  hub.call(phone, P, true, A);
  hub.share(desk, P, true, A);
  assert.deepEqual(lastState(desk), { kind: 'command_mode_state', projectKey: P, phoneLive: true, sharing: true, youShare: true });
  assert.equal(hub.frame(desk, P, frame('f1'), A), true);
  assert.equal(frames(phone).length, 1);
  assert.equal(frames(desk).length, 0, 'the sharer does not get its own frames back');
  assert.equal(hub.latestFrame(P, A)?.id, 'f1', 'only the latest frame is kept');
  assert.equal(hub.frame(phone, P, frame('x'), A), false, 'only the sharer may post frames');
});

test('phone hang-up ends sharing and drops the frame at once', () => {
  const { hub, socket, lastState } = setup();
  const desk = socket();
  const phone = socket();
  hub.watch(desk, P, A);
  hub.call(phone, P, true, A);
  hub.share(desk, P, true, A);
  hub.frame(desk, P, frame('f1'), A);
  hub.call(phone, P, false, A);
  assert.deepEqual(lastState(desk), { kind: 'command_mode_state', projectKey: P, phoneLive: false, sharing: false, youShare: false });
  assert.equal(hub.latestFrame(P, A), null);
});

test('a phone whose socket drops keeps sharing alive for the linger window, then ends it', () => {
  const { hub, socket, lastState, frames, tick } = setup();
  const desk = socket();
  const phone = socket();
  hub.watch(desk, P, A);
  hub.call(phone, P, true, A);
  hub.share(desk, P, true, A);
  hub.drop(phone);
  tick(CALLER_LINGER_MS - 1);
  hub.sweep();
  assert.equal((lastState(desk) as { sharing: boolean }).sharing, true, 'still sharing inside the window');

  const back = socket();
  hub.frame(desk, P, frame('f2'), A);
  hub.call(back, P, true, A);
  assert.equal(frames(back).at(-1)?.kind === 'command_frame' && (frames(back).at(-1) as { frame: { id: string } }).frame.id, 'f2', 'a reconnecting phone gets the latest frame right away');
  tick(CALLER_LINGER_MS);
  hub.sweep();
  assert.equal((lastState(desk) as { sharing: boolean }).sharing, true, 'the reconnected phone keeps it alive');

  hub.drop(back);
  tick(CALLER_LINGER_MS + 1);
  hub.sweep();
  assert.deepEqual(lastState(desk), { kind: 'command_mode_state', projectKey: P, phoneLive: false, sharing: false, youShare: false });
});

test('the sharer closing its tab ends sharing for the phone', () => {
  const { hub, socket, lastState } = setup();
  const desk = socket();
  const phone = socket();
  hub.watch(desk, P, A);
  hub.call(phone, P, true, A);
  hub.share(desk, P, true, A);
  assert.equal((lastState(phone) as { sharing: boolean }).sharing, true);
  hub.drop(desk);
  assert.equal((lastState(phone) as { sharing: boolean }).sharing, false);
});

test('parseFrame accepts a JPEG data URL and rejects anything else', () => {
  assert.ok(parseFrame(frame('ok')));
  assert.equal(parseFrame({ ...frame('png'), dataUrl: 'data:image/png;base64,AAAA' }), null);
  assert.equal(parseFrame({ ...frame('big'), width: 9000 }), null);
  assert.equal(parseFrame({ ...frame('html'), dataUrl: 'data:image/jpeg;base64,<script>' }), null);
  assert.equal(parseFrame(null), null);
  const mark = { id: 'd1', shape: 'line', startedAt: 1, endedAt: 2 };
  assert.deepEqual(parseFrame({ ...frame('m'), marks: [mark] })?.marks, [mark], 'desktop laser marks ride along with the frame');
  assert.equal(parseFrame({ ...frame('m'), marks: [{ ...mark, shape: 'star' }] }), null);
});

test('another person in the same project gets no frame, no presence, and cannot be counted', () => {
  const { hub, socket, lastState, frames } = setup();
  const deskA = socket();
  const phoneA = socket();
  const phoneB = socket();
  const deskB = socket();
  const unpaired = socket();
  hub.watch(deskA, P, A);
  hub.watch(deskB, P, B);
  hub.call(phoneB, P, true, B);
  hub.call(unpaired, P, true, null);
  assert.equal((lastState(deskA) as { phoneLive: boolean }).phoneLive, false, 'a call by someone else is not presence');
  assert.equal((lastState(deskB) as { phoneLive: boolean }).phoneLive, true);

  hub.call(phoneA, P, true, A);
  hub.share(deskA, P, true, A);
  assert.equal(hub.frame(deskA, P, frame('f1'), A), true);
  assert.equal(frames(phoneA).length, 1);
  assert.equal(frames(phoneB).length, 0, 'a different profile gets no frame');
  assert.equal(frames(unpaired).length, 0, 'an unpaired connection gets no frame');
  assert.equal((lastState(deskB) as { sharing: boolean }).sharing, false);
  assert.equal(hub.frame(deskA, P, frame('f2'), B), false, 'a frame cannot be posted into another profile room');
});
