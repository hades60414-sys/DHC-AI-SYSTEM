import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';
import {
  initialCallState,
  phaseOf,
  step,
  type CallEffect,
  type CallEvent,
  type CallPhase,
  type CallState,
  type VoiceTurn,
} from '@/modules/voice-call/callMachine';
import { readVoiceCallConfig, VOICE_SYSTEM_NOTE, writeVoiceCallConfig, type VoiceCallConfig } from '@/modules/voice-call/config';
import { defaultEngines, SttStartError, type EngineFactory, type SttEngine, type SttHandlers, type TtsEngine } from '@/modules/voice-call/engines';
import { voiceCallBus } from '@/modules/voice-call/voiceCallBus';

/** Sends one spoken turn through the composer; resolves to the session it went to, or null when it did not go. */
export type VoiceTurnSender = (turn: { text: string; clientRequestId: string; systemNote: string }) => Promise<string | null>;

export type VoiceCallSnapshot = { call: CallState; config: VoiceCallConfig; fastWhisper: boolean };

type ControllerDeps = {
  sendTurn: VoiceTurnSender;
  abort: () => void;
  confirmCloud: () => Promise<boolean>;
  engines: EngineFactory;
  probeFastWhisper: () => Promise<boolean>;
  now: () => number;
  newId: () => string;
  config?: VoiceCallConfig;
};

// Protocol errors that mean the turn never reached a run (no `complete` will follow for it).
const REJECTING_CODES = new Set(['RUN_IN_PROGRESS', 'SEND_NOT_DELIVERED', 'SESSION_NOT_FOUND', 'UNSUPPORTED_PROVIDER', 'SESSION_ID_REQUIRED', 'INTERNAL_ERROR']);
const REJECT_TEXT: Record<string, string> = {
  RUN_IN_PROGRESS: '上一則還在處理中，這句沒有送出。',
  SEND_NOT_DELIVERED: '連線中斷，這句沒有送出。',
};
const TTS_END_GRACE_MS = 250;
const OFFLINE_GRACE_MS = 5000;

