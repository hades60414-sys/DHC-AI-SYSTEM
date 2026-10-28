import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundWorkTracker } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Event shapes as CLI 2.1.280 / SDK 0.3.266 emitted them in a probe on 2026-10-01: a background agent and a
// background shell launched in one turn, the turn's `result`, the shell reporting back, and the follow-up
// turn the CLI then starts on its own.
const changed = (tasks: Array<Record<string, unknown>>) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
const init = { type: 'system', subtype: 'init' };
const result = { type: 'result', subtype: 'success', is_error: false };
const reply = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } };
const AGENT = { task_id: 'a66229e9c857f16ef', task_type: 'local_agent', description: 'bg probe' };
const SHELL = { task_id: 'b8o51wm7h', task_type: 'local_bash', description: 'sleep 12' };

test('background work stays lit past the turn result until the follow-up turn ends', () => {
  let clock = 1_000;
  const tracker = createBackgroundWorkTracker(() => clock);

  assert.equal(tracker.observe(init, false), false);
  assert.equal(tracker.observe(changed([AGENT]), false), true);
  assert.deepEqual(tracker.snapshot(), {
    tasks: [{ type: 'local_agent', description: 'bg probe' }],
    followUp: false,
    since: 1_000,
  });

  clock = 2_000;
  assert.equal(tracker.observe(changed([]), false), true, 'the agent finished inside the turn');
  assert.equal(tracker.snapshot(), null);
  assert.equal(tracker.observe(changed([SHELL]), false), true);
  assert.equal(tracker.snapshot()?.since, 2_000);

  assert.equal(tracker.observe(reply, false), false, 'main-turn replies are not after-turn work');
  assert.equal(tracker.observe(result, true), false, 'the turn ends with the shell still running');
  assert.deepEqual(tracker.snapshot()?.tasks, [{ type: 'local_bash', description: 'sleep 12' }]);

  clock = 12_000;
  assert.equal(tracker.observe(changed([]), true), true, 'the shell reported back');
  assert.equal(tracker.observe(init, true), true, 'the CLI starts the follow-up turn');
  assert.deepEqual(tracker.snapshot(), { tasks: [], followUp: true, since: 12_000 });
  assert.equal(tracker.observe(reply, true), false);
  assert.equal(tracker.observe(result, true), true);
  assert.equal(tracker.snapshot(), null);
});

test('a turn that starts no background work never reports anything', () => {
  const tracker = createBackgroundWorkTracker();
  for (const message of [init, reply, result]) {
    assert.equal(tracker.observe(message, message === result), false);
  }
  assert.equal(tracker.snapshot(), null);
});

test('ambient tasks are housekeeping, not activity', () => {
  const tracker = createBackgroundWorkTracker();
  assert.equal(tracker.observe(changed([{ ...SHELL, ambient: true }]), true), false);
  assert.equal(tracker.snapshot(), null);
});

test('subagent traffic after the turn is not mistaken for a follow-up turn', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.observe(changed([AGENT]), false);
  tracker.observe(result, true);
  assert.equal(tracker.observe({ ...reply, parent_tool_use_id: 'toolu_01' }, true), false);
  assert.equal(tracker.snapshot()?.followUp, false);
});
