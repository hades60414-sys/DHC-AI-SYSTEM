import { classify, type PendingIntent } from '@/modules/voice-call/intent';
import { emptySpeechBuffer, feedSpeech, flushSpeech, looksLikeQuota, type SpeechBuffer } from '@/modules/voice-call/speakable';

export type CallPhase = 'off' | 'starting' | 'listening' | 'processing' | 'speaking' | 'working' | 'awaiting_confirm' | 'error';
export type TurnStatus = 'sending' | 'running' | 'done' | 'failed' | 'aborted';

export type VoiceTurn = {
  /** Also the clientRequestId on the chat.send frame. */
  id: string;
  sessionId: string | null;
  transcript: string;
  status: TurnStatus;
  speechEndAt: number;
  sentAt?: number;
  firstTextAt?: number;
  firstAudioAt?: number;
  completedAt?: number;
  failure?: string;
};

export type Notice = { tone: 'info' | 'warn' | 'error'; text: string };

export type CallState = {
  lifecycle: 'off' | 'starting' | 'live' | 'error';
  muted: boolean;
  /** When the current playback began; null while silent. STT results for speech after this are the speaker. */
  speakingSince: number | null;
  transcribing: boolean;
  /** A run is going in the call's session, whoever started it (voice or the keyboard). */
  runActive: boolean;
  sessionId: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  partial: string;
  lastReply: string;
  turns: VoiceTurn[];
  pendingIntent: PendingIntent | null;
  cancelRequested: boolean;
  permissions: string[];
  speech: SpeechBuffer;
  streamedSinceText: boolean;
  runSpoke: boolean;
  runErrorText: string;
  sttFailures: number;
  ignoredWhileSpeaking: number;
  /** 使用者打斷後，這次回覆剩下的部分只顯示不念；使用者說下一句或任務結束才恢復。 */
  hushed: boolean;
  notice: Notice | null;
};

export type CallConfig = { maxSpokenChars: number; maxRetries: number; maxCallMinutes: number; idleEndMinutes: number; bargeIn: boolean };

export type StartFailure = 'mic_denied' | 'no_mic' | 'mic_busy' | 'insecure' | 'unsupported' | 'declined' | 'other';

export type CallEvent =
  | { type: 'START'; at: number; sessionId: string | null }
  | { type: 'READY' }
  | { type: 'START_FAILED'; code: StartFailure; message?: string }
  | { type: 'STT_PARTIAL'; text: string }
  | { type: 'STT_SPEECH_END' }
  | { type: 'STT_FINAL'; text: string; at: number; id: string }
  | { type: 'STT_NO_SPEECH' }
  | { type: 'STT_BARGE_IN' }
  | { type: 'STT_ERROR'; message: string; transient: boolean }
  | { type: 'TURN_SENT'; id: string; sessionId: string; at: number }
  | { type: 'TURN_NOT_SENT'; id: string; reason: string; at: number }
  | { type: 'TURN_DUPLICATE'; id: string }
  | { type: 'TURN_REJECTED'; message: string; at: number }
  | { type: 'RUN_STATE'; active: boolean }
  | { type: 'RUN_DELTA'; text: string; at: number }
  | { type: 'RUN_TEXT'; text: string; at: number }
  | { type: 'RUN_STREAM_END' }
  | { type: 'RUN_TOOL'; at: number }
  | { type: 'RUN_ERROR_TEXT'; text: string }
  | { type: 'RUN_COMPLETE'; success: boolean; aborted: boolean; at: number }
  | { type: 'PERMISSION_REQUEST'; requestId: string; toolName: string }
  | { type: 'PERMISSION_DONE'; requestId: string }
  | { type: 'TTS_START'; at: number }
  | { type: 'TTS_AUDIBLE'; at: number }
  | { type: 'TTS_END' }
  | { type: 'TTS_FAILED'; message: string }
  | { type: 'BARGE_IN' }
  | { type: 'MUTE_TOGGLE' }
  | { type: 'NETWORK'; online: boolean }
  | { type: 'TICK'; now: number }
  | { type: 'END'; notice?: string };