export function newClientRequestId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  // randomUUID only exists on https/localhost; the LAN test address is plain http.
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `vc-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function probeFastWhisper(): Promise<boolean> {
  try {
    const response = await api.voice.health();
    if (!response.ok) return false;
    const data = await response.json();
    return data?.callStt === true;
  } catch {
    return false;
  }
}

const ABORT_CHECK_MS = 10_000;
const ABORT_NOT_TAKEN = '取消沒有送出，任務可能還在跑，請按畫面上的停止鈕。';

/** Owns one call: the reducer state, the engines, and the playback queue. React only renders its snapshot. */
export class VoiceCallController {
  private snapshot: VoiceCallSnapshot;
  private listeners = new Set<() => void>();
  private stt: SttEngine | null = null;
  private tts: TtsEngine | null = null;
  private queue: string[] = [];
  private playing = false;
  private generation = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private abortCheck: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];

  constructor(private deps: ControllerDeps) {
    this.snapshot = { call: initialCallState(), config: deps.config ?? readVoiceCallConfig(), fastWhisper: false };
  }

  setDeps(patch: Partial<ControllerDeps>): void {
    this.deps = { ...this.deps, ...patch };
  }

  getSnapshot = (): VoiceCallSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<VoiceCallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  get state(): CallState {
    return this.snapshot.call;
  }

  dispatch = (event: CallEvent): void => {
    const { config } = this.snapshot;
    const [next, effects] = step(this.snapshot.call, event, config);
    if (next !== this.snapshot.call) this.publish({ call: next });
    for (const effect of effects) this.run(effect);
  };

  start(sessionId: string | null): void {
    if (this.state.lifecycle === 'starting' || this.state.lifecycle === 'live') return;
    this.dispatch({ type: 'START', at: this.deps.now(), sessionId });
  }

  end(): void {
    this.dispatch({ type: 'END' });
  }

  setConfig(patch: Partial<VoiceCallConfig>): void {
    const before = this.snapshot.config;
    const config = writeVoiceCallConfig(patch);
    this.publish({ config });
    if (config.tts !== before.tts || config.voiceName !== before.voiceName || config.rate !== before.rate) {
      this.tts?.cancel();
      this.tts = null;
    }
    const live = this.state.lifecycle === 'live';
    if (live && (config.stt !== before.stt || config.deviceId !== before.deviceId || config.bargeInSensitivity !== before.bargeInSensitivity)) this.run({ type: 'stt', action: 'restart' });
  }

  handleFrame = (frame: ServerEvent, sid: string | null): void => {
    const call = this.state;
    if (call.lifecycle === 'off' || !call.sessionId || sid !== call.sessionId) return;
    const at = this.deps.now();
    switch (frame.kind) {
      case 'chat_send_duplicate':
        if (typeof frame.clientRequestId === 'string') this.dispatch({ type: 'TURN_DUPLICATE', id: frame.clientRequestId });
        return;
      case 'protocol_error': {
        const code = String(frame.code ?? '');
        if (REJECTING_CODES.has(code)) this.dispatch({ type: 'TURN_REJECTED', message: REJECT_TEXT[code] ?? String(frame.error ?? code), at });
        return;
      }
      case 'stream_delta':
        if (typeof frame.content === 'string' && frame.content) this.dispatch({ type: 'RUN_DELTA', text: frame.content, at });
        return;
      case 'stream_end':
        this.dispatch({ type: 'RUN_STREAM_END' });
        return;
      case 'text':
        if (frame.role === 'assistant' && !frame.parentToolUseId && typeof frame.content === 'string' && !frame.isCompactSummary) {
          this.dispatch({ type: 'RUN_TEXT', text: frame.content, at });
        }
        return;
      case 'tool_use':
        this.dispatch({ type: 'RUN_TOOL', at });
        return;
      case 'error':
        this.dispatch({ type: 'RUN_ERROR_TEXT', text: String(frame.content ?? frame.error ?? '') });
        return;
      case 'complete':
        this.dispatch({ type: 'RUN_COMPLETE', success: frame.success !== false && !frame.aborted, aborted: Boolean(frame.aborted), at });
        return;
      case 'permission_request':
        if (typeof frame.requestId === 'string') this.dispatch({ type: 'PERMISSION_REQUEST', requestId: frame.requestId, toolName: String(frame.toolName ?? '') });
        return;
      case 'permission_resolved':
      case 'permission_cancelled':
        if (typeof frame.requestId === 'string') this.dispatch({ type: 'PERMISSION_DONE', requestId: frame.requestId });
        return;
      default:
        return;
    }
  };

  private run(effect: CallEffect) {
    switch (effect.type) {
      case 'speak':
        this.queue.push(effect.text);
        void this.pump();
        return;
      case 'cancel_speech':
        this.generation += 1;
        this.queue = [];
        this.tts?.cancel();
        return;
      case 'send':
        void this.send(effect.turn);
        return;
      case 'abort':
        this.deps.abort();
        // The composer drops an abort it cannot send (no session, nothing abortable); say so instead of going quiet.
        if (this.abortCheck) clearTimeout(this.abortCheck);
        this.abortCheck = setTimeout(() => {
          this.abortCheck = null;
          if (this.state.cancelRequested && this.state.lifecycle !== 'off') this.run({ type: 'speak', text: ABORT_NOT_TAKEN });
        }, ABORT_CHECK_MS);
        return;
      case 'end':
        if (effect.afterSpeech) void this.waitForSpeech().then(() => this.dispatch({ type: 'END' }));
        return;
      case 'stt':
        if (effect.action === 'start') void this.startStt();
        else if (effect.action === 'pause') this.stt?.pause();
        else if (effect.action === 'guard') this.stt?.guard();
        else if (effect.action === 'resume') this.stt?.resume();
        else if (effect.action === 'stop') this.stopStt();
        else {
          this.stopStt();
          void this.startStt();
        }
    }
  }

  private stopStt() {
    this.stt?.stop();
    this.stt = null;
  }

  private handlersFor(stt: SttEngine): SttHandlers {
    const mine = () => this.stt === stt;
    return {
      onPartial: (text) => mine() && this.dispatch({ type: 'STT_PARTIAL', text }),
      onSpeechEnd: () => mine() && this.dispatch({ type: 'STT_SPEECH_END' }),
      onBargeIn: () => mine() && this.dispatch({ type: 'STT_BARGE_IN' }),
      onFinal: (text, at) => mine() && this.dispatch({ type: 'STT_FINAL', text, at, id: this.deps.newId() }),
      onNoSpeech: () => mine() && this.dispatch({ type: 'STT_NO_SPEECH' }),
      onError: (message, transient) => mine() && this.dispatch({ type: 'STT_ERROR', message, transient }),
    };
  }

  private async startStt() {
    const { config } = this.snapshot;
    if (config.stt === 'webspeech' && !(await this.deps.confirmCloud())) {
      this.dispatch({ type: 'START_FAILED', code: 'declined' });
      return;
    }
    if (config.stt === 'whisper') this.publish({ fastWhisper: await this.deps.probeFastWhisper() });
    if (this.state.lifecycle === 'off' || this.state.lifecycle === 'error') return;
    const stt = this.deps.engines.stt(config);
    this.stt = stt;
    try {
      await stt.start(this.handlersFor(stt));
    } catch (error) {
      if (this.stt !== stt) return;
      this.stt = null;
      if (error instanceof SttStartError) this.dispatch({ type: 'START_FAILED', code: error.code, message: error.detail });
      else this.dispatch({ type: 'START_FAILED', code: 'other', message: `通話無法開始：${(error as Error)?.message || error}` });
      return;
    }
    if (this.stt !== stt) {
      stt.stop();
      return;
    }
    if (this.state.muted) stt.pause();
    else if (this.state.speakingSince !== null) {
      if (config.bargeIn) stt.guard();
      else stt.pause();
    }
    this.dispatch({ type: 'READY' });
  }

  private async send(turn: VoiceTurn) {
    try {
      const sessionId = await this.deps.sendTurn({ text: turn.transcript, clientRequestId: turn.id, systemNote: VOICE_SYSTEM_NOTE });
      if (sessionId) this.dispatch({ type: 'TURN_SENT', id: turn.id, sessionId, at: this.deps.now() });
      else this.dispatch({ type: 'TURN_NOT_SENT', id: turn.id, reason: '沒有送出（正在編輯已送出的訊息時不能用語音送出）', at: this.deps.now() });
    } catch (error) {
      this.dispatch({ type: 'TURN_NOT_SENT', id: turn.id, reason: `沒有送出：${(error as Error)?.message || error}`, at: this.deps.now() });
    }
  }

  private ttsEngine(): TtsEngine {
    this.tts ??= this.deps.engines.tts(this.snapshot.config);
    return this.tts;
  }

  private async pump() {
    if (this.playing) return;
    const text = this.queue.shift();
    if (text === undefined) {
      // Sentences of one reply arrive a little apart; do not reopen the mic between them.
      if (this.endTimer) return;
      this.endTimer = setTimeout(() => {
        this.endTimer = null;
        if (this.playing || this.queue.length > 0) return;
        this.dispatch({ type: 'TTS_END' });
        this.drainWaiters.splice(0).forEach((resolve) => resolve());
      }, TTS_END_GRACE_MS);
      return;
    }
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    this.playing = true;
    const generation = this.generation;
    this.dispatch({ type: 'TTS_START', at: this.deps.now() });
    try {
      await this.ttsEngine().speak(text, () => this.dispatch({ type: 'TTS_AUDIBLE', at: this.deps.now() }));
    } catch (error) {
      if (generation === this.generation) {
        const fellBack = this.snapshot.config.tts === 'server';
        if (fellBack) this.tts = this.deps.engines.tts({ ...this.snapshot.config, tts: 'browser' });
        this.dispatch({ type: 'TTS_FAILED', message: `${(error as Error)?.message || error}${fellBack ? '，改用瀏覽器內建語音' : ''}` });
      }
    }
    this.playing = false;
    void this.pump();
  }

  private waitForSpeech(): Promise<void> {
    if (!this.playing && this.queue.length === 0 && !this.endTimer) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      this.drainWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  dispose(): void {
    if (this.state.lifecycle !== 'off') this.dispatch({ type: 'END' });
    this.stopStt();
    this.tts?.cancel();
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.abortCheck) clearTimeout(this.abortCheck);
  }
}

export type TurnLatency = { id: string; transcript: string; status: VoiceTurn['status']; sendMs?: number; firstTextMs?: number; firstAudioMs?: number };

export function turnLatencies(turns: VoiceTurn[]): TurnLatency[] {
  const since = (at: number | undefined, from: number) => (at === undefined ? undefined : at - from);
  return turns.slice(-20).map((turn) => ({
    id: turn.id,
    transcript: turn.transcript,
    status: turn.status,
    sendMs: since(turn.sentAt, turn.speechEndAt),
    firstTextMs: since(turn.firstTextAt, turn.speechEndAt),
    firstAudioMs: since(turn.firstAudioAt, turn.speechEndAt),
  }));
}

type UseVoiceCallOptions = {
  /** The conversation on screen. */
  sessionId: string | null;
  isLoading: boolean;
  sendTurn: VoiceTurnSender;
  abort: () => void;
  confirmCloud: () => Promise<boolean>;
  engines?: EngineFactory;
  bus?: typeof voiceCallBus;
};

declare global {
  interface Window {
    __dhcVoiceCall?: { snapshot: () => unknown };
  }
}

export function useVoiceCall(options: UseVoiceCallOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [controller] = useState(() => new VoiceCallController({
    sendTurn: (turn) => optionsRef.current.sendTurn(turn),
    abort: () => optionsRef.current.abort(),
    confirmCloud: () => optionsRef.current.confirmCloud(),
    engines: options.engines ?? defaultEngines,
    probeFastWhisper,
    now: () => Date.now(),
    newId: newClientRequestId,
  }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { call } = snapshot;
  const bus = options.bus ?? voiceCallBus;
  const connected = useContext(WebSocketContext)?.isConnected ?? true;

  useEffect(() => bus.subscribe(controller.handleFrame), [bus, controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    controller.dispatch({ type: 'RUN_STATE', active: options.isLoading });
  }, [controller, options.isLoading, call.lifecycle]);

  // The call belongs to one conversation; opening another one — or a new chat (no session id) — ends it rather
  // than talking into the wrong chat. A call that has no conversation yet (its first turn allocates one) is
  // not bound, so that allocation does not end it.
  useEffect(() => {
    const bound = controller.state.sessionId;
    if (bound && options.sessionId !== bound && controller.state.lifecycle !== 'off') {
      controller.dispatch({ type: 'END', notice: '切換到別的對話，通話已結束。' });
    }
  }, [controller, options.sessionId]);

  const active = call.lifecycle === 'starting' || call.lifecycle === 'live';
  useEffect(() => {
    if (!active) return undefined;
    const tick = setInterval(() => controller.dispatch({ type: 'TICK', now: Date.now() }), 1000);
    const offline = () => controller.dispatch({ type: 'NETWORK', online: false });
    window.addEventListener('offline', offline);
    return () => {
      clearInterval(tick);
      window.removeEventListener('offline', offline);
    };
  }, [active, controller]);

  useEffect(() => {
    if (!active || connected) return undefined;
    const timer = setTimeout(() => controller.dispatch({ type: 'NETWORK', online: false }), OFFLINE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [active, connected, controller]);

  useEffect(() => {
    window.__dhcVoiceCall = {
      snapshot: () => {
        const { call: c, config, fastWhisper } = controller.getSnapshot();
        return { lifecycle: c.lifecycle, phase: phaseOf(c), muted: c.muted, sessionId: c.sessionId, notice: c.notice, partial: c.partial, ignoredWhileSpeaking: c.ignoredWhileSpeaking, hushed: c.hushed, turns: c.turns, metrics: turnLatencies(c.turns), config, fastWhisper };
      },
    };
    return () => {
      delete window.__dhcVoiceCall;
    };
  }, [controller]);

  const phase: CallPhase = phaseOf(call);
  return {
    call,
    phase,
    config: snapshot.config,
    fastWhisper: snapshot.fastWhisper,
    metrics: turnLatencies(call.turns),
    start: () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        controller.dispatch({ type: 'START', at: Date.now(), sessionId: optionsRef.current.sessionId });
        controller.dispatch({ type: 'NETWORK', online: false });
        return;
      }
      controller.start(optionsRef.current.sessionId);
    },
    end: () => controller.end(),
    bargeIn: () => controller.dispatch({ type: 'BARGE_IN' }),
    toggleMute: () => controller.dispatch({ type: 'MUTE_TOGGLE' }),
    setConfig: (patch: Partial<VoiceCallConfig>) => controller.setConfig(patch),
  };
}
