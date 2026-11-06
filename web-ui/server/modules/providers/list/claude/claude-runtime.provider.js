/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { loadClaudeAgentSdk } from './claude-sdk.loader.js';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { spawnTrackedCli, sweepCliProcessTree } from './claude-stop-sweep.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();

// DHC CLI 2026-10-24: one CLI process per provider session. A run is "complete" for the UI as soon as its
// `result` lands, but the CLI may live on (background subagents hold it for up to BG_WAIT_CEILING_MS), so a
// second send used to spawn another `--resume` process on the same transcript and the two wrote over each
// other. The map is in memory and the entry is released in queryClaudeSDK's finally, so a dead process (or a
// dead server) can never leave a stale lock behind.
const PROCESS_STOP_WAIT_MS = 20 * 1000;
const PROCESS_KILL_WAIT_MS = 5 * 1000;
const processLocks = new Map();

function waitFor(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

/**
 * Registers the caller as the only live CLI process for `key` (synchronously, so concurrent starts queue up
 * behind each other), then waits until the previous holder has exited. A previous holder that has not exited
 * after PROCESS_STOP_WAIT_MS is closed (process killed); one that still lingers is logged and passed.
 * @returns {Promise<{setInstance: Function, release: Function, previous: boolean}>}
 */
async function acquireProcessLock(key, { stopWaitMs = PROCESS_STOP_WAIT_MS, killWaitMs = PROCESS_KILL_WAIT_MS, stopPrevious = () => {}, log = console.warn } = {}) {
  const prev = processLocks.get(key);
  let resolveDone;
  const mine = { instance: null, done: new Promise((resolve) => { resolveDone = resolve; }) };
  processLocks.set(key, mine);
  if (prev) {
    log(`[Claude SDK] session ${key} still has a live CLI process; waiting for it to exit before starting another`);
    try { stopPrevious(prev); } catch {}
    if (!(await waitFor(prev.done, stopWaitMs))) {
      try { prev.instance?.close?.(); } catch {}
      if (!(await waitFor(prev.done, killWaitMs))) {
        log(`[Claude SDK] session ${key}: previous CLI process did not exit after close; starting anyway`);
      } else {
        log(`[Claude SDK] session ${key}: previous CLI process closed after ${stopWaitMs} ms`);
      }
    }
  }
  return {
    previous: Boolean(prev),
    setInstance: (instance) => { mine.instance = instance; },
    release: () => {
      resolveDone();
      if (processLocks.get(key) === mine) {
        processLocks.delete(key);
      }
    },
  };
}

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back, and a
// new turn supersedes the previous hold. This ceiling only catches background work
// that never reports at all, so an abandoned session cannot leak a CLI process
// forever. The timer resets on every message, so it measures silence, not total time.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// DHC CLI: after a turn that took an injected message ends, how long to wait for the follow-up turn
// the CLI starts when the message arrived after the turn's last step (it opens with system/init within
// a fraction of a second). The client keeps seeing the turn as running until this settles.
const INJECT_FOLLOW_UP_WAIT_MS = 2500;

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

// DHC CLI: decides whether a turn may be adopted by a process held open for background work. Returns the
// setters to apply (permission mode, model) or null when something a running process cannot change differs
// (the system prompt, e.g. a queued run's appended instructions).
export function planHeldAdoption(held, next) {
  if (!held || !next || JSON.stringify(held.systemPrompt) !== JSON.stringify(next.systemPrompt)) {
    return null;
  }
  return { permissionMode: next.permissionMode || 'default', model: next.model };
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS) };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code',
    // DHC CLI: a queued (night / alarm) run appends its unattended-work instructions here, so they steer the
    // model without showing up in the user's message.
    ...(typeof options.appendSystemPrompt === 'string' && options.appendSystemPrompt.trim()
      ? { append: options.appendSystemPrompt }
      : {})
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 * @param {Function} injectInput - DHC CLI: hands a user message to the running turn (see injectClaudeSDKMessage)
 * @param {Function} adoptTurn - DHC CLI: hands a new send to a process held open for background work (see queryClaudeSDK)
 */
