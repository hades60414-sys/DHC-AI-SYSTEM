import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, nightQueueDb, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  MAX_ATTEMPTS,
  QUESTION_WAIT_RUN_NOW_MS,
  QUESTION_WAIT_UNATTENDED_MS,
  RESUME_NOTE,
  UNATTENDED_NOTE,
  UNATTENDED_SYSTEM_NOTE,
  answerStalledQuestions,
  buildRunInput,
  clearNightQueueBackoff,
  dispatchNightQueue,
  isNightWindow,
} from '@/modules/night-queue/services/night-queue-dispatcher.service.js';
import { nightQueueService, readModeSettings } from '@/modules/night-queue/services/night-queue.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const SESSION_A = 'night-session-a';
const SESSION_B = 'night-session-b';

/** Local wall-clock times on one day, the way the window reads them. */
const at = (hour: number, minute = 0) => new Date(2026, 8, 25, hour, minute, 0);

/** Lets the provider run reach `runtime.run` (it is called a few microtasks after the dispatch starts). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A run that stays in progress until the test opens the gate. */
function createGate(): { wait: () => Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { wait: () => gate, open };
}

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'night-queue-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  clearNightQueueBackoff();

  try {
    const user = userDb.createUser('night', 'hash');
    sessionsDb.createAppSession(SESSION_A, 'claude', tempDirectory, 'Night A');
    sessionsDb.createAppSession(SESSION_B, 'claude', tempDirectory, 'Night B');
    await runTest(Number(user.id));
  } finally {
    chatRunRegistry.clearAll();
    clearNightQueueBackoff();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { command: string; sessionId: unknown; options: Record<string, unknown> };
type Writer = { send: (message: unknown) => void };

function createRuntime(
  runs: RunCall[],
  overrides: {
    run?: (command: string, writer: Writer) => Promise<void>;
    pending?: unknown[];
    resolved?: Array<{ requestId: string; decision: { allow?: boolean; message?: string } }>;
  } = {},
) {
  return {
    hasRuntime: () => true,
    run: async (_provider: string, command: string, options: Record<string, unknown>, writer: Writer) => {
      runs.push({ command, sessionId: options.sessionId, options });
      await overrides.run?.(command, writer);
      // Like the real Claude runtime, a finished turn ends with `complete` exit 0. When the override already
      // ended the run (an error, a stop), the registry drops this second one — the first `complete` wins.
      writer.send(createCompleteMessage({ provider: 'claude', sessionId: null, exitCode: 0 }));
    },
    abort: async () => true,
    getPendingApprovalsForSession: () => overrides.pending ?? [],
    resolveToolApproval: (requestId: string, decision: { allow?: boolean; message?: string }) => {
      overrides.resolved?.push({ requestId, decision });
    },
  } as never;
}

/** What the Claude runtime emits when the turn's result is an error (usage limit, API error). */
function failLikeUsageLimit(writer: Writer): void {
  writer.send(createNormalizedMessage({
    kind: 'text',
    role: 'assistant',
    content: 'Claude AI usage limit reached',
    sessionId: null,
    provider: 'claude',
  }));
  writer.send(createCompleteMessage({ provider: 'claude', sessionId: null, exitCode: 1 }));
}

function items(sessionId: string) {
  return nightQueueService.getState(sessionId).items;
}

function statuses(sessionId: string): string[] {
  return items(sessionId).map((item) => item.status);
}

test('the window is 02:00 up to (not including) 07:00, local time', () => {
  assert.equal(isNightWindow(at(1, 59)), false);
  assert.equal(isNightWindow(at(2, 0)), true);
  assert.equal(isNightWindow(at(6, 59)), true);
  assert.equal(isNightWindow(at(7, 0)), false);
  assert.equal(isNightWindow(at(14, 0)), false);
});

test('storing a prompt turns night mode on and nothing runs before 02:00', async () => {
  await withIsolatedDatabase(async (userId) => {
    const state = nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'refactor the loader' });
    assert.equal(state.enabled, true);
    assert.deepEqual(state.items.map((item) => [item.content, item.status, item.position]), [
      ['refactor the loader', 'pending', 1],
    ]);

    const runs: RunCall[] = [];
    assert.equal(await dispatchNightQueue(createRuntime(runs), at(23, 30)), false);
    assert.equal(await dispatchNightQueue(createRuntime(runs), at(1, 59)), false);
    assert.equal(runs.length, 0);
    assert.deepEqual(statuses(SESSION_A), ['pending']);
  });
});

