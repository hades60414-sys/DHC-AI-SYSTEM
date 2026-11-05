import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { drawStrokes } from '@/modules/command-mode/attachment';
import type { DeskMark } from '@/modules/command-mode/protocol';
import { STROKE_FADE_MS, classifyStroke, type Stroke, type StrokePoint } from '@/modules/command-mode/strokes';

type Props = {
  onMark: (mark: DeskMark) => void;
};

type Trail = { stroke: Stroke };

const PLACEHOLDER_FRAME = { id: 'desk', capturedAt: 0, width: 1, height: 1, dataUrl: '' };

/**
 * 指揮模式開著時，在電腦這個 DHC CLI 視窗上按住右鍵畫雷射筆。
 * 只攔右鍵（和右鍵選單）；左鍵、滾輪、鍵盤完全不碰，頁面照常點、切頁。
 * 軌跡畫在全頁透明畫布上（不接任何事件），螢幕擷取會把它拍進去。
 */
export default function DeskLaser({ onMark }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailsRef = useRef<Trail[]>([]);
  const drawingRef = useRef<StrokePoint[] | null>(null);
  const onMarkRef = useRef(onMark);
  onMarkRef.current = onMark;

  useEffect(() => {
    const point = (event: PointerEvent): StrokePoint => ({ x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight, t: Date.now() });
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      drawingRef.current = [point(event)];
    };
    const move = (event: PointerEvent) => {
      if (!drawingRef.current) return;
      event.stopPropagation();
      drawingRef.current.push(point(event));
    };
    const up = (event: PointerEvent) => {
      const points = drawingRef.current;
      if (!points || event.button !== 2) return;
      event.stopPropagation();
      drawingRef.current = null;
      points.push(point(event));
      const id = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const shape = classifyStroke(points);
      const stroke: Stroke = { id, source: 'phone', frame: PLACEHOLDER_FRAME, startedAt: points[0].t, endedAt: points[points.length - 1].t, shape, points };
      trailsRef.current = [...trailsRef.current.filter((t) => Date.now() - t.stroke.endedAt < STROKE_FADE_MS), { stroke }];
      onMarkRef.current({ id, shape, startedAt: stroke.startedAt, endedAt: stroke.endedAt });
    };
    const menu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('contextmenu', menu, true);

    let raf = 0;
    const paint = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(window.innerWidth * dpr);
        const h = Math.round(window.innerHeight * dpr);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.clearRect(0, 0, w, h);
        const now = Date.now();
        for (const { stroke } of trailsRef.current) {
          const alpha = 1 - (now - stroke.endedAt) / STROKE_FADE_MS;
          if (alpha <= 0) continue;
          ctx.globalAlpha = alpha;
          drawStrokes(ctx, [stroke], w, h);
        }
        const live = drawingRef.current;
        if (live && live.length > 0) {
          ctx.globalAlpha = 1;
          drawStrokes(ctx, [{ id: 'live', source: 'phone', frame: PLACEHOLDER_FRAME, startedAt: 0, endedAt: now, shape: classifyStroke(live), points: live }], w, h);
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);

    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('contextmenu', menu, true);
      cancelAnimationFrame(raf);
    };
  }, []);

  return createPortal(
    <canvas ref={canvasRef} data-testid="command-mode-desk-laser" aria-hidden className="pointer-events-none fixed inset-0 z-[9999] h-full w-full" />,
    document.body,
  );
}
