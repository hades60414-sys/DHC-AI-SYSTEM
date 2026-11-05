import { useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';

import { drawStrokes } from '@/modules/command-mode/attachment';
import type { CommandFrame } from '@/modules/command-mode/protocol';
import { STROKE_FADE_MS, classifyStroke, type Stroke, type StrokePoint } from '@/modules/command-mode/strokes';

type Props = {
  frame: CommandFrame;
  strokes: Stroke[];
  onStroke: (stroke: Stroke) => void;
  className?: string;
  style?: CSSProperties;
  /** 畫在下面的內容；左鍵點擊照常落到它身上。沒給就顯示畫面圖片。 */
  children?: ReactNode;
};

/** 滑鼠只有右鍵是雷射筆（左鍵留給底下的內容）；手指、觸控筆照常畫。 */
export const isLaserPointer = (event: { pointerType: string; button: number }) => (
  event.pointerType === 'mouse' ? event.button === 2 : true
);

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** 電腦畫面＋雷射筆：手指或滑鼠右鍵圈、畫線、點，軌跡幾秒後淡出（資料照樣留給送出用）。畫布本身不接事件。 */
export default function LaserSurface({ frame, strokes, onStroke, className = '', style, children }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<{ points: StrokePoint[]; frame: CommandFrame; id: string } | null>(null);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;

  useEffect(() => {
    let raf = 0;
    const paint = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, w, h);
          const now = Date.now();
          for (const s of strokesRef.current) {
            const alpha = 1 - (now - s.endedAt) / STROKE_FADE_MS;
            if (alpha <= 0) continue;
            ctx.globalAlpha = alpha;
            drawStrokes(ctx, [s], w, h);
          }
          const live = drawingRef.current;
          if (live && live.points.length > 0) {
            ctx.globalAlpha = 1;
            drawStrokes(ctx, [{ id: live.id, source: 'phone', frame: live.frame, startedAt: 0, endedAt: now, shape: classifyStroke(live.points), points: live.points }], w, h);
          }
          ctx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, []);

  const point = (event: PointerEvent<HTMLDivElement>): StrokePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height), t: Date.now() };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!isLaserPointer(event)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawingRef.current = { points: [point(event)], frame, id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    drawingRef.current?.points.push(point(event));
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const live = drawingRef.current;
    drawingRef.current = null;
    if (!live) return;
    live.points.push(point(event));
    onStroke({
      id: live.id,
      source: 'phone',
      frame: live.frame,
      startedAt: live.points[0].t,
      endedAt: live.points[live.points.length - 1].t,
      shape: classifyStroke(live.points),
      points: live.points,
    });
  };

  return (
    <div
      data-testid="command-mode-laser"
      className={`relative overflow-hidden rounded-md bg-black ${className}`}
      style={{ aspectRatio: `${frame.width} / ${frame.height}`, touchAction: 'none', ...style }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children ?? <img src={frame.dataUrl} alt="電腦畫面" draggable={false} className="absolute inset-0 h-full w-full select-none" />}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}
