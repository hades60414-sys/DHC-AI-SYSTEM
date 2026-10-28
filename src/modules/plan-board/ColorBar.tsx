import { CaptureUpdateAction, newElementWith, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

import { arrowheadsFor, isHorizontal, splitAlpha, withAlpha } from '@/modules/plan-board/sceneModel';
import type { SceneElement } from '@/modules/plan-board/sceneModel';
import { X } from 'lucide-react';

import { cn } from '@/shared/utils';

/**
 * DHC CLI 10/13 規劃白板: more colours than Excalidraw's five quick picks, a separate text colour, and how see-through
 * a fill is. Shown while something is selected or a drawing tool is in hand; a pick also becomes the colour for
 * what is drawn next.
 */

// Excalidraw's black: drawn black on the light canvas and white on the dark one (the dark theme inverts the canvas).
export const DEFAULT_STROKE = '#1e1e1e';
const STROKES = ['#1e1e1e', '#868e96', '#ffffff', '#e03131', '#f08c00', '#f59f00', '#2f9e44', '#0c8599', '#1971c2', '#3b5bdb', '#6741d9', '#c2255c', '#846358'];
const FILLS = [
  'transparent',
  '#ffc9c9', '#ffd8a8', '#ffec99', '#b2f2bb', '#99e9f2', '#a5d8ff', '#bac8ff', '#d0bfff', '#fcc2d7', '#e9ecef',
  '#ff8787', '#ffa94d', '#ffd43b', '#69db7c', '#3bc9db', '#4dabf7', '#748ffc', '#9775fa', '#f783ac', '#adb5bd',
];
const NO_FILL = new Set(['text', 'line', 'arrow', 'freedraw']);
const BOX_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);
type BoxShape = 'rectangle' | 'rounded' | 'ellipse' | 'diamond';
// Excalidraw draws the dark theme by inverting the canvas; the swatches get the same filter so they match.
const DARK_FILTER = 'invert(93%) hue-rotate(180deg)';

type ColorBarProps = {
  api: ExcalidrawImperativeAPI;
  isDark: boolean;
  selectedIds: Record<string, true>;
  /** Fill of what is drawn next (keeps its alpha). */
  currentFill: string;
  onClose: () => void;
};

