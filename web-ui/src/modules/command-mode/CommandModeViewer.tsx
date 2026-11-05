import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';

import { useCommandSocket } from '@/modules/command-mode/socket';
import { isFrameEvent, isStateEvent, type CommandModeOutbound } from '@/modules/command-mode/protocol';
import { commandModeStore } from '@/modules/command-mode/store';
import { STROKE_LOOKBACK_MS, strokesForTurn } from '@/modules/command-mode/strokes';
import LaserSurface from '@/modules/command-mode/LaserSurface';

declare global {
  interface Window {
    __dhcCommandMode?: { snapshot: () => unknown };
  }
}

type Props = {
  /** 通話是否進行中（VoiceCallPanel 的 lifecycle 是 starting 或 live）。 */
  live: boolean;
  className?: string;
};

/**
 * 手機端：通話中回報給指揮模式（電腦才會出現按鈕），電腦分享時顯示電腦畫面讓手指圈點。
 * 圈點存在 commandModeStore，語音句子送出時由聊天那邊附成圖片。沒有分享時不佔版面。
 */
export default function CommandModeViewer({ live, className = '' }: Props) {
  const { sendMessage, subscribe, isConnected } = useCommandSocket();
  const state = useSyncExternalStore(commandModeStore.subscribe, commandModeStore.get);
  const [enlarged, setEnlarged] = useState(false);
  const [, setTick] = useState(0);
  const projectKey = state.projectKey;
  const keyRef = useRef(projectKey);
  keyRef.current = projectKey;

  useEffect(() => {
    commandModeStore.setCallLive(live);
    if (projectKey && isConnected) sendMessage({ type: 'command.call', projectKey, live } satisfies CommandModeOutbound);
  }, [live, projectKey, isConnected, sendMessage]);

  useEffect(() => () => {
    commandModeStore.setCallLive(false);
    if (keyRef.current) sendMessage({ type: 'command.call', projectKey: keyRef.current, live: false } satisfies CommandModeOutbound);
  }, [sendMessage]);

  useEffect(() => subscribe((event) => {
    if (isFrameEvent(event) && event.projectKey === keyRef.current) commandModeStore.receiveFrame(event.frame);
    else if (isStateEvent(event) && event.projectKey === keyRef.current) commandModeStore.setSharing(event.sharing);
  }), [subscribe]);

  useEffect(() => {
    window.__dhcCommandMode = {
      snapshot: () => {
        const s = commandModeStore.get();
        return { projectKey: s.projectKey, callLive: s.callLive, sharing: s.sharing, frameId: s.frame?.id ?? null, strokes: s.strokes.map((k) => ({ source: k.source, shape: k.shape, startedAt: k.startedAt, endedAt: k.endedAt, frameId: k.frame.id })), lastTurnAt: s.lastTurnAt, lastAttachedFrameId: s.lastAttachedFrameId };
      },
    };
  }, []);

  const pending = state.callLive ? strokesForTurn(state.strokes, state.lastTurnAt, Date.now()).length : 0;
  useEffect(() => {
    if (pending === 0) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), STROKE_LOOKBACK_MS / 4);
    return () => clearTimeout(timer);
  }, [pending, state.strokes]);

  if (!live || !state.sharing || !state.frame) return null;

  const frame = state.frame;
  const surface = (
    <LaserSurface frame={frame} strokes={state.strokes} onStroke={commandModeStore.addStroke}>
      <img
        src={frame.dataUrl}
        alt="電腦畫面"
        draggable={false}
        data-testid="command-mode-frame"
        className="absolute inset-0 h-full w-full select-none"
        onClick={(event) => {
          // 滑鼠左鍵點畫面＝放大／縮小；手指點一下是雷射筆的點，不切換。
          if ((event.nativeEvent as PointerEvent).pointerType === 'mouse') setEnlarged((v) => !v);
        }}
      />
    </LaserSurface>
  );
  const status = pending > 0 ? `這句會附上 ${pending} 筆圈點` : '手指或滑鼠右鍵可圈、畫、點';

  if (enlarged) {
    // 掛到 body：面板有 backdrop-blur，fixed 在它裡面會被框在面板範圍內。
    return createPortal(
      <div data-testid="command-mode-viewer" className="fixed inset-0 z-[9000] flex flex-col bg-black/95 p-2">
        <div className="flex items-center justify-between pb-2 text-xs text-white">
          <span>電腦畫面．{status}</span>
          <button type="button" onClick={() => setEnlarged(false)} className="inline-flex items-center gap-1 rounded bg-white/15 px-2 py-1">
            <Minimize2 className="h-4 w-4" />縮小
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div style={{ width: `min(100%, calc((100vh - 4rem) * ${frame.width / frame.height}))` }}>{surface}</div>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div data-testid="command-mode-viewer" className={`mt-2 ${className}`}>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="rounded-full bg-red-600 px-2 py-0.5 font-semibold text-white">電腦畫面</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{status}</span>
        <button type="button" onClick={() => setEnlarged(true)} aria-label="放大電腦畫面" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5">
          <Maximize2 className="h-3.5 w-3.5" />放大
        </button>
      </div>
      {surface}
    </div>
  );
}