function addSession(sessionId, queryInstance, writer = null, releaseInput = null, injectInput = null, adoptTurn = null) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, whose
  // session-keyed abortedSessionIds flag would be consumed by the new run
  // and suppress its terminal `complete`.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing.instance);
    Promise.resolve()
      .then(() => existing.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing.releaseInput?.();
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    injectInput: injectInput || carried?.injectInput || null,
    adoptTurn: adoptTurn || carried?.adoptTurn || null
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash only counts
// when it is explicitly backgrounded; the rest defer or watch work by nature.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

/**
 * DHC CLI: follows the work a CLI keeps doing after its turn reported `complete`, so the sidebar can keep a
 * light on while a session's subagents or background shells are still going.
 *
 * The CLI pushes `background_tasks_changed` with every live background task (replace semantics) and flags
 * the ones that are not activity — housekeeping tasks and watchers — as `ambient`. When the work reports
 * back, the CLI starts a follow-up turn by itself (a fresh `system/init`, then a `result`); that turn counts
 * too, or the light would go out while Claude is still answering.
 *
 * @param {() => number} now - Clock, injectable for tests
 * @returns {{
 *   observe: (sdkMessage: Object, turnCompleted: boolean) => boolean,
 *   snapshot: () => (import('@/shared/types.js').BackgroundWorkReport | null)
 * }} `observe` feeds one SDK message and says whether the snapshot changed; `snapshot` is null when idle.
 */
export function createBackgroundWorkTracker(now = Date.now) {
  let tasks = [];
  let followUp = false;
  let since = null;

  const snapshot = () => (tasks.length > 0 || followUp ? { tasks, followUp, since } : null);

  return {
    observe(sdkMessage, turnCompleted) {
      const before = JSON.stringify(snapshot());
      if (sdkMessage?.type === 'system' && sdkMessage.subtype === 'background_tasks_changed') {
        tasks = (Array.isArray(sdkMessage.tasks) ? sdkMessage.tasks : [])
          .filter((task) => task && !task.ambient)
          .map((task) => ({ type: String(task.task_type || ''), description: String(task.description || '') }));
      } else if (sdkMessage?.type === 'result') {
        followUp = false;
      } else if (turnCompleted && (
        (sdkMessage?.type === 'system' && sdkMessage.subtype === 'init')
        || (sdkMessage?.type === 'assistant' && !sdkMessage.parent_tool_use_id)
      )) {
        followUp = true;
      } else {
        return false;
      }
      const active = tasks.length > 0 || followUp;
      if (!active) {
        since = null;
      } else if (since === null) {
        since = now();
      }
      return JSON.stringify(snapshot()) !== before;
    },
    snapshot
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * DHC CLI: push() feeds a later message into the same stdin. The CLI takes one that arrives mid-turn
 * before its next step; one that lands after the turn's last step starts a follow-up turn.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void, push: (message: Object) => boolean }}
 */
function createHeldPromptStream(messages) {
  const pending = [...messages];
  let released = false;
  let wake = null;
  const release = () => {
    released = true;
    wake?.();
  };
  const push = (message) => {
    if (released) {
      return false;
    }
    pending.push(message);
    wake?.();
    return true;
  };

  const stream = (async function* () {
    // Keeps stdin open — the CLI stays alive until release() is called.
    while (true) {
      while (pending.length > 0) {
        yield pending.shift();
      }
      if (released) {
        return;
      }
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  })();

  return { stream, release, push };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer = null;
  // DHC CLI: mid-turn messages. pushPromptMessage writes into the held stdin; injectedThisTurn makes
  // the turn's `result` wait for a possible follow-up turn (INJECT_FOLLOW_UP_WAIT_MS) before completing.
  let pushPromptMessage = () => false;
  let injectedThisTurn = false;
  let injectFollowUpTimer = null;
  const injectInput = async (injectedCommand, injectOptions = {}) => {
    if (turnCompleteSent) {
      return false;
    }
    const messages = await buildPromptMessages(
      injectedCommand,
      injectOptions.images,
      injectOptions.files,
      injectOptions.cwd ?? options.cwd,
    );
    // The turn may have reported complete while attachments were being read.
    if (turnCompleteSent) {
      return false;
    }
    injectedThisTurn = true;
    return messages.every((message) => pushPromptMessage(message));
  };
  // DHC CLI 2026-10-30: a new send while this process is only held open for background work becomes this
  // process's next turn instead of a fresh `--resume` process; replacing the process killed the subagents,
  // shells and Monitors it was holding. Returns a promise settled when that turn reports complete, or null
  // when this process cannot take a turn (one is still in flight, or stdin is already closed).
  let resolveAdoptedTurn = null;
  // The options the running process was started (or last re-pointed) with; a new turn may only adopt it when
  // nothing the process cannot change at runtime differs (see planHeldAdoption).
  let heldSdkOptions = null;
  const adoptTurn = async (messages, newWriter, newSdkOptions) => {
    const canTake = () => turnCompleteSent && heldForBackgroundWork && !resolveAdoptedTurn;
    if (!canTake()) {
      return null;
    }
    const plan = planHeldAdoption(heldSdkOptions, newSdkOptions);
    if (!plan || !queryInstance) {
      return null;
    }
    // Same settings the turn would have started a fresh process with, applied before its message goes in.
    try {
      await queryInstance.setPermissionMode(plan.permissionMode);
      await queryInstance.setModel(plan.model);
    } catch (error) {
      console.warn('[Claude SDK] Unable to apply new turn settings to the held process:', error?.message || error);
      return null;
    }
    if (!canTake() || !messages.every((message) => pushPromptMessage(message))) {
      return null;
    }
    heldSdkOptions = newSdkOptions;
    ws = newWriter;
    const entry = sessionKey() ? getSession(sessionKey()) : null;
    if (entry) {
      entry.writer = newWriter;
    }
    turnCompleteSent = false;
    injectedThisTurn = true;
    return { done: new Promise((resolve) => { resolveAdoptedTurn = resolve; }) };
  };
  const settleAdoptedTurn = () => {
    const resolve = resolveAdoptedTurn;
    resolveAdoptedTurn = null;
    resolve?.();
  };
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // DHC CLI: after-turn work (background subagents/shells, the follow-up turn) reported through the runtime
  // context under this process's own owner key; the finally block clears it once the CLI is gone.
  const backgroundWork = createBackgroundWorkTracker();
  const backgroundWorkOwner = {};
  let backgroundWorkKey = null;

  // DHC CLI 2026-10-30: the process still holding this session's background work takes the turn itself.
  const heldEntry = sessionKey() ? getSession(sessionKey()) : null;
  if (heldEntry?.adoptTurn) {
    const adoptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);
    const adoptModel = (await context.resolveResumeModel(sessionId, options.model)) || options.model;
    const adoptSdkOptions = mapCliOptionsToSDK({ ...options, providerSessionId, model: adoptModel, effortModels: await context.getProviderModels().catch(() => CLAUDE_PREDEFINED_MODELS) });
    const adopted = await heldEntry.adoptTurn(adoptMessages, ws, adoptSdkOptions);
    if (adopted) {
      console.log(`[Claude SDK] session ${sessionKey()}: new turn handed to the process holding background work`);
      await adopted.done;
      return;
    }
  }

  // A new turn supersedes any earlier one still holding this session's process
  // open, so held runs cannot stack up across a conversation.
  if (sessionKey()) {
    getSession(sessionKey())?.releaseInput?.();
  }

  // One live CLI process per provider session (see acquireProcessLock). Taken before anything is spawned.
  const processLock = await acquireProcessLock(providerSessionId || sessionKey() || 'unkeyed:' + Math.random(), {
    stopPrevious: (prev) => { getSession(sessionKey())?.releaseInput?.(); prev.instance?.interrupt?.()?.catch?.(() => {}); },
  });

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      releasePromptStream();
    }, BG_WAIT_CEILING_MS);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance = null;

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }
    heldSdkOptions = sdkOptions;

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    const { query } = await loadClaudeAgentSdk();
    // DHC CLI 2026-10-27: remember the CLI's pid so 停止 can end what it leaves behind (claude-stop-sweep.js).
    const cliProcess = {};
    sdkOptions.spawnClaudeCodeProcess = spawnTrackedCli(cliProcess);
    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    pushPromptMessage = heldPrompt.push;
    try {
      queryInstance = query({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
      processLock.setInstance(queryInstance);
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
    pushPromptMessage = heldPrompt.push;
      queryInstance = query({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
      processLock.setInstance(queryInstance);
    }

    queryInstance.dhcCliProcess = cliProcess;
    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream, injectInput, adoptTurn);
    }

    // A turn's `result`: tell the client the turn is over and decide whether to keep the CLI around.
    const settleTurnResult = (message) => {
      // The turn is done as far as the client is concerned.
      const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;
      if (!turnCompleteSent && !abortPending) {
        turnCompleteSent = true;
        // DHC CLI: a result that is itself an error (usage limit, API error, max turns) ends the run with exit
        // code 1 so the night queue can tell it from a finished turn. The chat UI does not read the exit code.
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: message.is_error ? 1 : 0 }));
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
        settleAdoptedTurn();
      } else if (heldForBackgroundWork && !abortPending) {
        // A result after the turn already reported complete means the work we
        // held the process open for has finished and pushed a follow-up turn.
        notifyBackgroundWorkCompleted({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary
        });
      }
      // DHC CLI 2026-10-30: background subagents count too. They are not tool calls the detector recognises,
      // but the CLI lists them in background_tasks_changed until they report back.
      if (backgroundWorkPending || (backgroundWork.snapshot()?.tasks.length ?? 0) > 0) {
        // Work started during this turn is still running. Hold the process
        // open so it can finish and report back in a follow-up turn; the
        // ceiling is only a backstop for work that never reports.
        backgroundWorkPending = false;
        heldForBackgroundWork = true;
        scheduleRelease();
      } else {
        // Either nothing was backgrounded, or the background work just
        // reported in — let the CLI exit now, as it always has.
        heldForBackgroundWork = false;
        releasePromptStream();
      }
    };

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, releasePromptStream, injectInput, adoptTurn);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      const tokenBudgetData = extractTokenBudget(message)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message));
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }

      if (message.type === 'result') {
        if (injectedThisTurn && !turnCompleteSent) {
          // DHC CLI: a message injected after this turn's last step starts a follow-up turn; hold the
          // completion briefly so the client does not see the run end and then resume.
          injectedThisTurn = false;
          const resultMessage = message;
          clearTimeout(injectFollowUpTimer);
          injectFollowUpTimer = setTimeout(() => {
            injectFollowUpTimer = null;
            settleTurnResult(resultMessage);
          }, INJECT_FOLLOW_UP_WAIT_MS);
        } else {
          settleTurnResult(message);
        }
      } else if (injectFollowUpTimer && message.type === 'system' && message.subtype === 'init') {
        // DHC CLI: the follow-up turn for an injected message began; its own `result` settles the run.
        clearTimeout(injectFollowUpTimer);
        injectFollowUpTimer = null;
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }

      if (backgroundWork.observe(message, turnCompleteSent) && sessionKey()) {
        backgroundWorkKey = sessionKey();
        context.reportBackgroundWork?.(backgroundWorkKey, backgroundWorkOwner, backgroundWork.snapshot());
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (injectFollowUpTimer) {
      clearTimeout(injectFollowUpTimer);
      injectFollowUpTimer = null;
    }
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    releasePromptStream();
    processLock.release();
    settleAdoptedTurn();
    if (backgroundWorkKey) {
      context.reportBackgroundWork?.(backgroundWorkKey, backgroundWorkOwner, null);
    }
  }
}

/**
 * DHC CLI: hands a user message to the session's running turn (desktop-app style mid-turn message).
 * @param {string} sessionId - Session identifier
 * @param {string} command - Message text
 * @param {Object} options - images / files / cwd, already validated by the caller
 * @returns {Promise<boolean>} False when no turn is running to take it
 */
async function injectClaudeSDKMessage(sessionId, command, options = {}) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || !session.injectInput) {
    return false;
  }
  return session.injectInput(command, options);
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  const cli = session.instance?.dhcCliProcess;
  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    // DHC CLI 2026-10-27: subagent shells outlive the interrupted CLI; end the whole tree shortly after.
    sweepCliProcessTree(cli?.pid, cli?.startedAt);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    // The UI already shows it stopped, so end it for real.
    sweepCliProcessTree(cli?.pid, cli?.startedAt);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  inject: injectClaudeSDKMessage,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
};

// Export public API
export {
  acquireProcessLock,
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
