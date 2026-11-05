import type { ServerEvent } from '@/shared/types';

export type VoiceCallFrameListener = (frame: ServerEvent, sessionId: string | null) => void;

const listeners = new Set<VoiceCallFrameListener>();

/** Every chat frame the realtime handler sees, with the session it was routed to. */
export const voiceCallBus = {
  emit(frame: ServerEvent, sessionId: string | null): void {
    for (const listener of listeners) {
      try {
        listener(frame, sessionId);
      } catch (error) {
        console.error('[voice-call] listener failed', error);
      }
    }
  },
  subscribe(listener: VoiceCallFrameListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
