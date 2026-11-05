import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * Converts what `agy --print --output-format stream-json|json` emits into the
 * web UI's normalized messages.
 *
 * Observed stream-json events (agy 1.4.10, one JSON object per line):
 * - `{event:'init', conversation_id, init:{model, cwd, tools[], permission_mode}}`
 * - `{event:'step_update', step_update:{conversation_id, step_index, state, step_type, ...}}`
 *     step_type `user_input` | `system_message` | `agent_response` | `tool`;
 *     state `ACTIVE` | `DONE` | `ERROR`.
 *     `agent_response` carries an incremental `text_delta`; `tool` carries
 *     `tool_name` + `tool_info.parameters` (+ `output` / `error` when finished).
 * - `{event:'result', result:{conversation_id, status, response, usage, denied_actions?}}`
 * `--output-format json` prints only the `result` object, so both formats share
 * `normalizeAgyResult`.
 */

const PROVIDER = 'agy' as const;

/** Per-run flags that the live normalizer needs across events. */
export type AgyLiveState = { streamedText: boolean };

export type AgyTranscriptEntry =
  | { t: 'user'; ts: string; text: string }
  | { t: 'event'; ts: string; event: AnyRecord };

/** Deltas must keep their spaces and newlines, so no trimming. */
const readRawString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const toolIdOf = (conversationId: string | undefined, stepIndex: unknown): string =>
  `${conversationId ?? 'agy'}:${String(stepIndex)}`;

const formatToolOutput = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const readToolName = (step: AnyRecord): string =>
  readOptionalString(step.tool_name) ?? readOptionalString(readObjectRecord(step.tool_info)?.name) ?? 'Tool';

const readToolError = (step: AnyRecord): string | undefined => {
  const error = readObjectRecord(readObjectRecord(step.tool_info)?.error);
  return readOptionalString(error?.message) ?? (error ? formatToolOutput(error) : undefined);
};

/** Chinese notice for tool calls that headless mode refused because no allow rule matched. */
export function describeDeniedActions(result: AnyRecord): string | null {
  const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
  if (denied.length === 0) {
    return null;
  }

  const names = Array.from(new Set(denied.map((item) => {
    const record = readObjectRecord(item);
    return readOptionalString(record?.display_name) ?? readOptionalString(record?.action) ?? '工具';
  })));
  return `Google agy 想執行的操作被權限擋下（${names.join('、')}）：目前只自動核准改檔，以及 node、npm test、npm run lint、git status、git diff、git log 這幾個完全一樣的指令。`;
}

/** Chinese error text for a non-SUCCESS result; quota exhaustion gets its own hint because it is per model. */
export function describeFailedStatus(status: string, detail: string | undefined): string {
  if (detail && /quota/i.test(detail)) {
    return `Google agy 這個模型的額度已用完：${detail}。可以改選其他模型（例如 Gemini）再試。`;
  }
  return `Google agy 回報狀態 ${status}${detail ? `：${detail}` : ''}`;
}

const buildTokenBudget = (usage: unknown): AnyRecord | null => {
  const record = readObjectRecord(usage);
  if (!record) {
    return null;
  }
  const inputTokens = Number(record.input_tokens ?? 0);
  const outputTokens = Number(record.output_tokens ?? 0);
  const used = Number(record.total_tokens ?? inputTokens + outputTokens);
  if (!(used > 0)) {
    return null;
  }
  return { used, inputTokens, outputTokens, breakdown: { input: inputTokens, output: outputTokens } };
};

/** Handles a `result` object (stream-json `result` event or whole `--output-format json` output). */
export function normalizeAgyResult(
  result: AnyRecord,
  sessionId: string | null,
  state: AgyLiveState = { streamedText: false },
): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const base = { sessionId: sessionId ?? '', provider: PROVIDER } as const;
  const response = readOptionalString(result.response);

  if (response?.trim() && !state.streamedText) {
    messages.push(createNormalizedMessage({ ...base, kind: 'stream_delta', content: response }));
    messages.push(createNormalizedMessage({ ...base, kind: 'stream_end' }));
    state.streamedText = true;
  }

  const status = readOptionalString(result.status);
  if (status && status !== 'SUCCESS') {
    messages.push(createNormalizedMessage({ ...base, kind: 'error', content: describeFailedStatus(status, readOptionalString(result.error)) }));
  }

  const denied = describeDeniedActions(result);
  if (denied) {
    messages.push(createNormalizedMessage({ ...base, kind: 'error', content: denied }));
  }

  const tokenBudget = buildTokenBudget(result.usage);
  if (tokenBudget) {
    messages.push(createNormalizedMessage({ ...base, kind: 'status', text: 'token_budget', tokenBudget }));
  }

  return messages;
}