export type CallEffect =
  | { type: 'speak'; text: string }
  | { type: 'send'; turn: VoiceTurn; inject: boolean }
  | { type: 'abort' }
  | { type: 'cancel_speech' }
  | { type: 'stt'; action: 'start' | 'pause' | 'guard' | 'resume' | 'restart' | 'stop' }
  | { type: 'end'; afterSpeech: boolean };

export const SAY = {
  confirmCancel: '要停止目前正在執行的任務嗎？',
  askStopOrCancel: '要停止播音，還是取消任務？',
  noRun: '目前沒有執行中的任務。',
  keepGoing: '好，任務繼續執行。',
  cancelled: '已停止。已經執行過的動作不會被撤銷，詳情看畫面。',
  stopped: '任務已停止。',
  failed: '任務沒有成功完成，詳情看畫面。',
  quota: '額度不足或達到用量上限，文字介面仍可使用。',
  doneSilent: '完成了，結果在畫面上。',
  permission: '需要你在畫面上按確認，語音不能代按。',
  question: '有問題要你在畫面上回答，語音不能代答。',
  notSent: '剛剛那句沒有送出，詳情看畫面。',
  durationLimit: '通話已經到時間上限，先掛斷。文字介面可以繼續用。',
  idleLimit: '一段時間沒有對話，先掛斷。',
  ok: '好。',
} as const;

const START_FAILURE_TEXT: Record<StartFailure, string> = {
  mic_denied: '麥克風權限被拒絕。請點網址列左邊的鎖頭圖示，把「麥克風」改成允許，再重新開始通話。文字輸入不受影響。',
  no_mic: '找不到麥克風，請接上麥克風後再試。文字輸入不受影響。',
  mic_busy: '麥克風被其他程式佔用，無法開始通話。',
  insecure: '無法使用麥克風：請用 https 網址開啟。',
  unsupported: '這個瀏覽器不支援語音辨識，請在設定改用本機辨識（whisper），或改用 Chrome／Edge。',
  declined: '沒有同意雲端辨識，通話沒有開始。可以改用本機辨識（whisper）。',
  other: '通話無法開始。',
};

export const OFFLINE_TEXT = '連線中斷，文字輸入仍可用。恢復連線後請重新開始通話。';
export const NO_SPEECH_TEXT = '沒聽到聲音，請確認麥克風。';

export function initialCallState(): CallState {
  return {
    lifecycle: 'off',
    muted: false,
    speakingSince: null,
    transcribing: false,
    runActive: false,
    sessionId: null,
    startedAt: null,
    lastActivityAt: null,
    partial: '',
    lastReply: '',
    turns: [],
    pendingIntent: null,
    cancelRequested: false,
    permissions: [],
    speech: emptySpeechBuffer(),
    streamedSinceText: false,
    runSpoke: false,
    runErrorText: '',
    sttFailures: 0,
    ignoredWhileSpeaking: 0,
    hushed: false,
    notice: null,
  };
}

const isOpen = (status: TurnStatus) => status === 'sending' || status === 'running';

export function hasOpenTurn(state: CallState): boolean {
  return state.turns.some((turn) => isOpen(turn.status));
}

export function phaseOf(state: CallState): CallPhase {
  if (state.lifecycle !== 'live') return state.lifecycle;
  if (state.permissions.length > 0) return 'awaiting_confirm';
  if (state.speakingSince !== null) return 'speaking';
  if (state.transcribing || state.turns.some((turn) => turn.status === 'sending')) return 'processing';
  if (state.runActive || hasOpenTurn(state)) return 'working';
  return 'listening';
}

type Step = [CallState, CallEffect[]];

const updateTurn = (state: CallState, id: string, patch: Partial<VoiceTurn>): CallState => ({
  ...state,
  turns: state.turns.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)),
});

function speakReply(state: CallState, text: string, cfg: CallConfig, at: number): Step {
  const { buffer, sentences } = feedSpeech(state.speech, text, cfg.maxSpokenChars);
  const turns = state.turns.map((turn) => (turn.status === 'running' && !turn.firstTextAt ? { ...turn, firstTextAt: at } : turn));
  return [
    { ...state, speech: buffer, turns, lastReply: (state.lastReply + text).slice(-4000), runSpoke: state.runSpoke || sentences.length > 0, lastActivityAt: at },
    state.hushed ? [] : sentences.map((s) => ({ type: 'speak', text: s })),
  ];
}