test('inside the window items run one at a time in the order they were stored, across sessions', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'A1' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'B1' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'A2' });

    // Positions are global: the queue is one lane for every session.
    assert.deepEqual(items(SESSION_A).map((item) => item.position), [1, 3]);
    assert.deepEqual(items(SESSION_B).map((item) => item.position), [2]);

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    while (await dispatchNightQueue(runtime, at(2, 0))) {
      // each pass runs exactly one item to the end
    }

    assert.deepEqual(runs.map((run) => [run.command, run.sessionId]), [
      ['A1', SESSION_A],
      ['B1', SESSION_B],
      ['A2', SESSION_A],
    ]);
    assert.deepEqual(statuses(SESSION_A), []);
    assert.deepEqual(statuses(SESSION_B), []);
  });
});

test('a pass while an item is still running starts nothing else', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'long job' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'next job' });

    const gate = createGate();
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, { run: gate.wait });

    const first = dispatchNightQueue(runtime, at(3, 0));
    assert.equal(await dispatchNightQueue(runtime, at(3, 1)), false);
    await flush();
    assert.deepEqual(runs.map((run) => run.command), ['long job']);
    assert.deepEqual(statuses(SESSION_A), ['running']);

    gate.open();
    assert.equal(await first, true);
    assert.deepEqual(statuses(SESSION_A), []);
  });
});

test('from 07:00 nothing new starts; what is left waits for the next night', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'too late tonight' });

    const runs: RunCall[] = [];
    assert.equal(await dispatchNightQueue(createRuntime(runs), at(7, 0)), false);
    assert.deepEqual(statuses(SESSION_A), ['pending']);

    assert.equal(await dispatchNightQueue(createRuntime(runs), at(2, 5)), true);
    assert.deepEqual(runs.map((run) => run.command), ['too late tonight']);
  });
});

test('run now: that session goes first, at any hour, and night mode turns off', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'A waits for the night' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'B1' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'B2' });

    const state = nightQueueService.runNow(SESSION_B);
    assert.equal(state.enabled, false);
    assert.deepEqual(state.items.map((item) => [item.content, item.runNow, item.position]), [
      ['B1', true, 1],
      ['B2', true, 2],
    ]);

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    while (await dispatchNightQueue(runtime, at(14, 0))) {
      // drain what is allowed at 14:00
    }
    assert.deepEqual(runs.map((run) => run.command), ['B1', 'B2']);
    assert.deepEqual(statuses(SESSION_A), ['pending']);
  });
});

test('a busy session is skipped without its items losing their order', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'A1' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'B1' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'A2' });

    // Someone is chatting in A at 03:00.
    chatRunRegistry.startRun({
      appSessionId: SESSION_A,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    assert.equal(await dispatchNightQueue(runtime, at(3, 0)), true);
    assert.equal(await dispatchNightQueue(runtime, at(3, 1)), false);
    assert.deepEqual(runs.map((run) => run.command), ['B1']);

    chatRunRegistry.completeRun(SESSION_A, { exitCode: 0 });
    while (await dispatchNightQueue(runtime, at(3, 2))) {
      // A is free again
    }
    assert.deepEqual(runs.map((run) => run.command), ['B1', 'A1', 'A2']);
  });
});

