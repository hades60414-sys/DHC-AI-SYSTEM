import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  initialCallState,
  OFFLINE_TEXT,
  phaseOf,
  SAY,
  step,
  type CallEffect,
  type CallEvent,
  type CallState,
} from '@/modules/voice-call/callMachine';

const CFG = { maxSpokenChars: 600, maxRetries: 2, maxCallMinutes: 30, idleEndMinutes: 5, bargeIn: true };
const T0 = 1_000_000;

/** Runs events in order; returns the final state and every effect produced. */
function run(events: CallEvent[], from: CallState = initialCallState()) {
  let state = from;
  const effects: CallEffect[] = [];
  for (const event of events) {
    const [next, out] = step(state, event, CFG);
    state = next;
    effects.push(...out);
  }
  return { state, effects };
}

const spoken = (effects: CallEffect[]) => effects.flatMap((e) => (e.type === 'speak' ? [e.text] : []));
const sends = (effects: CallEffect[]) => effects.flatMap((e) => (e.type === 'send' ? [e] : []));
const live = (sessionId: string | null = 's1') => run([{ type: 'START', at: T0, sessionId }, { type: 'READY' }]).state;
const say = (text: string, id = `t-${text}`, at = T0 + 1000): CallEvent => ({ type: 'STT_FINAL', text, at, id });
const sent = (id: string): CallEvent => ({ type: 'TURN_SENT', id, sessionId: 's1', at: T0 + 1100 });

test('a call starts listening only after the recognizer is ready', () => {
  const started = run([{ type: 'START', at: T0, sessionId: 's1' }]);
  assert.equal(phaseOf(started.state), 'starting');
  assert.deepEqual(started.effects, [{ type: 'stt', action: 'start' }]);
  assert.equal(phaseOf(live()), 'listening');
});

test('an utterance becomes a turn whose id is the clientRequestId, and is injected while a run is going', () => {
  const idle = run([say('查一下昨天的部位', 'req-1')], live());
  assert.deepEqual(sends(idle.effects).map((e) => [e.turn.id, e.turn.transcript, e.inject]), [['req-1', '查一下昨天的部位', false]]);
  assert.equal(phaseOf(idle.state), 'processing');

  const busy = run([{ type: 'RUN_STATE', active: true }, say('順便把 B 換成 ZZZ', 'req-2')], live());
  assert.deepEqual(sends(busy.effects).map((e) => e.inject), [true]);
});

test('a turn is marked done only by the run\'s real complete frame, never by what the model says', () => {
  const { state } = run([say('跑報表', 'r'), sent('r'), { type: 'RUN_TEXT', text: '好了，任務完成！', at: T0 + 2000 }], live());
  assert.equal(state.turns[0].status, 'running', 'model text does not complete the turn');
  assert.equal(phaseOf(state), 'working');

  const done = run([{ type: 'RUN_COMPLETE', success: true, aborted: false, at: T0 + 3000 }], state);
  assert.equal(done.state.turns[0].status, 'done');

  const failed = run([{ type: 'RUN_COMPLETE', success: false, aborted: false, at: T0 + 3000 }], state);
  assert.equal(failed.state.turns[0].status, 'failed');
  assert.deepEqual(spoken(failed.effects), [SAY.failed]);
});

test('a resent turn reported as duplicate keeps its original status and creates no new turn', () => {
  const { state } = run([say('跑報表', 'r'), sent('r'), { type: 'TURN_DUPLICATE', id: 'r' }], live());
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].status, 'running');
});

test('a turn the server refused is failed without waiting for a complete', () => {
  const { state, effects } = run([say('跑報表', 'r'), sent('r'), { type: 'TURN_REJECTED', message: '連線中斷，這句沒有送出。', at: T0 + 1200 }], live());
  assert.equal(state.turns[0].status, 'failed');
  assert.equal(state.turns[0].failure, '連線中斷，這句沒有送出。');
  assert.deepEqual(spoken(effects), [SAY.notSent]);
});

test('a permission prompt waits for the screen, is announced once, and voice cannot answer it', () => {
  const base = run([say('刪掉暫存檔', 'r'), sent('r')], live()).state;
  const asked = run([
    { type: 'PERMISSION_REQUEST', requestId: 'p1', toolName: 'Bash' },
    { type: 'PERMISSION_REQUEST', requestId: 'p1', toolName: 'Bash' },
    { type: 'PERMISSION_REQUEST', requestId: 'p2', toolName: 'Write' },
  ], base);
  assert.equal(phaseOf(asked.state), 'awaiting_confirm');
  assert.deepEqual(spoken(asked.effects), [SAY.permission]);

  const yes = run([say('好', 'y', T0 + 5000)], asked.state);
  assert.equal(yes.effects.some((e) => e.type === 'abort'), false);
  assert.equal(sends(yes.effects)[0]?.turn.transcript, '好', 'a spoken yes is a message to the agent, not an approval');

  const resolved = run([{ type: 'PERMISSION_DONE', requestId: 'p1' }, { type: 'PERMISSION_DONE', requestId: 'p2' }], asked.state);
  assert.equal(phaseOf(resolved.state), 'working');
});