export default function ColorBar({ api, isDark, selectedIds, currentFill, onClose }: ColorBarProps) {
  const elements = api.getSceneElements() as unknown as SceneElement[];
  const selected = elements.filter((element) => selectedIds[element.id]);
  const fillTargets = selected.filter((element) => !NO_FILL.has(element.type));
  const fillSource = fillTargets.find((element) => element.backgroundColor && element.backgroundColor !== 'transparent')?.backgroundColor
    ?? (selected.length === 0 ? currentFill : 'transparent');
  const { alpha } = splitAlpha(fillSource ?? 'transparent');
  const fillIsEmpty = !fillSource || fillSource === 'transparent';

  const update = (patchOf: (element: SceneElement) => Record<string, unknown> | null, appState: Record<string, unknown>) => {
    const next = api.getSceneElements().map((element) => {
      const patch = patchOf(element as unknown as SceneElement);
      return patch ? newElementWith(element as never, patch as never) : element;
    });
    api.updateScene({ elements: next as never, appState: appState as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };

  const onlyText = selected.length > 0 && selected.every((element) => element.type === 'text');
  const setStroke = (color: string) => update(
    (element) => (selectedIds[element.id] && (onlyText || element.type !== 'text') ? { strokeColor: color } : null),
    { currentItemStrokeColor: color },
  );
  const setText = (color: string) => update(
    (element) => (element.type === 'text' && (selectedIds[element.id] || (element.containerId && selectedIds[element.containerId])) ? { strokeColor: color } : null),
    {},
  );
  const setFill = (color: string) => {
    const value = withAlpha(color, color === 'transparent' ? 100 : alpha);
    update((element) => (selectedIds[element.id] && !NO_FILL.has(element.type) ? { backgroundColor: value } : null), { currentItemBackgroundColor: value });
  };
  const setAlpha = (next: number) => {
    update((element) => {
      if (!selectedIds[element.id] || NO_FILL.has(element.type) || !element.backgroundColor || element.backgroundColor === 'transparent') return null;
      return { backgroundColor: withAlpha(splitAlpha(element.backgroundColor).base, next) };
    }, currentFill !== 'transparent' ? { currentItemBackgroundColor: withAlpha(splitAlpha(currentFill).base, next) } : {});
  };

  // Shape switching, which this Excalidraw version does not have: boxes change outline in place (label, colours and
  // arrows stay attached), lines and arrows trade arrowheads, and a line given a direction becomes an arrow.
  const boxes = selected.length > 0 && selected.every((element) => BOX_TYPES.has(element.type));
  const linear = selected.length > 0 && selected.every((element) => element.type === 'line' || element.type === 'arrow');
  const pointsOf = (element: SceneElement) => ((element as { points?: ReadonlyArray<readonly [number, number]> }).points ?? []);
  const sideways = linear && isHorizontal(pointsOf(selected[0]));
  const setShape = (shape: BoxShape) => update((element) => {
    if (!selectedIds[element.id] || !BOX_TYPES.has(element.type)) return null;
    if (shape === 'rounded') return { type: 'rectangle', roundness: { type: 3 } };
    if (shape === 'rectangle') return { type: 'rectangle', roundness: null };
    return { type: shape, roundness: shape === 'diamond' ? { type: 2 } : null };
  }, {});
  const setDirection = (direction: 'none' | 'back' | 'forward' | 'both') => {
    const next = api.getSceneElements().map((element) => {
      const scene = element as unknown as SceneElement;
      if (!selectedIds[scene.id] || (scene.type !== 'line' && scene.type !== 'arrow')) return element;
      const heads = arrowheadsFor(direction, pointsOf(scene));
      if (scene.type === 'arrow' || direction === 'none') return newElementWith(element as never, heads as never);
      // A line pointed somewhere becomes an arrow; restore fills in the arrow-only fields. A new version marks it
      // changed, so it is saved (and undoable) like any other edit.
      const asArrow = { ...(element as object), ...heads, type: 'arrow', startBinding: null, endBinding: null, elbowed: false };
      const restored = restoreElements([asArrow] as never, null)[0] as unknown as { version: number };
      return { ...restored, version: restored.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() };
    });
    api.updateScene({ elements: next as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };
  const choice = (label: string, title: string, onPick: () => void) => (
    <button
      key={label}
      type="button"
      title={title}
      aria-label={title}
      onClick={onPick}
      className="min-w-7 rounded border border-border px-1.5 py-0.5 text-xs text-foreground hover:border-primary hover:bg-muted"
    >
      {label}
    </button>
  );

  const swatch = (color: string, onPick: (color: string) => void, label: string) => (
    <button
      key={color}
      type="button"
      title={label}
      aria-label={label}
      onClick={() => onPick(color)}
      className="h-5 w-5 rounded border border-border/70 hover:scale-110"
      style={color === 'transparent'
        ? { backgroundImage: 'linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)', backgroundSize: '8px 8px', backgroundPosition: '0 0,4px 4px', backgroundColor: '#fff', filter: isDark ? DARK_FILTER : undefined }
        : { backgroundColor: color, filter: isDark ? DARK_FILTER : undefined }}
    />
  );
  const custom = (onPick: (color: string) => void, label: string) => (
    <label title={label} className="relative flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-dashed border-border text-[10px] text-muted-foreground hover:border-primary">
      ＋
      <input type="color" aria-label={label} onChange={(event) => onPick(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
    </label>
  );
  const row = (title: string, colors: string[], onPick: (color: string) => void, customLabel: string) => (
    <div>
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1">
        {colors.map((color) => swatch(color, onPick, `${title} ${color === 'transparent' ? '透明' : color === DEFAULT_STROKE ? '黑／白（跟著深淺色）' : color}`))}
        {custom(onPick, customLabel)}
      </div>
    </div>
  );

  return (
    <div className="relative w-[13.5rem] space-y-2 rounded-lg border border-border bg-background/95 p-2.5 shadow-lg" aria-label="更多顏色">
      <button
        type="button"
        onClick={onClose}
        aria-label="收起顏色"
        title="收起（按「顏色」再打開）"
        className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {boxes && (
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">形狀</p>
          <div className="flex flex-wrap gap-1">
            {choice('方', '換成方框', () => setShape('rectangle'))}
            {choice('圓角', '換成圓角方框', () => setShape('rounded'))}
            {choice('圓', '換成圓形', () => setShape('ellipse'))}
            {choice('菱', '換成菱形', () => setShape('diamond'))}
          </div>
        </div>
      )}
      {linear && (
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">線／箭頭</p>
          <div className="flex flex-wrap gap-1">
            {choice('—', '無箭頭（線）', () => setDirection('none'))}
            {sideways ? choice('←', '向左', () => setDirection('back')) : choice('↑', '向上', () => setDirection('back'))}
            {sideways ? choice('→', '向右', () => setDirection('forward')) : choice('↓', '向下', () => setDirection('forward'))}
            {choice(sideways ? '↔' : '↕', '雙向', () => setDirection('both'))}
          </div>
        </div>
      )}
      {row('框線／筆畫', STROKES, setStroke, '自訂框線色')}
      {row('填色', FILLS, setFill, '自訂填色')}
      {selected.some((element) => element.type === 'text' || (element.boundElements ?? []).some((bound) => bound.type === 'text')) &&
        row('文字', STROKES, setText, '自訂文字色')}
      <div>
        <p className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
          <span>填色透明度</span>
          <span className="tabular-nums">{fillIsEmpty ? '—' : `${alpha}%`}</span>
        </p>
        <input
          type="range"
          aria-label="填色透明度"
          min={0}
          max={100}
          step={5}
          value={fillIsEmpty ? 100 : alpha}
          disabled={fillIsEmpty}
          onChange={(event) => setAlpha(Number(event.target.value))}
          className={cn('w-full accent-primary', fillIsEmpty && 'opacity-40')}
        />
      </div>
    </div>
  );
}
