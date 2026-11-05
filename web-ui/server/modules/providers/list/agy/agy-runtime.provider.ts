import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { normalizeAgyEvent, type AgyLiveState } from '@/modules/providers/list/agy/agy-events.js';
import { AGY_DEFAULT_MODEL } from '@/modules/providers/list/agy/agy-models.provider.js';
import {
  agyTranscriptPath,
  appendAgyTranscript,
} from '@/modules/providers/list/agy/agy-transcript.js';
import { checkAgyWorkspaceAccess } from '@/modules/providers/list/agy/agy-whitelist.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const PROVIDER = 'agy' as const;

export const AGY_EXECUTABLE_PATH = process.env.AGY_PATH || 'agy';

/**
 * Commands the headless agent may run without asking. agy matches these against
 * the whole command line (verified: `command(node)` does not allow `node -v`,
 * and prefix wildcards such as `node *` are not honoured), so only these exact
 * command lines go through; everything else is denied and reported to the user.
 */
export const AGY_ALLOWED_PERMISSIONS = [
  'command(node)',
  'command(npm test)',
  'command(npm run lint)',
  'command(git status)',
  'command(git diff)',
  'command(git log)',
  'read_url(*)',
];

/** Swapped by tests so no real agy process is started. */
export const agyRuntimeDeps = { spawnProcess: spawn };

const activeAgyProcesses = new Map<string, ChildProcess & { aborted?: boolean }>();

/**
 * Builds the agy CLI arguments for one turn.
 *
 * - default / acceptEdits: `--mode accept-edits` plus the limited allow list.
 * - bypassPermissions: explicit opt-in from the permission selector only.
 * `--mode plan` is never used because it hangs in headless mode.
 */
export function buildAgyArgs(input: {
  prompt: string;
  model?: string | null;
  conversationId?: string | null;
  permissionMode?: string | null;
}): string[] {
  const args = ['-p', input.prompt, '--output-format', 'stream-json'];
  args.push('--model', input.model?.trim() || AGY_DEFAULT_MODEL);
  if (input.conversationId) {
    args.push('--conversation', input.conversationId);
  }
  if (input.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--mode', 'accept-edits');
    args.push('--settings', JSON.stringify({ permissions: { allow: AGY_ALLOWED_PERMISSIONS } }));
  }
  return args;
}