test('while speaking, what the mic hears is ignored; something said before playback still counts', () => {
  const speaking = run([{ type: 'TTS_START', at: T0 + 2000 }], live());
  assert.equal(phaseOf(speaking.state), 'speaking');
  assert.deepEqual(speaking.effects, [{ type: 'stt', action: 'pause' }]);

  const echo = run([say('喇叭裡的回覆聲音', 'echo', T0 + 2500)], speaking.state);
  assert.equal(sends(echo.effects).length, 0);
  assert.equal(echo.state.ignoredWhileSpeaking, 1);

  const earlier = run([say('我剛剛說的話', 'early', T0 + 1500)], speaking.state);
  assert.equal(sends(earlier.effects).length, 1);
});

test('barge-in stops the audio and reopens the mic without touching the task', () => {
  const base = run([{ type: 'RUN_STATE', active: true }, { type: 'TTS_START', at: T0 + 2000 }], live()).state;
  const { state, effects } = run([{ type: 'BARGE_IN' }], base);
  assert.deepEqual(effects, [{ type: 'cancel_speech' }, { type: 'stt', action: 'resume' }]);
  assert.equal(phaseOf(state), 'working');
});

test('once the reply is audible the mic listens through it for a barge-in; with barge-in off it stays closed', () => {
  const audible = run([{ type: 'TTS_START', at: T0 + 2000 }, { type: 'TTS_AUDIBLE', at: T0 + 2300 }], live());
  assert.deepEqual(audible.effects, [{ type: 'stt', action: 'pause' }, { type: 'stt', action: 'guard' }]);

  let state = live();
  const effects: CallEffect[] = [];
  for (const event of [{ type: 'TTS_START', at: T0 + 2000 }, { type: 'TTS_AUDIBLE', at: T0 + 2300 }] as CallEvent[]) {
    const [next, out] = step(state, event, { ...CFG, bargeIn: false });
    state = next;
    effects.push(...out);
  }
  assert.deepEqual(effects, [{ type: 'stt', action: 'pause' }]);
});

test('the user talking over the reply stops it, the rest of that reply stays silent, and what they said goes to the running task', () => {
  const speaking = run([say('跑報表', 'r'), sent('r'), { type: 'RUN_STATE', active: true }, { type: 'RUN_DELTA', text: '報表分三部分。第一部分是', at: T0 + 2000 }, { type: 'TTS_START', at: T0 + 2100 }], live()).state;
  assert.equal(phaseOf(speaking), 'speaking');

  const cut = run([{ type: 'STT_BARGE_IN' }], speaking);
  assert.deepEqual(cut.effects, [{ type: 'cancel_speech' }, { type: 'stt', action: 'resume' }]);
  assert.equal(phaseOf(cut.state), 'working', 'the task keeps running');

  const more = run([{ type: 'RUN_DELTA', text: '部位，第二部分是損益。', at: T0 + 2600 }], cut.state);
  assert.deepEqual(spoken(more.effects), [], 'the interrupted reply is not picked up again');

  const said = run([{ type: 'STT_SPEECH_END' }, say('等一下，只要第一部分', 'b', T0 + 3000)], more.state);
  assert.deepEqual(sends(said.effects).map((e) => [e.turn.transcript, e.inject]), [['等一下，只要第一部分', true]]);

  const answer = run([{ type: 'RUN_DELTA', text: '好，只講第一部分。', at: T0 + 4000 }], said.state);
  assert.deepEqual(spoken(answer.effects), ['好，只講第一部分。'], 'the answer to the new sentence is spoken');
});

test('a barge-in confirmed just after playback ended changes nothing', () => {
  const quiet = live();
  const { state, effects } = run([{ type: 'STT_BARGE_IN' }], quiet);
  assert.equal(state, quiet);
  assert.deepEqual(effects, []);
});

test('「先別說了」 never cancels the task; 「取消剛剛的任務」 asks first and aborts only on yes', () => {
  const working = run([say('跑報表', 'r'), sent('r')], live()).state;

  const hush = run([say('先別說了', 'h')], working);
  assert.equal(hush.effects.some((e) => e.type === 'abort'), false);
  assert.equal(sends(hush.effects).length, 0);

  const ask = run([say('取消剛剛的任務', 'c')], working);
  assert.equal(ask.effects.some((e) => e.type === 'abort'), false);
  assert.deepEqual(spoken(ask.effects), [SAY.confirmCancel]);

  const no = run([say('不要', 'n')], ask.state);
  assert.equal(no.effects.some((e) => e.type === 'abort'), false);
  assert.deepEqual(spoken(no.effects), [SAY.keepGoing]);

  const yes = run([say('確定', 'y')], ask.state);
  assert.deepEqual(yes.effects.filter((e) => e.type === 'abort'), [{ type: 'abort' }]);
  assert.equal(yes.state.turns[0].status, 'running', 'still running until the abort is confirmed');

  const ended = run([{ type: 'RUN_COMPLETE', success: false, aborted: true, at: T0 + 9000 }], yes.state);
  assert.equal(ended.state.turns[0].status, 'aborted');
  assert.deepEqual(spoken(ended.effects), [SAY.cancelled]);
});