test('a turn that ends in an error goes back to waiting, pauses the queue, and fails after three tries', async (t) => {
  // The pause starts from the later of the dispatch time and the wall clock; pin the wall clock to the
  // simulated night so the test does not depend on today's date.
  t.mock.method(Date, 'now', () => at(3, 0).getTime());
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'hits the limit' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'fine later' });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, {
      run: async (command, writer) => {
        if (command.endsWith('hits the limit')) failLikeUsageLimit(writer);
      },
    });

    // 03:00 fails: back to waiting with the reason, and nothing else starts for 15 minutes.
    assert.equal(await dispatchNightQueue(runtime, at(3, 0)), true);
    const [waiting] = items(SESSION_A);
    assert.equal(waiting.status, 'pending');
    assert.equal(waiting.failureReason, 'Claude AI usage limit reached');
    assert.equal(await dispatchNightQueue(runtime, at(3, 10)), false, 'paused after a failure');
    assert.deepEqual(runs.map((run) => run.command), ['hits the limit']);

    // Second and third tries, each after the pause, carry the resume note.
    assert.equal(await dispatchNightQueue(runtime, at(3, 16)), true);
    assert.equal(await dispatchNightQueue(runtime, at(3, 32)), true);
    assert.equal(runs[1].command, `${RESUME_NOTE}\n\nhits the limit`);
    const [failed] = items(SESSION_A);
    assert.equal(failed.status, 'failed');
    assert.match(failed.failureReason ?? '', new RegExp(`試了 ${MAX_ATTEMPTS} 次都沒有完成：Claude AI usage limit reached`));

    // The rest of the queue carries on once the pause is over.
    assert.equal(await dispatchNightQueue(runtime, at(3, 40)), false);
    assert.equal(await dispatchNightQueue(runtime, at(3, 48)), true);
    assert.deepEqual(runs.map((run) => run.command).slice(-1), ['fine later']);
    assert.deepEqual(statuses(SESSION_B), []);

    // Dismissing the failure clears it from the composer.
    assert.deepEqual(nightQueueService.cancel(failed.id).items, []);
  });
});

test('a runtime that throws counts as a failed try as well', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'explodes' });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, {
      run: async () => {
        throw new Error('provider exploded');
      },
    });
    assert.equal(await dispatchNightQueue(runtime, at(4, 0)), true);
    const [item] = items(SESSION_A);
    assert.equal(item.status, 'pending');
    assert.match(item.failureReason ?? '', /provider exploded/);
  });
});

test('a run someone stopped is marked failed, not retried, and does not pause the queue', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'gets stopped' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'next' });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, {
      run: async (command, writer) => {
        if (command === 'gets stopped') {
          writer.send(createCompleteMessage({ provider: 'claude', sessionId: null, exitCode: 0, aborted: true }));
        }
      },
    });
    assert.equal(await dispatchNightQueue(runtime, at(4, 0)), true);
    const [stopped] = items(SESSION_A);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.failureReason ?? '', /被停止/);

    assert.equal(await dispatchNightQueue(runtime, at(4, 1)), true);
    assert.deepEqual(runs.map((run) => run.command), ['gets stopped', 'next']);
  });
});

test('"run now" lifts the pause that follows a failure', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'hits the limit' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'wanted now' });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, {
      run: async (command, writer) => {
        if (command.endsWith('hits the limit')) failLikeUsageLimit(writer);
      },
    });
    assert.equal(await dispatchNightQueue(runtime, at(3, 0)), true);
    assert.equal(await dispatchNightQueue(runtime, at(3, 1)), false);

    nightQueueService.runNow(SESSION_B);
    assert.equal(await dispatchNightQueue(runtime, at(3, 2)), true);
    assert.deepEqual(runs.map((run) => run.command), ['hits the limit', 'wanted now']);
  });
});

test('the options stored with a prompt are the ones it runs with', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({
      userId,
      sessionId: SESSION_A,
      content: 'with settings',
      options: { model: 'opus', permissionMode: 'bypassPermissions', attachments: [] },
    });

    const runs: RunCall[] = [];
    await dispatchNightQueue(createRuntime(runs), at(2, 30));
    assert.equal(runs[0].options.model, 'opus');
    assert.equal(runs[0].options.permissionMode, 'bypassPermissions');
  });
});

test('an item cut off by a restart is retried with a resume note, and given up after repeated cut-offs', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'build the report' });
    const [item] = items(SESSION_A);

    // The server died while it was running.
    assert.equal(nightQueueDb.claim(item.id), true);
    assert.deepEqual(nightQueueDb.recoverInterrupted(MAX_ATTEMPTS), { requeued: 1, failed: 0 });

    const runs: RunCall[] = [];
    await dispatchNightQueue(createRuntime(runs), at(2, 10));
    assert.equal(runs[0].command, `${RESUME_NOTE}\n\nbuild the report`);

    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'keeps crashing' });
    const [crashing] = items(SESSION_B);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      assert.equal(nightQueueDb.claim(crashing.id), true);
      nightQueueDb.recoverInterrupted(MAX_ATTEMPTS);
    }
    assert.equal(nightQueueDb.claim(crashing.id), true);
    assert.deepEqual(nightQueueDb.recoverInterrupted(MAX_ATTEMPTS), { requeued: 0, failed: 1 });
    assert.deepEqual(statuses(SESSION_B), ['failed']);
  });
});