/** 停止朗讀、這次回覆剩下的不再念，麥克風照常聽（插話那句正在錄，不能重開）。任務不受影響。 */
function interrupt(state: CallState): Step {
  return [{ ...state, speakingSince: null, hushed: true }, [{ type: 'cancel_speech' }, ...(state.muted ? [] : [{ type: 'stt', action: 'resume' } as CallEffect])]];
}

function fail(state: CallState, text: string): Step {
  return [{ ...state, lifecycle: 'error', speakingSince: null, transcribing: false, partial: '', notice: { tone: 'error', text } }, [{ type: 'cancel_speech' }, { type: 'stt', action: 'stop' }]];
}

function onUtterance(state: CallState, event: Extract<CallEvent, { type: 'STT_FINAL' }>): Step {
  const text = event.text.trim();
  const base: CallState = { ...state, partial: '', transcribing: false, sttFailures: 0, lastActivityAt: event.at, notice: null };
  if (!text) return [base, []];
  const runActive = state.runActive || hasOpenTurn(state);
  const intent = classify(text, { pendingIntent: state.pendingIntent });
  const say = (s: string): CallEffect => ({ type: 'speak', text: s });

  switch (intent) {
    case 'end_call':
      return [{ ...base, lifecycle: 'off' }, [{ type: 'cancel_speech' }, { type: 'stt', action: 'stop' }, { type: 'end', afterSpeech: false }]];
    case 'stop_speaking':
      return [{ ...base, pendingIntent: null }, []];
    case 'confirm_yes':
      if (!runActive) return [{ ...base, pendingIntent: null }, [say(SAY.noRun)]];
      return [{ ...base, pendingIntent: null, cancelRequested: true }, [{ type: 'abort' }]];
    case 'confirm_no':
      return [{ ...base, pendingIntent: null }, [say(SAY.keepGoing)]];
    case 'cancel_task':
      if (!runActive) return [{ ...base, pendingIntent: null }, [say(SAY.noRun)]];
      return [{ ...base, pendingIntent: 'confirm_cancel' }, [say(SAY.confirmCancel)]];
    case 'ambiguous_cancel':
      if (!runActive) return [{ ...base, pendingIntent: null }, [say(SAY.ok)]];
      return [{ ...base, pendingIntent: 'ask_stop_or_cancel' }, [say(SAY.askStopOrCancel)]];
    case 'message': {
      const turn: VoiceTurn = { id: event.id, sessionId: state.sessionId, transcript: text, status: 'sending', speechEndAt: event.at };
      return [{ ...base, pendingIntent: null, hushed: false, turns: [...state.turns, turn].slice(-50) }, [{ type: 'send', turn, inject: runActive }]];
    }
  }
}

function onComplete(state: CallState, event: Extract<CallEvent, { type: 'RUN_COMPLETE' }>, cfg: CallConfig): Step {
  const { sentences } = flushSpeech(state.speech, cfg.maxSpokenChars);
  const effects: CallEffect[] = state.hushed ? [] : sentences.map((text) => ({ type: 'speak', text }));
  const quota = !event.success && !event.aborted && looksLikeQuota(`${state.runErrorText}\n${state.lastReply}`);
  const status: TurnStatus = event.aborted ? 'aborted' : event.success ? 'done' : 'failed';
  const failure = status === 'failed' ? (quota ? SAY.quota : state.runErrorText.trim().slice(0, 300) || SAY.failed) : undefined;
  const hadVoiceTurn = state.turns.some((turn) => turn.status === 'running');

  if (event.aborted) effects.push({ type: 'speak', text: state.cancelRequested ? SAY.cancelled : SAY.stopped });
  else if (quota) effects.push({ type: 'speak', text: SAY.quota });
  else if (!event.success) effects.push({ type: 'speak', text: SAY.failed });
  else if (hadVoiceTurn && !state.runSpoke && sentences.length === 0) effects.push({ type: 'speak', text: SAY.doneSilent });

  return [{
    ...state,
    turns: state.turns.map((turn) => (turn.status === 'running' ? { ...turn, status, completedAt: event.at, failure } : turn)),
    runActive: false,
    speech: emptySpeechBuffer(),
    streamedSinceText: false,
    runSpoke: false,
    runErrorText: '',
    cancelRequested: false,
    permissions: [],
    pendingIntent: null,
    hushed: false,
    lastActivityAt: event.at,
    notice: quota ? { tone: 'error', text: SAY.quota } : state.notice,
  }, effects];
}

