import assert from 'node:assert/strict';

import { test } from 'vitest';

import { VoiceActivityDetector, type VadEvent } from '@/modules/voice-call/engines/vad';

const FRAME = 43;

/** 依序餵 [音量, 毫秒] 片段，回傳每個事件與發生時間。 */
function feed(vad: VoiceActivityDetector, start: number, parts: Array<[number, number]>) {
  const events: Array<VadEvent & { t: number }> = [];
  let t = start;
  for (const [rms, ms] of parts) {
    const end = t + ms;
    for (; t < end; t += FRAME) {
      const e = vad.feed(rms, t);
      if (e) events.push({ ...e, t });
    }
  }
  return { events, t };
}

/** 喇叭外放的回音：一個字大聲一個字小聲，字間有停頓，偶爾有比較重的字。 */
function echo(ms: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i * 300 < ms; i++) out.push([i % 5 === 3 ? 0.09 : 0.06, 220], [0.015, 80]);
  return out;
}

test('the speaker\'s own echo never counts as the user, even though it is far above the normal listening threshold', () => {
  const vad = new VoiceActivityDetector('medium');
  vad.setMode('guard', 0);
  const { events } = feed(vad, 0, echo(6000));
  assert.equal(events.filter((e) => e.type === 'confirm').length, 0);
});

test('the user talking over the reply is confirmed as a barge-in within half a second', () => {
  const vad = new VoiceActivityDetector('medium');
  vad.setMode('guard', 0);
  const before = feed(vad, 0, echo(2000));
  const onset = before.t;
  const { events } = feed(vad, onset, [[0.25, 1000]]);
  const confirm = events.find((e) => e.type === 'confirm');
  assert.ok(confirm && confirm.type === 'confirm' && confirm.bargeIn, 'confirmed as barge-in');
  assert.ok(confirm.t - onset <= 500, `confirmed ${confirm.t - onset} ms after the user started`);
  assert.equal(vad.current, 'listen', 'the rest of the sentence is judged with the normal threshold');
});

test('a short knock or cough while the speaker plays is thrown away and raises the bar for the next one', () => {
  const vad = new VoiceActivityDetector('medium');
  vad.setMode('guard', 0);
  const warm = feed(vad, 0, echo(1000));
  const knock = feed(vad, warm.t, [[0.3, 130], [0.03, 300]]);
  assert.deepEqual(knock.events.map((e) => e.type), ['onset', 'discard']);
  const again = feed(vad, knock.t, [[0.3, 300]]);
  assert.equal(again.events.length, 0, 'the same loudness no longer opens a clip');
});

test('nothing is judged in the first moments of playback while the echo level is being learned', () => {
  const vad = new VoiceActivityDetector('medium');
  vad.setMode('guard', 0);
  const { events } = feed(vad, 0, [[0.2, 350], [0.2, 300]]);
  assert.equal(events.filter((e) => e.type === 'confirm').length, 0, 'a loud speaker start is learned as echo');
});

test('lower sensitivity needs a louder and longer voice than higher sensitivity', () => {
  const run = (s: 'low' | 'high') => {
    const vad = new VoiceActivityDetector(s);
    vad.setMode('guard', 0);
    const before = feed(vad, 0, echo(2000));
    return feed(vad, before.t, [[0.14, 400]]).events.some((e) => e.type === 'confirm');
  };
  assert.equal(run('high'), true);
  assert.equal(run('low'), false);
});

test('normal listening: 200 ms to confirm, a 1 s pause is not the end, 1.5 s of quiet is', () => {
  const vad = new VoiceActivityDetector('medium');
  const { events } = feed(vad, 0, [[0.002, 500], [0.05, 600], [0.002, 1000], [0.05, 300], [0.002, 1600]]);
  assert.deepEqual(events.map((e) => e.type), ['onset', 'confirm', 'end']);
  const confirm = events[1];
  assert.ok(confirm.type === 'confirm' && !confirm.bargeIn);
});
