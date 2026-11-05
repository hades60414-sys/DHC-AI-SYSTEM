import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createVoiceRouter } from '../voice.routes.js';
import { createVoiceService } from '../voice.service.js';

const defaults = {
  baseUrl: 'http://127.0.0.1:8178',
  apiKey: '',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
};
const audio = { bytes: Buffer.from('audio'), mimeType: 'audio/webm', fileName: 'recording.webm' };

function recordingService(callSttBaseUrl?: string) {
  const urls: string[] = [];
  const service = createVoiceService({
    defaults: { ...defaults, callSttBaseUrl },
    timeoutMs: 1_000,
    fetchBackend: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    },
  });
  return { service, urls };
}

test('a call transcription goes to the call transcriber when one is configured', async () => {
  const { service, urls } = recordingService('http://127.0.0.1:8179');
  await service.transcribe({ audio, overrides: {}, profile: 'call' });
  await service.transcribe({ audio, overrides: {} });
  assert.deepEqual(urls, ['http://127.0.0.1:8179/audio/transcriptions', 'http://127.0.0.1:8178/audio/transcriptions']);
  assert.deepEqual(service.getHealth(), { configured: true, callStt: true });
});

test('without a call transcriber the call profile uses the normal backend', async () => {
  const { service, urls } = recordingService('');
  await service.transcribe({ audio, overrides: {}, profile: 'call' });
  assert.deepEqual(urls, ['http://127.0.0.1:8178/audio/transcriptions']);
  assert.equal(service.getHealth().callStt, false);
});

test('the transcribe route reads profile=call from the query or the form', async () => {
  const profiles: Array<string | undefined> = [];
  const app = express();
  app.use('/api/voice', createVoiceRouter({
    voiceService: {
      getHealth: () => ({ configured: true, callStt: true }),
      transcribe: async (input) => {
        profiles.push(input.profile);
        return { ok: true, value: { text: '' } };
      },
      synthesizeSpeech: async () => ({ ok: false, status: 503, error: 'none' }),
    },
    parseAudioUpload: (request, _response, next) => {
      Object.assign(request, { file: { buffer: Buffer.from('a'), mimetype: 'audio/webm', originalname: 'a.webm' } });
      if (request.headers['x-form-profile']) Object.assign(request, { body: { profile: request.headers['x-form-profile'] } });
      next();
    },
  }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice`;
    await fetch(`${base}/transcribe?profile=call`, { method: 'POST' });
    await fetch(`${base}/transcribe`, { method: 'POST', headers: { 'x-form-profile': 'call' } });
    await fetch(`${base}/transcribe`, { method: 'POST' });
    await fetch(`${base}/transcribe?profile=other`, { method: 'POST' });
    const health = await (await fetch(`${base}/health`)).json() as { callStt?: boolean };
    assert.deepEqual(profiles, ['call', 'call', undefined, undefined]);
    assert.equal(health.callStt, true);
  } finally {
    server.close();
  }
});

test('long or unmeasured call clips ask the call transcriber for the full audio window', async () => {
  const windows: Array<string | null> = [];
  const service = createVoiceService({
    defaults: { ...defaults, callSttBaseUrl: 'http://127.0.0.1:8179' },
    timeoutMs: 1_000,
    fetchBackend: async (_url, options) => {
      windows.push((options.body as FormData).get('audio_ctx') as string | null);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    },
  });
  await service.transcribe({ audio, overrides: {}, profile: 'call', durationMs: 4_000 });
  await service.transcribe({ audio, overrides: {}, profile: 'call', durationMs: 20_000 });
  await service.transcribe({ audio, overrides: {}, profile: 'call' });
  await service.transcribe({ audio, overrides: {}, durationMs: 20_000 });
  assert.deepEqual(windows, [null, '1500', '1500', null]);
});
