import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Maximize, Pencil, Square, Type, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';

import { cn } from '@/shared/utils';

/**
 * DHC CLI: mark up an attached image before sending it — freehand pen, boxes and text. Marks are kept as shapes
 * in the image's own pixels and redrawn on every change, so undo is just dropping the last one. 「完成」 hands back
 * a new File (same type when it is JPEG, PNG otherwise) that replaces the attachment.
 */
type Point = { x: number; y: number };
type Shape =
  | { kind: 'pen'; color: string; width: number; points: Point[] }
  | { kind: 'rect'; color: string; width: number; from: Point; to: Point }
  | { kind: 'text'; color: string; size: number; at: Point; text: string };
type Tool = 'pen' | 'rect' | 'text';

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#111827', '#ffffff'];
const WIDTHS = [{ label: '細', factor: 0.5 }, { label: '中', factor: 1 }, { label: '粗', factor: 2 }];
/** Long edge cap for the result; Claude scales larger images down anyway. */
const MAX_EDGE = 2400;
/** Text size steps, as multiples of the image's base stroke width. */
const TEXT_STEPS = [2.5, 3.5, 4.5, 6, 8, 11, 15];
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

export function drawShapes(context: CanvasRenderingContext2D, shapes: readonly Shape[]): void {
  for (const shape of shapes) {
    context.strokeStyle = shape.color;
    context.fillStyle = shape.color;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (shape.kind === 'pen') {
      context.lineWidth = shape.width;
      context.beginPath();
      shape.points.forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
      if (shape.points.length === 1) context.lineTo(shape.points[0].x + 0.1, shape.points[0].y);
      context.stroke();
    } else if (shape.kind === 'rect') {
      context.lineWidth = shape.width;
      context.strokeRect(
        Math.min(shape.from.x, shape.to.x),
        Math.min(shape.from.y, shape.to.y),
        Math.abs(shape.to.x - shape.from.x),
        Math.abs(shape.to.y - shape.from.y),
      );
    } else {
      context.font = `bold ${shape.size}px "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
      context.textBaseline = 'top';
      // A thin outline in the opposite tone keeps the text readable on any background.
      context.lineWidth = Math.max(2, shape.size / 8);
      context.strokeStyle = shape.color === '#ffffff' ? '#111827' : '#ffffff';
      shape.text.split('\n').forEach((line, index) => {
        const y = shape.at.y + index * shape.size * 1.25;
        context.strokeText(line, shape.at.x, y);
        context.fillText(line, shape.at.x, y);
      });
    }
  }
}

const outputName = (name: string, type: string) => {
  const base = name.replace(/\.[^.]+$/, '') || 'image';
  return `${base}-標註.${type === 'image/jpeg' ? 'jpg' : 'png'}`;
};

export default function ImageAnnotator({ file, onCancel, onDone }: {
  file: File;
  onCancel: () => void;
  onDone: (file: File) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [widthFactor, setWidthFactor] = useState(1);
  const [textStep, setTextStep] = useState(2);
  /** null = fit the window; otherwise CSS pixels per image pixel. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitZoom, setFitZoom] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [textAt, setTextAt] = useState<Point | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const element = new Image();
    element.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(element.naturalWidth, element.naturalHeight));
      setSize({ width: Math.round(element.naturalWidth * scale), height: Math.round(element.naturalHeight * scale) });
      setImage(element);
    };
    element.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Stroke sizes follow the image, so a mark looks the same on a phone photo and on a small screenshot.
  const baseWidth = Math.max(2, Math.round(Math.max(size.width, size.height) / 300));
  const strokeWidth = baseWidth * widthFactor;
  const textSize = Math.round(Math.max(10, baseWidth * TEXT_STEPS[textStep]));
  const scale = zoom ?? fitZoom;

  // 「符合視窗」 follows the window; an explicit zoom stays put and the area scrolls.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !size.width) return;
    const measure = () => setFitZoom(Math.min(1, (viewport.clientWidth - 32) / size.width, (viewport.clientHeight - 32) / size.height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [size]);

  const changeZoom = (factor: number) => setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * factor)));

  // Ctrl + wheel zooms (non-passive, so the browser does not zoom the whole page instead).
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((current) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (current ?? fitZoom) * (event.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [fitZoom, image]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !image) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawShapes(context, draft ? [...shapes, draft] : shapes);
  }, [draft, image, shapes]);

  useEffect(redraw, [redraw, size]);

  const toImagePoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * size.width,
      y: ((event.clientY - rect.top) / rect.height) * size.height,
    };
  };

  const commitText = () => {
    if (textAt && textDraft.trim()) {
      setShapes((current) => [...current, { kind: 'text', color, size: textSize, at: textAt, text: textDraft }]);
    }
    setTextAt(null);
    setTextDraft('');
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toImagePoint(event);
    if (tool === 'text') {
      // Otherwise the click's mousedown moves focus off the box it just opened, and the blur closes it.
      event.preventDefault();
      if (textAt) commitText();
      setTextAt(point);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft(tool === 'pen'
      ? { kind: 'pen', color, width: strokeWidth, points: [point] }
      : { kind: 'rect', color, width: strokeWidth, from: point, to: point });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const point = toImagePoint(event);
    setDraft(draft.kind === 'pen'
      ? { ...draft, points: [...draft.points, point] }
      : draft.kind === 'rect' ? { ...draft, to: point } : draft);
  };

  const handlePointerUp = () => {
    if (!draft) return;
    const isEmptyRect = draft.kind === 'rect'
      && Math.abs(draft.to.x - draft.from.x) < 3 && Math.abs(draft.to.y - draft.from.y) < 3;
    if (!isEmptyRect) setShapes((current) => [...current, draft]);
    setDraft(null);
  };

  const undo = () => setShapes((current) => current.slice(0, -1));

  const finish = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (shapes.length === 0) {
      onCancel();
      return;
    }
    setIsSaving(true);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    canvas.toBlob((blob) => {
      setIsSaving(false);
      if (!blob) return;
      onDone(new File([blob], outputName(file.name, type), { type, lastModified: Date.now() }));
    }, type, 0.92);
  };

  useEffect(() => {
    // Window capture runs before the chat's document-level "Escape stops the run", which must not see this Escape.
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (textAt) {
          setTextAt(null);
          setTextDraft('');
        } else {
          onCancel();
        }
        return;
      }
      if (!textAt && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [onCancel, textAt]);

  const toolButton = (value: Tool, label: string, Icon: typeof Pencil) => (
    <button
      type="button"
      onClick={() => {
        if (textAt) commitText();
        setTool(value);
      }}
      aria-pressed={tool === value}
      data-testid={`annotate-tool-${value}`}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
        tool === value ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent',
      )}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/85" role="dialog" aria-label="編輯圖片" data-testid="image-annotator">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-card px-3 py-2">
        {toolButton('pen', '畫筆', Pencil)}
        {toolButton('rect', '方框', Square)}
        {toolButton('text', '文字', Type)}
        <span className="mx-1 h-5 w-px bg-border" />
        {COLORS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={`顏色 ${value}`}
            aria-pressed={color === value}
            onClick={() => setColor(value)}
            className={cn('h-6 w-6 rounded-full border border-border', color === value && 'ring-2 ring-primary ring-offset-2 ring-offset-card')}
            style={{ backgroundColor: value }}
          />
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        {WIDTHS.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={widthFactor === option.factor}
            onClick={() => setWidthFactor(option.factor)}
            className={cn(
              'rounded-md px-2 py-1 text-xs',
              widthFactor === option.factor ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent',
            )}
          >
            {option.label}
          </button>
        ))}
        {tool === 'text' && (
          <>
            <span className="mx-1 h-5 w-px bg-border" />
            <span className="text-xs text-muted-foreground">字級</span>
            <button
              type="button"
              aria-label="字小一點"
              data-testid="annotate-text-smaller"
              disabled={textStep === 0}
              onClick={() => setTextStep((step) => Math.max(0, step - 1))}
              className="rounded-md px-1.5 py-1 text-xs font-semibold hover:bg-accent disabled:opacity-40"
            >
              A−
            </button>
            <span className="w-8 text-center text-xs tabular-nums" data-testid="annotate-text-size">{textSize}</span>
            <button
              type="button"
              aria-label="字大一點"
              disabled={textStep === TEXT_STEPS.length - 1}
              onClick={() => setTextStep((step) => Math.min(TEXT_STEPS.length - 1, step + 1))}
              className="rounded-md px-1.5 py-1 text-sm font-semibold hover:bg-accent disabled:opacity-40"
            >
              A+
            </button>
          </>
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        <button type="button" aria-label="縮小" data-testid="annotate-zoom-out" onClick={() => changeZoom(1 / 1.25)} className="rounded-md p-1.5 hover:bg-accent">
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="w-11 text-center text-xs tabular-nums" data-testid="annotate-zoom">{Math.round(scale * 100)}%</span>
        <button type="button" aria-label="放大" data-testid="annotate-zoom-in" onClick={() => changeZoom(1.25)} className="rounded-md p-1.5 hover:bg-accent">
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="符合視窗（Ctrl＋滾輪也能縮放）"
          aria-label="符合視窗"
          aria-pressed={zoom === null}
          onClick={() => setZoom(null)}
          className={cn('rounded-md p-1.5 hover:bg-accent', zoom === null && 'bg-accent')}
        >
          <Maximize className="h-4 w-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button
          type="button"
          onClick={undo}
          disabled={shapes.length === 0}
          title="復原（Ctrl+Z）"
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-40"
        >
          <Undo2 className="h-4 w-4" />
          復原
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">
            取消
          </button>
          <button
            type="button"
            onClick={finish}
            disabled={isSaving || !image}
            data-testid="annotate-done"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            完成
          </button>
          <button type="button" onClick={onCancel} aria-label="關閉" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div ref={viewportRef} className="flex min-h-0 flex-1 overflow-auto p-4" data-testid="annotate-viewport">
        {image ? (
          <div className="relative m-auto shrink-0" style={{ width: size.width * scale, height: size.height * scale }}>
            <canvas
              ref={canvasRef}
              width={size.width}
              height={size.height}
              data-testid="annotate-canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              style={{ width: size.width * scale, height: size.height * scale }}
              className={cn('block touch-none bg-white shadow-2xl', tool === 'text' ? 'cursor-text' : 'cursor-crosshair')}
            />
            {textAt && (
              <textarea
                autoFocus
                value={textDraft}
                onChange={(event) => setTextDraft(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  // Enter is a new line; Ctrl+Enter or a click elsewhere finishes the text.
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    commitText();
                  } else if (event.key === 'Escape') {
                    setTextAt(null);
                    setTextDraft('');
                  }
                }}
                onBlur={commitText}
                placeholder="輸入文字（Enter 換行，點別處完成）"
                data-testid="annotate-text-input"
                rows={Math.max(1, textDraft.split('\n').length)}
                className="absolute min-w-[12rem] resize-none overflow-hidden rounded border border-dashed border-primary bg-background/40 p-0 font-bold leading-[1.25] shadow placeholder:text-xs placeholder:font-normal"
                style={{
                  left: textAt.x * scale,
                  top: textAt.y * scale,
                  color,
                  fontSize: textSize * scale,
                  // Wide enough for the longest line, so the box reads like the text it will become.
                  width: `${Math.max(6, ...textDraft.split('\n').map((line) => line.length + 1))}em`,
                }}
              />
            )}
          </div>
        ) : (
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        )}
      </div>
    </div>,
    document.body,
  );
}
