export const WAV_RATE = 16_000;

/** 把麥克風的浮點取樣降到 16 kHz 單聲道 16-bit WAV（whisper 的原生格式，不用伺服器再轉檔）。 */
export function encodeWav(chunks: Float32Array[], inRate: number, outRate = WAV_RATE): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  const ratio = inRate / outRate;
  const outLength = Math.floor(total / ratio);
  const view = new DataView(new ArrayBuffer(44 + outLength * 2));
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + outLength * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, outLength * 2, true);
  for (let i = 0; i < outLength; i++) {
    // 取區間平均當作簡單的低通，避免降取樣產生疊頻。
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to && j < total; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
