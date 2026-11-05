import { useCallback, useEffect, useRef, useState } from 'react';

import { useCommandSocket } from '@/modules/command-mode/socket';
import { isStateEvent, type CommandFrame, type CommandModeOutbound, type DeskMark } from '@/modules/command-mode/protocol';

export const CAPTURE_INTERVAL_MS = 1_000;
export const CAPTURE_MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.7;
// 筆畫畫完後，要等螢幕擷取真的拍到軌跡才把它掛到那張畫面上（擷取串流有延遲）。
export const MARK_SETTLE_MS = 500;

export type DesktopPhase = 'idle' | 'picking' | 'sharing';

export const canShareScreen = () => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/** 電腦端：能不能開指揮模式、開了之後定時擷取整個螢幕送給通話中的手機。 */
export function useCommandModeDesktop(projectKey: string | null) {
  const { sendMessage, subscribe, isConnected } = useCommandSocket();
  const [phoneLive, setPhoneLive] = useState(false);
  const [phase, setPhase] = useState<DesktopPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [framesSent, setFramesSent] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastUrlRef = useRef<string | null>(null);
  const pendingMarksRef = useRef<DeskMark[]>([]);
  const captureRef = useRef<(() => void) | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const connectedRef = useRef(isConnected);
  connectedRef.current = isConnected;
  const keyRef = useRef(projectKey);
  keyRef.current = projectKey;

  const send = useCallback((message: CommandModeOutbound) => sendMessage(message), [sendMessage]);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    lastUrlRef.current = null;
    pendingMarksRef.current = [];
    captureRef.current = null;
    const wasActive = phaseRef.current !== 'idle';
    phaseRef.current = 'idle';
    setPhase('idle');
    if (wasActive && keyRef.current) send({ type: 'command.share', projectKey: keyRef.current, active: false });
  }, [send]);

  const start = useCallback(async () => {
    const key = keyRef.current;
    if (!key || phaseRef.current !== 'idle') return;
    if (!canShareScreen()) {
      setError('這個瀏覽器不能分享螢幕');
      return;
    }
    setError(null);
    phaseRef.current = 'picking';
    setPhase('picking');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 5 } as MediaTrackConstraints,
        audio: false,
      });
    } catch {
      phaseRef.current = 'idle';
      setPhase('idle');
      setError('沒有選要分享的螢幕');
      return;
    }
    if (phaseRef.current !== 'picking' || keyRef.current !== key) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    const [track] = stream.getVideoTracks();
    track?.addEventListener('ended', stop);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    const canvas = document.createElement('canvas');
    send({ type: 'command.share', projectKey: key, active: true });
    phaseRef.current = 'sharing';
    setPhase('sharing');

    const capture = () => {
      if (!connectedRef.current || !video.videoWidth) return;
      const scale = Math.min(1, CAPTURE_MAX_WIDTH / video.videoWidth);
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      const now = Date.now();
      const marks = pendingMarksRef.current.filter((m) => now - m.endedAt >= MARK_SETTLE_MS);
      if (dataUrl === lastUrlRef.current && marks.length === 0) return;
      lastUrlRef.current = dataUrl;
      pendingMarksRef.current = pendingMarksRef.current.filter((m) => !marks.includes(m));
      const frame: CommandFrame = {
        id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        capturedAt: now,
        width,
        height,
        dataUrl,
        ...(marks.length > 0 ? { marks } : {}),
      };
      send({ type: 'command.frame', projectKey: key, frame });
      setFramesSent((n) => n + 1);
    };
    captureRef.current = capture;
    capture();
    timerRef.current = setInterval(capture, CAPTURE_INTERVAL_MS);
  }, [send, stop]);

  /** 電腦上右鍵畫完一筆：等軌跡被拍進去後，下一張畫面帶著它送出（手機那邊就算「有圈點」）。 */
  const addMark = useCallback((mark: DeskMark) => {
    if (phaseRef.current !== 'sharing') return;
    pendingMarksRef.current.push(mark);
    setTimeout(() => captureRef.current?.(), MARK_SETTLE_MS + 100);
  }, []);

  useEffect(() => {
    if (!projectKey || !isConnected) return undefined;
    send({ type: 'command.watch', projectKey });
    if (phaseRef.current === 'sharing') {
      send({ type: 'command.share', projectKey, active: true });
      lastUrlRef.current = null;
    }
    return undefined;
  }, [projectKey, isConnected, send]);

  useEffect(() => subscribe((event) => {
    if (isStateEvent(event) && event.projectKey === keyRef.current) setPhoneLive(event.phoneLive);
  }), [subscribe]);

  useEffect(() => {
    if (!phoneLive && phaseRef.current !== 'idle') stop();
  }, [phoneLive, stop]);

  useEffect(() => () => {
    stop();
    setPhoneLive(false);
  }, [projectKey, stop]);

  return { phoneLive, phase, error, framesSent, start, stop, addMark, supported: canShareScreen() };
}
