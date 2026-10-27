// Edge read-aloud neural voices (online; the script text is sent to Microsoft). Protocol as in node-edge-tts 1.2.10 (MIT).
// Writes <base>.mp3 and returns word timings [{t, d, text, offset}] with offset into the spoken text.
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { secMsGecV2 } from './edge-gec-v2.mjs';

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM = '143.0.3650.75';
const MAJOR = CHROMIUM.split('.')[0];

function secMsGec() {
  const ticks = (BigInt(Math.floor(Date.now() / 1000)) + 11644473600n) * 10000000n;
  return createHash('sha256').update(`${ticks - (ticks % 3000000000n)}${TOKEN}`, 'ascii').digest('hex').toUpperCase();
}
const xml = s => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const id = () => randomUUID().replaceAll('-', '');

export async function synth({ spoken, name = 'zh-TW-HsiaoChenNeural', rate = '+0%', pitch = '+0Hz', volume = '+0%' }, base) {
  const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
    + `?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGecV2(TOKEN)}&Sec-MS-GEC-Version=2-${CHROMIUM}&ConnectionId=${id()}`;
  const ws = new WebSocket(url, {
    headers: {
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
      Pragma: 'no-cache',
      Cookie: `muid=${randomUUID().replaceAll('-', '').toUpperCase()};`,
      'Cache-Control': 'no-cache',
    },
  });
  ws.binaryType = 'arraybuffer';
  const audio = [], words = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('edge tts timed out after 60s')); }, 60000);
    ws.onerror = e => { clearTimeout(timer); reject(new Error(`edge tts connection failed: ${e.message ?? e.type}`)); };
    ws.onopen = () => {
      ws.send('Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},'
        + '"outputFormat":"audio-24khz-96kbitrate-mono-mp3"}}}}');
      ws.send(`X-RequestId:${id()}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n`
        + `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW"><voice name="${name}">`
        + `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${xml(spoken)}</prosody></voice></speak>`);
    };
    ws.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        if (data.includes('Path:audio.metadata')) {
          for (const m of JSON.parse(data.slice(data.indexOf('\r\n\r\n') + 4)).Metadata ?? []) {
            if (m.Type === 'WordBoundary') words.push({ t: m.Data.Offset / 1e7, d: m.Data.Duration / 1e7, text: m.Data.text.Text });
          }
        } else if (data.includes('Path:turn.end')) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
        return;
      }
      const buf = Buffer.from(data);
      const head = buf.readUInt16BE(0);
      if (buf.subarray(2, 2 + head).toString().includes('Path:audio')) audio.push(buf.subarray(2 + head));
    };
  });
  if (!audio.length) throw new Error('edge tts returned no audio (voice name wrong or service changed)');
  const file = `${base}.mp3`;
  writeFileSync(file, Buffer.concat(audio));
  let pos = 0;
  for (const w of words) {
    const i = spoken.indexOf(w.text, pos);
    w.offset = i < 0 ? pos : i;
    if (i >= 0) pos = i + w.text.length;
  }
  return { file, words };
}