test('a question to a "run now" prompt is answered for the user after 5 minutes, at any hour', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'asks a question' });
    // Daytime "run now", so the answer does not depend on the night window.
    nightQueueService.runNow(SESSION_A);

    const now = at(9, 0);
    const pending = [
      { requestId: 'stale', toolName: 'AskUserQuestion', receivedAt: new Date(now.getTime() - QUESTION_WAIT_RUN_NOW_MS) },
      { requestId: 'fresh', toolName: 'AskUserQuestion', receivedAt: new Date(now.getTime() - 60_000) },
    ];
    const resolved: Array<{ requestId: string; decision: { allow?: boolean; message?: string } }> = [];
    const gate = createGate();
    const runtime = createRuntime([], { pending, resolved, run: gate.wait });

    // Nothing of the queue is running yet: nothing to answer.
    assert.equal(answerStalledQuestions(runtime, now), 0);

    const running = dispatchNightQueue(runtime, now);
    assert.equal(answerStalledQuestions(runtime, now), 1);
    assert.deepEqual(resolved, [{ requestId: 'stale', decision: { allow: false, message: UNATTENDED_NOTE } }]);

    gate.open();
    await running;
  });
});

test('night mode cannot simply be turned off while prompts wait; cancel all can', async () => {
  await withIsolatedDatabase(async (userId) => {
    assert.equal(nightQueueService.setEnabled(SESSION_A, true).enabled, true);
    assert.equal(nightQueueService.setEnabled(SESSION_A, false).enabled, false);

    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'one' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'two' });
    assert.throws(() => nightQueueService.setEnabled(SESSION_A, false), /立即執行/);
    assert.equal(nightQueueService.getState(SESSION_A).enabled, true);

    const state = nightQueueService.cancelAll(SESSION_A);
    assert.equal(state.enabled, false);
    assert.deepEqual(state.items, []);

    const runs: RunCall[] = [];
    assert.equal(await dispatchNightQueue(createRuntime(runs), at(2, 0)), false);
    assert.equal(runs.length, 0);
  });
});

test('the sidebar list marks sessions with night mode on or prompts not yet finished', async () => {
  await withIsolatedDatabase(async (userId) => {
    assert.deepEqual(nightQueueService.listMarks(), []);
    const marks = () => Object.fromEntries(nightQueueService.listMarks().map((m) => [m.sessionId, [m.enabled, m.queued]]));

    const first = nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'one' }).items[0];
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'two' });
    nightQueueService.setEnabled(SESSION_B, true);
    assert.deepEqual(marks(), { [SESSION_A]: [true, 2], [SESSION_B]: [true, 0] });

    assert.equal(nightQueueDb.claim(first.id), true);
    assert.deepEqual(marks()[SESSION_A], [true, 2], 'a running prompt still counts');
    nightQueueDb.finish(first.id, 'done');
    assert.deepEqual(marks()[SESSION_A], [true, 1], 'a finished one does not');

    nightQueueService.cancelAll(SESSION_A);
    nightQueueService.setEnabled(SESSION_B, false);
    assert.deepEqual(nightQueueService.listMarks(), []);
  });
});

test('an image-only prompt can be stored; an empty one cannot, nor one for a missing session', async () => {
  await withIsolatedDatabase(async (userId) => {
    const state = nightQueueService.enqueue({
      userId,
      sessionId: SESSION_A,
      content: '',
      options: { attachments: [{ path: 'chart.png', name: 'chart.png', mimeType: 'image/png' }] },
    });
    assert.deepEqual(state.items.map((item) => item.attachmentCount), [1]);

    assert.throws(() => nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: '  ' }), /沒有內容/);
    assert.throws(
      () => nightQueueService.enqueue({ userId, sessionId: 'missing', content: 'hello' }),
      /was not found/,
    );
  });
});

