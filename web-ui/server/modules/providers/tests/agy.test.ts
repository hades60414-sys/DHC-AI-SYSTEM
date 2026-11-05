import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-test-'));
const transcriptRoot = path.join(tempRoot, 'sessions');
const whitelistFile = path.join(tempRoot, 'whitelist.txt');
const allowedProject = path.join(tempRoot, 'DHC Workspace', '工具實驗');
const blockedProject = path.join(tempRoot, 'DHC Workspace', '同事C', '評等');

process.env.AGY_TRANSCRIPT_ROOT = transcriptRoot;
process.env.AGY_WHITELIST_PATH = whitelistFile;
await writeFile(whitelistFile, '# comment\n\nDHC Workspace\\工具實驗\n  annotations  \n', 'utf8');

const {
  checkAgyWorkspaceAccess,
  isAgyWorkspaceAllowed,
  parseAgyWhitelist,
} = await import('@/modules/providers/list/agy/agy-whitelist.js');
const { foldAgyHistory, normalizeAgyEvent, normalizeAgyResult } = await import('@/modules/providers/list/agy/agy-events.js');
const { agyRuntime, agyRuntimeDeps, buildAgyArgs } = await import('@/modules/providers/list/agy/agy-runtime.provider.js');
const { AgySessionsProvider } = await import('@/modules/providers/list/agy/agy-sessions.provider.js');
const { agyTranscriptPath, readAgyTranscript } = await import('@/modules/providers/list/agy/agy-transcript.js');

test.after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---- whitelist ---------------------------------------------------------

test('parseAgyWhitelist drops comments, blanks and BOM', () => {
  assert.deepEqual(parseAgyWhitelist('\uFEFF# a\n\n x \r\ny\n'), ['x', 'y']);
});

test('isAgyWorkspaceAllowed matches a path fragment ignoring case and slash style', () => {
  const fragments = ['DHC Workspace\\工具實驗', 'annotations'];
  assert.equal(isAgyWorkspaceAllowed('C:\\USERS\\demo\\dhc workspace\\工具實驗', fragments), true);
  assert.equal(isAgyWorkspaceAllowed('C:/Users/demo/DHC Workspace/工具實驗/sub', fragments), true);
  assert.equal(isAgyWorkspaceAllowed('C:\\Users\\demo\\DHC Workspace\\同事C\\評等平台', fragments), false);
  assert.equal(isAgyWorkspaceAllowed('', fragments), false);
  assert.equal(isAgyWorkspaceAllowed(null, fragments), false);
  assert.equal(isAgyWorkspaceAllowed('D:\\x', []), false);
});

test('checkAgyWorkspaceAccess reads the file and explains a refusal', async () => {
  assert.deepEqual(await checkAgyWorkspaceAccess(allowedProject), { allowed: true, reason: null });
  const blocked = await checkAgyWorkspaceAccess(blockedProject);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? '', /白名單/);
});

test('checkAgyWorkspaceAccess fails closed when the whitelist is unreadable', async () => {
  const result = await checkAgyWorkspaceAccess(allowedProject, path.join(tempRoot, 'missing.txt'));
  assert.equal(result.allowed, false);
});

// ---- event conversion (events captured from agy 1.4.10) ----------------------

const CONV = '49b71872-fe8a-409c-a92b-e9a427846943';
const step = (extra: Record<string, unknown>) => ({
  event: 'step_update',
  step_update: { conversation_id: CONV, ...extra },
});

test('stream-json agent_response deltas become stream_delta and DONE becomes stream_end', () => {
  const state = { streamedText: false };
  const delta = normalizeAgyEvent(step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'OK' }), 's1', state);
  assert.deepEqual(delta.map((m) => [m.kind, m.content]), [['stream_delta', 'OK']]);
  const done = normalizeAgyEvent(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n' }), 's1', state);
  assert.deepEqual(done.map((m) => m.kind), ['stream_delta', 'stream_end']);
  assert.equal(done[0].provider, 'agy');
  assert.equal(done[0].sessionId, 's1');
});

test('init, user_input and system_message steps produce nothing', () => {
  assert.deepEqual(normalizeAgyEvent({ event: 'init', conversation_id: CONV, init: {} }, 's1'), []);
  assert.deepEqual(normalizeAgyEvent(step({ step_index: 0, state: 'DONE', step_type: 'user_input' }), 's1'), []);
  assert.deepEqual(normalizeAgyEvent(step({ step_index: 3, state: 'DONE', step_type: 'system_message' }), 's1'), []);
});

