import type { CommandFrame } from '@/modules/command-mode/protocol';
import { commandModeStore } from '@/modules/command-mode/store';
import { planAttachment, type AttachmentPlan, type Stroke } from '@/modules/command-mode/strokes';

export type CommandModeAttachment = {
  file: File;
  note: string;
  plan: AttachmentPlan;
};

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('畫面圖片讀不出來'));
  image.src = src;
});

const dataUrlToFile = async (dataUrl: string, name: string) => {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: 'image/jpeg' });
};

/** 把圈點畫上去：紅色粗線，點畫成圓圈，多筆時在起點標上順序數字。 */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], width: number, height: number): void {
  const line = Math.max(4, Math.round(width / 240));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokes.forEach((stroke, index) => {
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.95)';
    ctx.lineWidth = line;
    const pts = stroke.points.map((p) => [p.x * width, p.y * height] as const);
    if (stroke.shape === 'dot' || pts.length < 2) {
      const [x, y] = pts[0] ?? [0, 0];
      ctx.beginPath();
      ctx.arc(x, y, line * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(239, 68, 68, 0.95)';
      ctx.beginPath();
      ctx.arc(x, y, line, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
      if (stroke.shape === 'circle') ctx.closePath();
      ctx.stroke();
    }
    if (strokes.length > 1) {
      const [x, y] = pts[0] ?? [0, 0];
      const r = line * 3.5;
      ctx.fillStyle = 'rgba(239, 68, 68, 1)';
      ctx.beginPath();
      ctx.arc(x - r, y - r, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), x - r, y - r);
    }
  });
}

async function renderAnnotated(frame: CommandFrame, strokes: Stroke[], name: string): Promise<File> {
  const image = await loadImage(frame.dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器不支援畫布');
  ctx.drawImage(image, 0, 0, frame.width, frame.height);
  drawStrokes(ctx, strokes.filter((s) => s.source === 'phone'), frame.width, frame.height);
  return dataUrlToFile(canvas.toDataURL('image/jpeg', 0.85), name);
}

/**
 * 語音句子送出前呼叫：依這句期間的圈點決定附哪張圖，並做出圖片檔。
 * 送出成功後要呼叫 commitCommandModeTurn，下一句才不會重複附。
 */
export async function prepareCommandModeAttachment(now = Date.now()): Promise<CommandModeAttachment | null> {
  const s = commandModeStore.get();
  if (!s.callLive) return null;
  const plan = planAttachment(s, now);
  if (!plan) return null;
  const name = `指揮模式-${new Date(now).toISOString().replace(/[:.]/g, '-')}.jpg`;
  try {
    const file = plan.kind === 'annotated'
      ? await renderAnnotated(plan.frame, plan.strokes, name)
      : await dataUrlToFile(plan.frame.dataUrl, name);
    return { file, note: plan.note, plan };
  } catch (error) {
    console.error('[command-mode] 附圖失敗', error);
    return null;
  }
}

export function commitCommandModeTurn(attachment: CommandModeAttachment | null, now = Date.now()): void {
  commandModeStore.commitTurn(attachment?.plan ?? null, now);
}