test('an alarm prompt starts at its time at any hour, is not cut off at 07:00, and the alarm turns night mode off', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.setEnabled(SESSION_A, true, { startAt: at(12, 5).toISOString(), useBypass: false });
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'lunch job 1' });
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'lunch job 2' });
    assert.deepEqual(items(SESSION_A).map((item) => item.startAt), [at(12, 5).toISOString(), at(12, 5).toISOString()]);

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    assert.equal(await dispatchNightQueue(runtime, at(12, 4)), false, 'not before its time');
    assert.equal(nightQueueDb.expireAlarms(at(12, 4)), 0);
    assert.equal(nightQueueService.getState(SESSION_A).enabled, true);

    // At its time the alarm ends night mode — what is typed afterwards is sent normally — and the prompts run.
    assert.equal(nightQueueDb.expireAlarms(at(12, 5)), 1);
    assert.equal(nightQueueService.getState(SESSION_A).enabled, false);
    assert.equal(await dispatchNightQueue(runtime, at(12, 5)), true);
    assert.equal(await dispatchNightQueue(runtime, at(15, 30)), true, 'no 07:00-style cutoff for an alarm');
    assert.deepEqual(runs.map((run) => run.command), ['lunch job 1', 'lunch job 2']);
  });
});

test('a night prompt stored first still waits for 02:00 while a later alarm prompt runs at its time', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'night work' });
    nightQueueService.setEnabled(SESSION_B, true, { startAt: at(18, 0).toISOString(), useBypass: false });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'after the reset' });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    assert.equal(await dispatchNightQueue(runtime, at(18, 1)), true);
    assert.equal(await dispatchNightQueue(runtime, at(18, 2)), false);
    assert.deepEqual(runs.map((run) => run.command), ['after the reset']);
    assert.deepEqual(statuses(SESSION_A), ['pending']);
  });
});

test('with bypass agreed the prompt runs with bypassPermissions; plan stays plan; without it the stored mode is kept', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.setEnabled(SESSION_A, true, { startAt: null, useBypass: true });
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'edit files', options: { permissionMode: 'default' } });
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'just plan', options: { permissionMode: 'plan' } });
    nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'no consent', options: { permissionMode: 'acceptEdits' } });

    const [editFiles, justPlan] = nightQueueDb.listForSession(SESSION_A);
    const [noConsent] = nightQueueDb.listForSession(SESSION_B);
    assert.equal(buildRunInput(editFiles).options.permissionMode, 'bypassPermissions');
    assert.equal(buildRunInput(justPlan).options.permissionMode, 'plan');
    assert.equal(buildRunInput(noConsent).options.permissionMode, 'acceptEdits');
    assert.deepEqual(items(SESSION_A).map((item) => item.useBypass), [true, true]);
  });
});

test('the unattended note goes to Claude as an appended system prompt, and ahead of the prompt for other providers', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionsDb.createAppSession('night-session-codex', 'codex', tmpdir(), 'Night Codex');
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'claude job' });
    nightQueueService.enqueue({ userId, sessionId: 'night-session-codex', content: 'codex job' });

    const claude = buildRunInput(nightQueueDb.listForSession(SESSION_A)[0]);
    assert.equal(claude.content, 'claude job', 'the user message stays as typed');
    assert.equal(claude.options.appendSystemPrompt, UNATTENDED_SYSTEM_NOTE);

    const codex = buildRunInput(nightQueueDb.listForSession('night-session-codex')[0]);
    assert.ok(codex.content.startsWith('【無人值守排程】'));
    assert.ok(codex.content.endsWith('codex job'));
    assert.equal('appendSystemPrompt' in codex.options, false);

    // The same instructions reach the model on a real pass.
    const runs: RunCall[] = [];
    await dispatchNightQueue(createRuntime(runs), at(2, 0));
    assert.equal(runs[0].options.appendSystemPrompt, UNATTENDED_SYSTEM_NOTE);
  });
});

test('a question to a prompt that started on its own is answered after a minute', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'asks at night' });

    const now = at(3, 0);
    const resolved: Array<{ requestId: string; decision: { allow?: boolean; message?: string } }> = [];
    const gate = createGate();
    const runtime = createRuntime([], {
      pending: [{ requestId: 'q', toolName: 'AskUserQuestion', receivedAt: new Date(now.getTime() - QUESTION_WAIT_UNATTENDED_MS) }],
      resolved,
      run: gate.wait,
    });

    const running = dispatchNightQueue(runtime, now);
    assert.equal(answerStalledQuestions(runtime, new Date(now.getTime() - 1_000)), 0, 'not before a minute');
    assert.equal(answerStalledQuestions(runtime, now), 1);
    gate.open();
    await running;
  });
});