test('tool steps become tool_use then tool_result sharing a tool id; errors are flagged', () => {
  const use = normalizeAgyEvent(step({
    step_index: 5, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file',
    tool_info: { name: 'read_file', parameters: { Path: 'a.txt' } },
  }), 's1');
  assert.equal(use[0].kind, 'tool_use');
  assert.equal(use[0].toolName, 'read_file');
  assert.deepEqual(use[0].toolInput, { Path: 'a.txt' });

  const ok = normalizeAgyEvent(step({
    step_index: 5, state: 'DONE', step_type: 'tool', tool_name: 'read_file',
    tool_info: { name: 'read_file', parameters: {}, output: '1 lines, 6 bytes' },
  }), 's1');
  assert.equal(ok[0].kind, 'tool_result');
  assert.equal(ok[0].toolId, use[0].toolId);
  assert.deepEqual(ok[0].toolResult, { content: '1 lines, 6 bytes', isError: false });

  const failed = normalizeAgyEvent(step({
    step_index: 6, state: 'ERROR', step_type: 'tool', tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: {}, error: { type: 'TOOL_ERROR', message: 'user denied permission' } },
  }), 's1');
  assert.equal(failed[0].toolResult?.isError, true);
  assert.match(failed[0].toolResult?.content ?? '', /denied/);
});

test('result event: denied actions and token usage are reported, nothing is repeated when text already streamed', () => {
  const state = { streamedText: true };
  const messages = normalizeAgyEvent({
    event: 'result',
    result: {
      conversation_id: CONV, status: 'SUCCESS', response: 'already shown',
      usage: { input_tokens: 13744, output_tokens: 76, total_tokens: 13820 },
      denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
    },
  }, 's1', state);
  assert.deepEqual(messages.map((m) => m.kind), ['error', 'status']);
  assert.match(messages[0].content ?? '', /RunCommand/);
  assert.equal((messages[1].tokenBudget as { used: number }).used, 13820);
});

test('--output-format json output converts to the final text when nothing was streamed', () => {
  const json = { conversation_id: CONV, status: 'SUCCESS', response: '答案', usage: { total_tokens: 10 } };
  const messages = normalizeAgyEvent(json, 's1');
  assert.deepEqual(messages.map((m) => m.kind), ['stream_delta', 'stream_end', 'status']);
  assert.equal(messages[0].content, '答案');
  assert.deepEqual(normalizeAgyResult({ status: 'FAILED', response: '' }, 's1').map((m) => m.kind), ['error']);
});

test('foldAgyHistory rebuilds user/assistant text and tool results, once per turn', () => {
  const ts = '2026-10-30T00:00:00.000Z';
  const ev = (event: Record<string, unknown>) => ({ t: 'event' as const, ts, event });
  const history = foldAgyHistory([
    { t: 'user', ts, text: '讀 a.txt' },
    ev(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { Path: 'a.txt' } } })),
    ev(step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { output: 'hello' } })),
    ev(step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '內容是 ' })),
    ev(step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello' })),
    ev(step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n' })),
    ev({ event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: '內容是 hello\n' } }),
    { t: 'user', ts, text: '再來一次' },
    ev({ event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: '只有最終文字', denied_actions: [{ display_name: 'RunCommand' }] } }),
  ], 's1');

  assert.deepEqual(history.map((m) => [m.kind, m.role ?? null]), [
    ['text', 'user'], ['tool_use', null], ['text', 'assistant'], ['text', 'user'], ['text', 'assistant'], ['error', null],
  ]);
  assert.equal(history[1].toolResult?.content, 'hello');
  assert.equal(history[2].content, '內容是 hello');
  assert.equal(history[4].content, '只有最終文字');
  assert.equal(new Set(history.map((m) => m.id)).size, history.length);
});

// ---- resume with conversation_id ----------------------------------------

test('buildAgyArgs: default is accept-edits with the exact-command allow list, no skip-permissions', () => {
  const args = buildAgyArgs({ prompt: 'hi', model: null });
  assert.deepEqual(args.slice(0, 4), ['-p', 'hi', '--output-format', 'stream-json']);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4-6-thinking');
  assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits');
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args.includes('--conversation'), false);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions.allow, [
    'command(node)', 'command(npm test)', 'command(npm run lint)',
    'command(git status)', 'command(git diff)', 'command(git log)', 'read_url(*)',
  ]);
});

test('buildAgyArgs: conversation id resumes, explicit bypass maps to skip-permissions, plan is never used', () => {
  const resumed = buildAgyArgs({ prompt: 'again', model: 'gemini-3.8-flash-low', conversationId: CONV });
  assert.equal(resumed[resumed.indexOf('--conversation') + 1], CONV);
  assert.equal(resumed[resumed.indexOf('--model') + 1], 'gemini-3.8-flash-low');

  const bypass = buildAgyArgs({ prompt: 'x', permissionMode: 'bypassPermissions' });
  assert.equal(bypass.includes('--dangerously-skip-permissions'), true);
  assert.equal(bypass.includes('plan'), false);
  assert.equal(buildAgyArgs({ prompt: 'x', permissionMode: 'plan' }).includes('plan'), false);
});

type FakeCall = { args: string[]; cwd: string };