/** Live normalization of one parsed stdout object. */
export function normalizeAgyEvent(
  rawMessage: unknown,
  sessionId: string | null,
  state: AgyLiveState = { streamedText: false },
): NormalizedMessage[] {
  const raw = readObjectRecord(rawMessage);
  if (!raw) {
    return [];
  }

  const eventName = readOptionalString(raw.event);
  const base = { sessionId: sessionId ?? '', provider: PROVIDER } as const;

  if (eventName === 'result') {
    return normalizeAgyResult(readObjectRecord(raw.result) ?? {}, sessionId, state);
  }

  // `--output-format json` shape: the object itself is the result.
  if (!eventName && readOptionalString(raw.status) && 'conversation_id' in raw) {
    return normalizeAgyResult(raw, sessionId, state);
  }

  if (eventName !== 'step_update') {
    return [];
  }

  const step = readObjectRecord(raw.step_update);
  if (!step) {
    return [];
  }

  const stepType = readOptionalString(step.step_type);
  const stepState = readOptionalString(step.state);
  const conversationId = readOptionalString(step.conversation_id);

  if (stepType === 'agent_response') {
    const messages: NormalizedMessage[] = [];
    const delta = readRawString(step.text_delta);
    if (delta) {
      state.streamedText = true;
      messages.push(createNormalizedMessage({ ...base, kind: 'stream_delta', content: delta }));
    }
    if (stepState === 'DONE') {
      messages.push(createNormalizedMessage({ ...base, kind: 'stream_end' }));
    }
    return messages;
  }

  if (stepType === 'tool') {
    const toolId = toolIdOf(conversationId, step.step_index);
    const info = readObjectRecord(step.tool_info);
    if (stepState === 'ACTIVE') {
      return [createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolName: readToolName(step),
        toolInput: info?.parameters ?? {},
        toolId,
      })];
    }
    if (stepState === 'DONE' || stepState === 'ERROR') {
      const error = stepState === 'ERROR' ? (readToolError(step) ?? '工具執行失敗') : undefined;
      return [createNormalizedMessage({
        ...base,
        kind: 'tool_result',
        toolId,
        toolResult: { content: error ?? formatToolOutput(info?.output), isError: stepState === 'ERROR' },
      })];
    }
  }

  return [];
}

/**
 * Rebuilds the saved conversation (our own transcript of user prompts + raw agy
 * events) as finished messages: one text bubble per assistant step and each tool
 * call with its result attached.
 */
export function foldAgyHistory(entries: AgyTranscriptEntry[], sessionId: string): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  let seq = 0;
  const nextId = () => `agy_${sessionId}_${seq++}`;
  const textByStep = new Map<number, string>();
  const toolByStep = new Map<number, NormalizedMessage>();
  let assistantTextInTurn = false;

  const pushText = (role: 'user' | 'assistant', content: string, timestamp: string) => {
    out.push(createNormalizedMessage({
      id: nextId(), sessionId, timestamp, provider: PROVIDER, kind: 'text', role, content,
    }));
  };
  const pushError = (content: string, timestamp: string) => {
    out.push(createNormalizedMessage({
      id: nextId(), sessionId, timestamp, provider: PROVIDER, kind: 'error', content,
    }));
  };
  const flushText = (stepIndex: number, timestamp: string) => {
    const text = textByStep.get(stepIndex);
    textByStep.delete(stepIndex);
    if (text?.trim()) {
      assistantTextInTurn = true;
      pushText('assistant', text.replace(/\s+$/, ''), timestamp);
    }
  };

  for (const entry of entries) {
    if (entry.t === 'user') {
      assistantTextInTurn = false;
      pushText('user', entry.text, entry.ts);
      continue;
    }

    const raw = entry.event;
    const eventName = readOptionalString(raw.event);

    if (eventName === 'result' || (!eventName && 'conversation_id' in raw)) {
      const result = readObjectRecord(raw.result) ?? raw;
      const response = readOptionalString(result.response);
      if (response?.trim() && !assistantTextInTurn) {
        assistantTextInTurn = true;
        pushText('assistant', response.replace(/\s+$/, ''), entry.ts);
      }
      const status = readOptionalString(result.status);
      if (status && status !== 'SUCCESS') {
        pushError(describeFailedStatus(status, readOptionalString(result.error)), entry.ts);
      }
      const denied = describeDeniedActions(result);
      if (denied) {
        pushError(denied, entry.ts);
      }
      continue;
    }

    if (eventName !== 'step_update') {
      continue;
    }
    const step = readObjectRecord(raw.step_update);
    if (!step) {
      continue;
    }
    const stepIndex = Number(step.step_index);
    const stepType = readOptionalString(step.step_type);
    const stepState = readOptionalString(step.state);

    if (stepType === 'agent_response') {
      const delta = readRawString(step.text_delta);
      if (delta) {
        textByStep.set(stepIndex, (textByStep.get(stepIndex) ?? '') + delta);
      }
      if (stepState === 'DONE') {
        flushText(stepIndex, entry.ts);
      }
    } else if (stepType === 'tool') {
      const info = readObjectRecord(step.tool_info);
      const toolId = toolIdOf(readOptionalString(step.conversation_id), stepIndex);
      if (stepState === 'ACTIVE' || (stepState && !toolByStep.has(stepIndex))) {
        const message = createNormalizedMessage({
          id: nextId(), sessionId, timestamp: entry.ts, provider: PROVIDER, kind: 'tool_use',
          toolName: readToolName(step), toolInput: info?.parameters ?? {}, toolId,
        });
        toolByStep.set(stepIndex, message);
        out.push(message);
      }
      if (stepState === 'DONE' || stepState === 'ERROR') {
        const message = toolByStep.get(stepIndex);
        if (message) {
          message.toolResult = stepState === 'ERROR'
            ? { content: readToolError(step) ?? '工具執行失敗', isError: true }
            : { content: formatToolOutput(info?.output), isError: false };
        }
      }
    }
  }

  // A run that died mid-stream: keep what was said so far.
  for (const stepIndex of Array.from(textByStep.keys())) {
    flushText(stepIndex, new Date().toISOString());
  }

  return out;
}