test("a new chat's first prompt brings its settings; later prompts follow the session's", async () => {
  await withIsolatedDatabase(async (userId) => {
    const alarm = { startAt: at(12, 5).toISOString(), useBypass: true };
    const state = nightQueueService.enqueue({ userId, sessionId: SESSION_B, content: 'first', mode: alarm });
    assert.deepEqual(state.mode, alarm);
    assert.deepEqual(state.items.map((item) => [item.startAt, item.useBypass]), [[alarm.startAt, true]]);

    const next = nightQueueService.enqueue({
      userId,
      sessionId: SESSION_B,
      content: 'second',
      mode: { startAt: null, useBypass: false },
    });
    assert.deepEqual(next.items.map((item) => [item.startAt, item.useBypass]), [
      [alarm.startAt, true],
      [alarm.startAt, true],
    ]);
  });
});

test('a prompt with its own start time ("@12:05") runs then; the others in the chat keep the 02:00 default', async () => {
  await withIsolatedDatabase(async (userId) => {
    nightQueueService.setEnabled(SESSION_A, true, { startAt: null, useBypass: false });
    nightQueueService.enqueue({ userId, sessionId: SESSION_A, content: 'tonight' });
    const state = nightQueueService.enqueue({
      userId,
      sessionId: SESSION_A,
      content: 'at lunch',
      startAt: at(12, 5).toISOString(),
    });
    assert.deepEqual(state.items.map((item) => [item.content, item.startAt]), [
      ['tonight', null],
      ['at lunch', at(12, 5).toISOString()],
    ]);
    assert.deepEqual(state.mode, { startAt: null, useBypass: false }, 'the chat itself stays on the night default');

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    assert.equal(await dispatchNightQueue(runtime, at(12, 5)), true);
    assert.equal(await dispatchNightQueue(runtime, at(12, 6)), false);
    assert.deepEqual(runs.map((run) => run.command), ['at lunch']);
    assert.deepEqual(statuses(SESSION_A), ['pending']);
    assert.equal(nightQueueService.getState(SESSION_A).enabled, true, 'a prompt’s own time does not turn the moon off');
  });
});

test('mode settings from a request: night window by default; an alarm must be coming and within 14 days', () => {
  const now = at(11, 50);
  assert.deepEqual(readModeSettings(undefined, now), { startAt: null, useBypass: false });
  assert.deepEqual(readModeSettings({ useBypass: true }, now), { startAt: null, useBypass: true });
  assert.deepEqual(readModeSettings({ startAt: at(12, 5).toISOString() }, now), {
    startAt: at(12, 5).toISOString(),
    useBypass: false,
  });
  assert.throws(() => readModeSettings({ startAt: at(11, 0).toISOString() }, now), /已經過了/);
  assert.throws(() => readModeSettings({ startAt: new Date(now.getTime() + 15 * 86_400_000).toISOString() }, now), /太遠/);
  assert.throws(() => readModeSettings({ startAt: 'noon' }, now), /看不懂/);
});

test('the migration adds the schedule columns to tables made by the first night-queue version', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'night-queue-migrate-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE night_queue_items (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', run_now INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, failure_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE night_queue_sessions (session_id TEXT PRIMARY KEY, enabled_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO night_queue_sessions (session_id) VALUES ('kept-from-before');
  `);
  legacy.close();

  process.env.DATABASE_PATH = databasePath;
  try {
    await initializeDatabase();
    assert.deepEqual(nightQueueDb.getMode('kept-from-before'), { startAt: null, useBypass: false });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
  }

  const check = new Database(databasePath, { readonly: true });
  const columns = (table: string) =>
    (check.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(columns('night_queue_items').includes('start_at'));
  assert.ok(columns('night_queue_items').includes('use_bypass'));
  assert.ok(columns('night_queue_sessions').includes('start_at'));
  assert.ok(columns('night_queue_sessions').includes('use_bypass'));
  check.close();
  await rm(tempDirectory, { recursive: true, force: true });
});