function installFakeAgy(lines: string[][], calls: FakeCall[]) {
  let turn = 0;
  agyRuntimeDeps.spawnProcess = ((_cmd: string, args: string[], options: { cwd: string }) => {
    calls.push({ args, cwd: options.cwd });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const output = lines[turn++] ?? [];
    setImmediate(() => {
      child.stdout.write(`${output.join('\n')}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }) as unknown as typeof agyRuntimeDeps.spawnProcess;
}

function runTurn(prompt: string, options: Record<string, unknown>, resolveId: (id: string | null | undefined) => string | null) {
  const sent: Array<Record<string, unknown>> = [];
  const writer = { send: (m: unknown) => sent.push(m as Record<string, unknown>), setSessionId: () => {} };
  const context = {
    resolveProviderSessionId: resolveId,
    resolveResumeModel: async (_id: string | undefined, requested?: string | null) => requested ?? undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  return agyRuntime.run(prompt, options, writer, context).then(() => sent);
}

test('runtime: first turn announces the conversation id, second turn resumes it and history shows both turns', async () => {
  const calls: FakeCall[] = [];
  const turn1 = [
    JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'x' } }),
    JSON.stringify(step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '你好' })),
    JSON.stringify(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n' })),
    JSON.stringify({ event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: '你好\n' } }),
  ];
  const turn2 = [
    JSON.stringify(step({ step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: '第二句' })),
    JSON.stringify(step({ step_index: 4, state: 'DONE', step_type: 'agent_response' })),
    JSON.stringify({ event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: '第二句' } }),
  ];
  installFakeAgy([turn1, turn2], calls);

  const first = await runTurn('第一句', { sessionId: 'app-1', cwd: allowedProject, model: 'claude-sonnet-4-6' }, () => null);
  assert.equal(first.filter((m) => m.kind === 'session_created').length, 1);
  assert.equal((first.find((m) => m.kind === 'session_created') as { newSessionId: string }).newSessionId, CONV);
  assert.equal(first.filter((m) => m.kind === 'complete').length, 1);
  assert.equal(calls[0].args.includes('--conversation'), false);
  assert.equal(calls[0].cwd, allowedProject);

  // The app maps app-1 to the provider conversation id; the follow-up must resume it.
  const second = await runTurn('第二句', { sessionId: 'app-1', cwd: allowedProject }, () => CONV);
  assert.equal(second.filter((m) => m.kind === 'session_created').length, 0);
  assert.equal(calls[1].args[calls[1].args.indexOf('--conversation') + 1], CONV);

  const file = agyTranscriptPath(CONV, transcriptRoot);
  assert.ok(file);
  const { meta, entries } = await readAgyTranscript(file);
  assert.equal(meta?.cwd, allowedProject);
  assert.equal(meta?.model, 'claude-sonnet-4-6');
  assert.equal(entries.filter((e) => e.t === 'user').length, 2);
  assert.equal((await readFile(file, 'utf8')).split('\n').filter((l) => l.includes('"t":"meta"')).length, 1);

  const history = await new AgySessionsProvider().fetchHistory('app-1', { providerSessionId: CONV, limit: null, offset: 0 });
  assert.deepEqual(
    history.messages.map((m) => `${m.role}:${m.content}`),
    ['user:第一句', 'assistant:你好', 'user:第二句', 'assistant:第二句'],
  );
});

test('runtime: a non-whitelisted project is refused before agy is started', async () => {
  const calls: FakeCall[] = [];
  installFakeAgy([[]], calls);
  const sent = await runTurn('hello', { sessionId: 'app-2', cwd: blockedProject }, () => null);
  assert.equal(calls.length, 0);
  assert.deepEqual(sent.map((m) => m.kind), ['error', 'complete']);
  assert.match(String(sent[0].content), /白名單/);
  assert.equal(sent[1].exitCode, 1);
});

test('transcript paths reject ids that are not plain conversation ids', () => {
  assert.equal(agyTranscriptPath('../../etc/passwd', transcriptRoot), null);
  assert.equal(agyTranscriptPath('a/b', transcriptRoot), null);
  assert.ok(agyTranscriptPath(CONV, transcriptRoot)?.endsWith(`${CONV}.jsonl`));
});

// ---- failures --------------------------------------------------------------

test('a quota-exhausted result reads as a per-model quota message', () => {
  const [message] = normalizeAgyResult({
    status: 'ERROR', response: '', error: 'Individual quota reached. Resets in 160h39m28s.',
  }, 's1');
  assert.equal(message.kind, 'error');
  assert.match(message.content ?? '', /額度已用完.*Resets in 160h39m28s.*其他模型/);
});

test('runtime: a run that fails with only stderr output reports it once, then completes with the exit code', async () => {
  const sent: Array<Record<string, unknown>> = [];
  agyRuntimeDeps.spawnProcess = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.write('AGY_ERROR: boom\n');
      child.stdout.end();
      setImmediate(() => child.emit('close', 3));
    });
    return child;
  }) as unknown as typeof agyRuntimeDeps.spawnProcess;
  await assert.rejects(agyRuntime.run('x', { sessionId: 'app-3', cwd: allowedProject }, {
    send: (m: unknown) => sent.push(m as Record<string, unknown>),
  }, {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  }));
  assert.deepEqual(sent.map((m) => m.kind), ['error', 'complete']);
  assert.match(String(sent[0].content), /boom/);
  assert.equal(sent[1].exitCode, 3);
});