async function runAgy(
  command: string,
  options: AnyRecord,
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const sessionId = readOptionalString(options.sessionId);
  const workingDir = readOptionalString(options.cwd) ?? readOptionalString(options.projectPath) ?? process.cwd();
  const sessionSummary = readOptionalString(options.sessionSummary);
  const permissionMode = readOptionalString(options.permissionMode);
  const processKey = sessionId || Date.now().toString();
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  let conversationId = providerSessionId;
  const liveState: AgyLiveState = { streamedText: false };

  const send = (message: unknown) => ws.send(message);
  const sendError = (content: string) => send(createNormalizedMessage({
    kind: 'error', content, sessionId: conversationId || sessionId || '', provider: PROVIDER,
  }));

  // Data rule: agy sends everything to Google without de-identification, so the
  // server refuses non-whitelisted projects even if the UI check was bypassed.
  const workspaceAccess = await checkAgyWorkspaceAccess(workingDir);
  if (!workspaceAccess.allowed) {
    sendError(workspaceAccess.reason ?? '這個專案不允許使用 Google agy。');
    send(createCompleteMessage({ provider: PROVIDER, sessionId: sessionId || processKey, exitCode: 1 }));
    return;
  }

  const prompt = command?.trim();
  if (!prompt) {
    sendError('沒有可送出的內容。');
    send(createCompleteMessage({ provider: PROVIDER, sessionId: sessionId || processKey, exitCode: 1 }));
    return;
  }

  const model = await context.resolveResumeModel(sessionId, readOptionalString(options.model));
  const args = buildAgyArgs({ prompt, model, conversationId, permissionMode });

  await new Promise<void>((resolve, reject) => {
    let stdoutBuffer = '';
    let transcriptChain: Promise<void> = Promise.resolve();
    let completeSent = false;
    let promptRecorded = false;
    let stderrText = '';
    let errorSeen = false;

    const record = (entry: Parameters<typeof appendAgyTranscript>[1]) => {
      if (!conversationId) {
        return;
      }
      const id = conversationId;
      transcriptChain = transcriptChain
        .then(() => appendAgyTranscript(id, entry))
        .catch((error) => console.warn('[Agy] transcript write failed:', error instanceof Error ? error.message : error));
    };

    const registerConversation = (id: string) => {
      if (promptRecorded) {
        return;
      }
      const isNew = conversationId !== id;
      conversationId = id;
      const child = activeAgyProcesses.get(processKey);
      if (!sessionId && child) {
        activeAgyProcesses.delete(processKey);
        activeAgyProcesses.set(id, child);
      }
      if (isNew) {
        ws.setSessionId?.(id);
        send(createNormalizedMessage({
          kind: 'session_created', newSessionId: id, sessionId: id, provider: PROVIDER,
        }));
      }
      const file = agyTranscriptPath(id);
      if (file && !existsSync(file)) {
        record({ t: 'meta', ts: new Date().toISOString(), conversationId: id, cwd: workingDir, model: model ?? AGY_DEFAULT_MODEL });
      }
      if (!promptRecorded) {
        promptRecorded = true;
        record({ t: 'user', ts: new Date().toISOString(), text: prompt });
      }
    };

    // A resumed conversation already has an id: record the prompt right away.
    if (conversationId) {
      registerConversation(conversationId);
    }

    const processLine = (line: string) => {
      if (!line.trim()) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        send(createNormalizedMessage({ kind: 'stream_delta', content: line, sessionId: conversationId || sessionId || '', provider: PROVIDER }));
        return;
      }

      const event = readObjectRecord(parsed);
      if (!event) {
        return;
      }
      const eventConversationId = readOptionalString(event.conversation_id)
        ?? readOptionalString(readObjectRecord(readObjectRecord(event.step_update))?.conversation_id)
        ?? readOptionalString(readObjectRecord(event.result)?.conversation_id);
      if (eventConversationId && !promptRecorded) {
        registerConversation(eventConversationId);
      }
      if (event.event !== 'init') {
        record({ t: 'event', ts: new Date().toISOString(), event });
      }
      for (const message of normalizeAgyEvent(event, conversationId || sessionId || null, liveState)) {
        if (message.kind === 'error') {
          errorSeen = true;
        }
        send(message);
      }
    };

    const child: ChildProcess & { aborted?: boolean } = agyRuntimeDeps.spawnProcess(AGY_EXECUTABLE_PATH, args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    activeAgyProcesses.set(processKey, child);

    child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      lines.forEach(processLine);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      // agy prints this hint when a tool was auto-denied; the `result` event's
      // denied_actions already produce a clearer Chinese notice.
      if (!text.trim() || /no output produced — a tool required/.test(text) || /Fetching available models/.test(text)) {
        return;
      }
      // Kept for the exit handler: shown only if the run failed without any
      // error event of its own, so one failure is not reported two or three times.
      stderrText += text;
    });

    const finish = (code: number | null, error?: Error) => {
      const finalSessionId = sessionId || conversationId || processKey;
      activeAgyProcesses.delete(processKey);
      if (conversationId) {
        activeAgyProcesses.delete(conversationId);
      }
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer);
        stdoutBuffer = '';
      }

      if (code !== 0 && !error && !errorSeen && stderrText.trim()) {
        sendError(stderrText.trim().slice(-500));
      }

      void transcriptChain.finally(() => {
        if (!completeSent && !child.aborted) {
          completeSent = true;
          send(createCompleteMessage({ provider: PROVIDER, sessionId: finalSessionId, exitCode: error ? 1 : code }));
        }
        const userId = ws?.userId || null;
        if (code === 0 && !error) {
          const stopped = { userId, provider: PROVIDER, sessionId: finalSessionId, sessionName: sessionSummary, stopReason: 'completed' };
          notifyRunStopped(stopped as never);
          resolve();
          return;
        }
        const failure = error ?? new Error(code === null ? 'Google agy 程序被終止' : `Google agy 結束碼 ${code}`);
        const failed = { userId, provider: PROVIDER, sessionId: finalSessionId, sessionName: sessionSummary, error: failure.message };
        notifyRunFailed(failed as never);
        reject(failure);
      });
    };

    child.on('error', (error) => {
      sendError(`無法啟動 Google agy（${AGY_EXECUTABLE_PATH}）：${error.message}`);
      finish(null, error);
    });
    child.on('close', (code) => finish(code));
  });
}

function abortAgySession(sessionId: string): boolean {
  const child = activeAgyProcesses.get(sessionId);
  if (!child) {
    return false;
  }
  // The abort handler sends the terminal complete; flag so close does not repeat it.
  child.aborted = true;
  child.kill();
  activeAgyProcesses.delete(sessionId);
  return true;
}

export const agyRuntime: IProviderRuntime = {
  run: runAgy,
  abort: abortAgySession,
};
