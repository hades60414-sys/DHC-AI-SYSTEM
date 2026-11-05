import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * DHC CLI 10/24 開對話建議模型: before or beside a new conversation's first send, a Haiku judge (an external judge.cjs,
 * task session-model) says whether Sonnet is enough. Its money/SQL/code rules only raise the answer to Opus. Off
 * unless the switch file exists; off, a timeout or any error answers 'opus', which is what every chat ran with before.
 */
export type ModelAdvice = {
  advice: 'sonnet' | 'opus';
  reason: string;
  confidence: number;
  source: string;
  ms: number;
};

type Judge = (task: string, input: unknown, opts: unknown) => Promise<{ choice: string; reason?: string; confidence?: number; source?: string }>;

const judgePath = () => path.resolve(process.env.MODEL_ADVICE_JUDGE || path.join(os.homedir(), '.dhc', 'judge.cjs'));
const switchPath = () => process.env.MODEL_ADVICE_SWITCH || 'C:\\Users\\demo\\.cloudcli\\model-advice-on';
const TIMEOUT_MS = 6000;
const MAX_TEXT = 1500;

export async function adviseModel(body: unknown): Promise<ModelAdvice> {
  const started = Date.now();
  const opus = (source: string, reason = ''): ModelAdvice => ({ advice: 'opus', reason, confidence: 0, source, ms: Date.now() - started });
  if (!existsSync(switchPath()) || !existsSync(judgePath())) return opus('off');

  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const text = typeof input.text === 'string' ? input.text.slice(0, MAX_TEXT) : '';
  if (!text.trim()) return opus('empty');
  const project = String(input.projectPath ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

  let timer: NodeJS.Timeout | undefined;
  try {
    const { judge } = createRequire(import.meta.url)(judgePath()) as { judge: Judge };
    const verdict = await Promise.race([
      judge('session-model', { text, project, hasAttachment: input.hasAttachment === true }, { timeoutMs: TIMEOUT_MS }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS); }),
    ]);
    return {
      advice: verdict.choice === 'sonnet' ? 'sonnet' : 'opus',
      reason: String(verdict.reason ?? '').slice(0, 200),
      confidence: Number(verdict.confidence) || 0,
      source: String(verdict.source ?? ''),
      ms: Date.now() - started,
    };
  } catch (error) {
    console.error('[model-advice] judge failed:', (error as Error)?.message);
    return opus('error', String((error as Error)?.message ?? '').slice(0, 120));
  } finally {
    clearTimeout(timer);
  }
}
