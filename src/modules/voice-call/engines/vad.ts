export type BargeInSensitivity = 'low' | 'medium' | 'high';

/**
 * listen：一般聆聽。guard：喇叭正在念，麥克風收到的多半是自己的回音，門檻改成「比最近的回音峰值大很多」
 * 而且要持續夠久才算使用者在講話。
 */
export type VadMode = 'listen' | 'guard';

export type VadEvent =
  /** 可能有人開口：從這一格（加上前置緩衝）開始收音。 */
  | { type: 'onset'; at: number }
  /** 確認是講話。bargeIn 表示是在朗讀中確認的（插話）。 */
  | { type: 'confirm'; bargeIn: boolean }
  /** 只是雜音或回音，丟掉這段。 */
  | { type: 'discard' }
  /** 講完了；speechEndAt 是最後一格有聲音的時間。 */
  | { type: 'end'; speechEndAt: number };

const MIN_THRESHOLD = 0.015;
const ONSET_MS = 200;
const ONSET_GRACE_MS = 150; // 音節之間短暫變小聲，不能把還沒確認的一段丟掉
const SILENCE_END_MS = 1500; // 700 會把講話換氣切成好幾句分開送出（2026-10-31 使用者回報）

// 回音峰值大約 1.5 秒衰減一半：念到句間停頓時門檻不會掉太快。
const ECHO_HALF_LIFE_MS = 1500;
// 開始出聲後先只學回音大小，不判插話；喇叭剛響的第一個字最容易被誤認成使用者。
export const GUARD_WARMUP_MS = 400;
const GUARD_GRACE_MS = 120;

export const GUARD_TUNING: Record<BargeInSensitivity, { min: number; ratio: number; onsetMs: number }> = {
  low: { min: 0.05, ratio: 2.0, onsetMs: 450 },
  medium: { min: 0.035, ratio: 1.6, onsetMs: 350 },
  high: { min: 0.025, ratio: 1.3, onsetMs: 260 },
};

type Segment = { state: 'idle' } | { state: 'candidate'; since: number; lastLoud: number; peak: number; guarded: boolean } | { state: 'speech'; lastLoud: number };

/** 能量式的講話偵測，只吃「這一格的音量與時間」，不碰任何音訊 API，方便測試。 */
export class VoiceActivityDetector {
  private mode: VadMode = 'listen';
  private segment: Segment = { state: 'idle' };
  private noiseFloor = 0.005;
  private echoPeak = 0;
  private guardSince = 0;
  private lastAt: number | null = null;

  constructor(private readonly sensitivity: BargeInSensitivity = 'medium') {}

  get current(): VadMode {
    return this.mode;
  }

  /** 已經在 guard 時再呼叫不會重新暖機，每句朗讀開始都可以放心呼叫。 */
  setMode(mode: VadMode, now: number): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'guard') {
      this.guardSince = now;
      this.echoPeak = 0;
    }
  }

  /** 中斷目前這段（暫停麥克風時）。 */
  reset(): void {
    this.segment = { state: 'idle' };
  }

  private threshold(): number {
    const listen = Math.max(MIN_THRESHOLD, this.noiseFloor * 3);
    if (this.mode === 'listen') return listen;
    const tune = GUARD_TUNING[this.sensitivity];
    return Math.max(listen, tune.min, this.echoPeak * tune.ratio);
  }

  feed(rms: number, now: number): VadEvent | null {
    const dt = this.lastAt === null ? 0 : Math.max(0, now - this.lastAt);
    this.lastAt = now;
    const seg = this.segment;
    const guarding = this.mode === 'guard';

    if (seg.state === 'idle') {
      if (guarding) {
        this.echoPeak *= 0.5 ** (dt / ECHO_HALF_LIFE_MS);
        // 先跟「這一格之前」的回音峰值比，沒過門檻才把這一格算進回音。
        const warmingUp = now - this.guardSince < GUARD_WARMUP_MS;
        if (warmingUp || rms < this.threshold()) {
          this.echoPeak = Math.max(this.echoPeak, rms);
          return null;
        }
      } else {
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
        if (rms < this.threshold()) return null;
      }
      this.segment = { state: 'candidate', since: now, lastLoud: now, peak: rms, guarded: guarding };
      return { type: 'onset', at: now };
    }

    if (seg.state === 'candidate') {
      // 候選期間不更新回音峰值，免得使用者自己的聲音把門檻拉高。
      if (rms >= this.threshold()) {
        seg.lastLoud = now;
        seg.peak = Math.max(seg.peak, rms);
        const need = seg.guarded ? GUARD_TUNING[this.sensitivity].onsetMs : ONSET_MS;
        if (now - seg.since >= need) {
          this.segment = { state: 'speech', lastLoud: now };
          // 確認插話後回到一般聆聽：喇叭馬上會停，句尾要用一般門檻判斷。
          if (seg.guarded) this.mode = 'listen';
          return { type: 'confirm', bargeIn: seg.guarded };
        }
        return null;
      }
      if (now - seg.lastLoud >= (seg.guarded ? GUARD_GRACE_MS : ONSET_GRACE_MS)) {
        // 被丟掉的那段多半是回音尖峰；記進回音峰值，同樣的聲音下次就不會再觸發。
        if (seg.guarded) this.echoPeak = Math.max(this.echoPeak, seg.peak);
        this.segment = { state: 'idle' };
        return { type: 'discard' };
      }
      return null;
    }

    if (rms >= this.threshold()) seg.lastLoud = now;
    if (now - seg.lastLoud >= SILENCE_END_MS) {
      this.segment = { state: 'idle' };
      return { type: 'end', speechEndAt: seg.lastLoud };
    }
    return null;
  }
}