/**
 * The whole call as one reducer: events in, the next state plus side effects out. A turn's status only moves
 * to done/failed/aborted on the run's real `complete` frame (or the server refusing the frame), never on
 * anything the model says.
 */
export function step(state: CallState, event: CallEvent, cfg: CallConfig): Step {
  if (event.type === 'START') {
    return [{ ...initialCallState(), lifecycle: 'starting', sessionId: event.sessionId, startedAt: event.at, lastActivityAt: event.at }, [{ type: 'stt', action: 'start' }]];
  }
  if (state.lifecycle === 'off') return [state, []];
  const live = state.lifecycle === 'live';

  switch (event.type) {
    case 'READY':
      return state.lifecycle === 'starting' ? [{ ...state, lifecycle: 'live' }, []] : [state, []];
    case 'START_FAILED':
      return fail(state, event.message || START_FAILURE_TEXT[event.code]);
    case 'END':
      return [{ ...state, lifecycle: 'off', speakingSince: null, transcribing: false, partial: '', notice: event.notice ? { tone: 'info', text: event.notice } : state.notice }, [{ type: 'cancel_speech' }, { type: 'stt', action: 'stop' }]];
    case 'NETWORK':
      return event.online ? [state, []] : fail(state, OFFLINE_TEXT);
    case 'RUN_STATE':
      return [{ ...state, runActive: event.active }, []];
    default:
      break;
  }
  if (!live) return [state, []];

  switch (event.type) {
    case 'STT_PARTIAL':
      if (state.speakingSince !== null || state.muted) return [state, []];
      return [{ ...state, partial: event.text }, []];
    case 'STT_SPEECH_END':
      if (state.speakingSince !== null || state.muted) return [state, []];
      return [{ ...state, transcribing: true }, []];
    case 'STT_FINAL':
      // Half duplex: whatever the mic picked up while the speaker played is not a command.
      if (state.muted || (state.speakingSince !== null && event.at >= state.speakingSince)) return [{ ...state, partial: '', transcribing: false, ignoredWhileSpeaking: state.ignoredWhileSpeaking + 1 }, []];
      return onUtterance(state, event);
    case 'STT_BARGE_IN':
      // 喇叭剛好念完才確認的，就只是一般的下一句。
      if (state.speakingSince === null) return [state, []];
      return interrupt(state);
    case 'STT_NO_SPEECH':
      return [{ ...state, transcribing: false, notice: { tone: 'info', text: NO_SPEECH_TEXT } }, []];
    case 'STT_ERROR': {
      const failures = state.sttFailures + 1;
      if (!event.transient || failures > cfg.maxRetries) return fail(state, event.message);
      return [{ ...state, transcribing: false, sttFailures: failures, notice: { tone: 'warn', text: `${event.message}（重試 ${failures}/${cfg.maxRetries}）` } }, [{ type: 'stt', action: 'restart' }]];
    }
    case 'TURN_SENT': {
      const next = updateTurn(state, event.id, { status: 'running', sentAt: event.at, sessionId: event.sessionId });
      return [{ ...next, sessionId: event.sessionId }, []];
    }
    case 'TURN_NOT_SENT':
      return [updateTurn(state, event.id, { status: 'failed', failure: event.reason, completedAt: event.at }), [{ type: 'speak', text: SAY.notSent }]];
    case 'TURN_DUPLICATE':
      return [state, []];
    case 'TURN_REJECTED': {
      const target = [...state.turns].reverse().find((turn) => isOpen(turn.status));
      if (!target) return [state, []];
      return [updateTurn(state, target.id, { status: 'failed', failure: event.message, completedAt: event.at }), [{ type: 'speak', text: SAY.notSent }]];
    }
    case 'RUN_DELTA':
      return speakReply({ ...state, streamedSinceText: true }, event.text, cfg, event.at);
    case 'RUN_TEXT':
      // The finished block repeats what was already streamed.
      if (state.streamedSinceText) return [{ ...state, streamedSinceText: false }, []];
      return speakReply(state, `${event.text}\n`, cfg, event.at);
    case 'RUN_STREAM_END':
      return speakReply(state, '\n', cfg, state.lastActivityAt ?? 0);
    case 'RUN_TOOL':
      return [{ ...state, lastActivityAt: event.at }, []];
    case 'RUN_ERROR_TEXT':
      return [{ ...state, runErrorText: `${state.runErrorText}\n${event.text}`.slice(-2000) }, []];
    case 'RUN_COMPLETE':
      return onComplete(state, event, cfg);
    case 'PERMISSION_REQUEST': {
      if (state.permissions.includes(event.requestId)) return [state, []];
      const first = state.permissions.length === 0;
      const text = event.toolName === 'AskUserQuestion' ? SAY.question : SAY.permission;
      return [{ ...state, permissions: [...state.permissions, event.requestId] }, first ? [{ type: 'speak', text }] : []];
    }
    case 'PERMISSION_DONE':
      return [{ ...state, permissions: state.permissions.filter((id) => id !== event.requestId) }, []];
    case 'TTS_START':
      if (state.speakingSince !== null) return [state, []];
      return [{ ...state, speakingSince: event.at, partial: '' }, [{ type: 'stt', action: 'pause' }]];
    case 'TTS_AUDIBLE': {
      const latest = state.turns[state.turns.length - 1];
      const next = latest && latest.sentAt && !latest.firstAudioAt ? updateTurn(state, latest.id, { firstAudioAt: event.at }) : state;
      // 真的出聲才開始邊念邊聽：回音大小要從實際播出的聲音學。
      return [next, state.speakingSince !== null && cfg.bargeIn && !state.muted ? [{ type: 'stt', action: 'guard' }] : []];
    }
    case 'TTS_END':
      if (state.speakingSince === null) return [state, []];
      return [{ ...state, speakingSince: null }, state.muted ? [] : [{ type: 'stt', action: 'resume' }]];
    case 'TTS_FAILED':
      return [{ ...state, notice: { tone: 'warn', text: `朗讀失敗：${event.message}。回覆仍會顯示在畫面上。` } }, []];
    case 'BARGE_IN':
      return interrupt(state);
    case 'MUTE_TOGGLE': {
      const muted = !state.muted;
      const unmuted: CallEffect[] = state.speakingSince === null ? [{ type: 'stt', action: 'resume' }] : cfg.bargeIn ? [{ type: 'stt', action: 'guard' }] : [];
      return [{ ...state, muted, partial: '' }, muted ? [{ type: 'stt', action: 'pause' }] : unmuted];
    }
    case 'TICK': {
      if (state.startedAt !== null && event.now - state.startedAt >= cfg.maxCallMinutes * 60_000) {
        return [{ ...state, lifecycle: 'off', notice: { tone: 'info', text: SAY.durationLimit } }, [{ type: 'stt', action: 'stop' }, { type: 'speak', text: SAY.durationLimit }, { type: 'end', afterSpeech: true }]];
      }
      const idle = !state.runActive && !hasOpenTurn(state) && state.speakingSince === null && !state.transcribing && state.permissions.length === 0;
      if (idle && state.lastActivityAt !== null && event.now - state.lastActivityAt >= cfg.idleEndMinutes * 60_000) {
        return [{ ...state, lifecycle: 'off', notice: { tone: 'info', text: SAY.idleLimit } }, [{ type: 'stt', action: 'stop' }, { type: 'speak', text: SAY.idleLimit }, { type: 'end', afterSpeech: true }]];
      }
      return [state, []];
    }
  }
}