test('cancelling with nothing running says so; a bare 「算了」 during a run asks which was meant', () => {
  assert.deepEqual(spoken(run([say('取消任務')], live()).effects), [SAY.noRun]);
  const running = run([{ type: 'RUN_STATE', active: true }], live()).state;
  const ambiguous = run([say('算了')], running);
  assert.deepEqual(spoken(ambiguous.effects), [SAY.askStopOrCancel]);
  const pick = run([say('取消任務')], ambiguous.state);
  assert.deepEqual(spoken(pick.effects), [SAY.confirmCancel]);
});

test('a quota failure is spoken and shown, and the text path is named as still usable', () => {
  const base = run([say('跑報表', 'r'), sent('r'), { type: 'RUN_ERROR_TEXT', text: 'Claude AI usage limit reached' }], live()).state;
  const { state, effects } = run([{ type: 'RUN_COMPLETE', success: false, aborted: false, at: T0 + 3000 }], base);
  assert.deepEqual(spoken(effects), [SAY.quota]);
  assert.equal(state.notice?.text, SAY.quota);
  assert.equal(state.turns[0].failure, SAY.quota);
});

test('streamed replies are spoken sentence by sentence and the repeated final block is not read twice', () => {
  const base = run([say('問', 'r'), sent('r')], live()).state;
  const { effects } = run([
    { type: 'RUN_DELTA', text: '結論是正常。', at: T0 + 1500 },
    { type: 'RUN_DELTA', text: '細節在畫面上', at: T0 + 1600 },
    { type: 'RUN_STREAM_END' },
    { type: 'RUN_TEXT', text: '結論是正常。細節在畫面上', at: T0 + 1700 },
  ], base);
  assert.deepEqual(spoken(effects), ['結論是正常。', '細節在畫面上']);
});

test('the latency from end of speech to first audio is recorded when sound starts, not when it is queued', () => {
  const queued = run([say('問', 'r', T0 + 1000), sent('r'), { type: 'RUN_DELTA', text: '好。', at: T0 + 2500 }, { type: 'TTS_START', at: T0 + 2600 }], live()).state;
  assert.equal(queued.turns[0].firstAudioAt, undefined);
  const { state } = run([{ type: 'TTS_AUDIBLE', at: T0 + 3100 }], queued);
  assert.equal(state.turns[0].firstTextAt! - state.turns[0].speechEndAt, 1500);
  assert.equal(state.turns[0].firstAudioAt! - state.turns[0].speechEndAt, 2100);
});

test('transient recognition errors retry up to the limit, then the call stops with the reason', () => {
  const err: CallEvent = { type: 'STT_ERROR', message: '本機辨識逾時', transient: true };
  const twice = run([err, err], live());
  assert.equal(twice.state.lifecycle, 'live');
  assert.deepEqual(twice.effects, [{ type: 'stt', action: 'restart' }, { type: 'stt', action: 'restart' }]);
  const third = run([err], twice.state);
  assert.equal(phaseOf(third.state), 'error');
  assert.equal(third.state.notice?.text, '本機辨識逾時');
});

test('a denied microphone ends the call with instructions to re-enable it', () => {
  const { state, effects } = run([{ type: 'START', at: T0, sessionId: 's1' }, { type: 'START_FAILED', code: 'mic_denied' }]);
  assert.equal(phaseOf(state), 'error');
  assert.match(state.notice!.text, /麥克風權限被拒絕/);
  assert.match(state.notice!.text, /文字輸入不受影響/);
  assert.ok(effects.some((e) => e.type === 'stt' && e.action === 'stop'));
});

test('going offline stops the call and points to the text path', () => {
  const { state } = run([{ type: 'NETWORK', online: false }], live());
  assert.equal(phaseOf(state), 'error');
  assert.equal(state.notice?.text, OFFLINE_TEXT);
});

test('the call ends itself at the duration cap and after idling, but not while a task runs', () => {
  const capped = run([{ type: 'TICK', now: T0 + 30 * 60_000 }], live());
  assert.deepEqual(capped.effects.filter((e) => e.type !== 'stt'), [{ type: 'speak', text: SAY.durationLimit }, { type: 'end', afterSpeech: true }]);

  const idle = run([{ type: 'TICK', now: T0 + 5 * 60_000 }], live());
  assert.ok(idle.effects.some((e) => e.type === 'end'));

  const busy = run([{ type: 'RUN_STATE', active: true }, { type: 'TICK', now: T0 + 5 * 60_000 }], live());
  assert.equal(busy.effects.length, 0);
});

test('muting ignores speech until unmuted', () => {
  const muted = run([{ type: 'MUTE_TOGGLE' }], live());
  assert.deepEqual(muted.effects, [{ type: 'stt', action: 'pause' }]);
  assert.equal(sends(run([say('聽得到嗎')], muted.state).effects).length, 0);
  const unmuted = run([{ type: 'MUTE_TOGGLE' }, say('聽得到嗎')], muted.state);
  assert.equal(sends(unmuted.effects).length, 1);
});
