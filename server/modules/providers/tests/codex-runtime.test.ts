import assert from 'node:assert/strict';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { providerTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

test('Codex live context uses the transcript instead of cumulative SDK usage', async (t) => {
  const messages: any[] = [];
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'turn.completed', usage: { input_tokens: 1_600_000, output_tokens: 100 } };
      })() };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'resumeThread', () => thread);
  const lookup = t.mock.method(providerTokenUsageService, 'getSessionTokenUsage', async (id: string) => {
    assert.equal(id, 'app-session');
    return {
      used: 10_100, total: 828_400, inputTokens: 10_000, outputTokens: 100,
      breakdown: { input: 10_000, output: 100 },
    };
  });
  await codexRuntime.run('continue', { sessionId: 'app-session', cwd: process.cwd() }, {
    isWebSocketWriter: true, send: (message) => messages.push(message),
  }, {
    resolveProviderSessionId: () => 'native-thread',
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  });
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(messages.find((message) => message.text === 'token_budget')?.tokenBudget.used, 10_100);
});

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', (options?: ThreadOptions) => {
        capturedOptions = options;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', (id: string, options?: ThreadOptions) => {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedOptions?.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}
