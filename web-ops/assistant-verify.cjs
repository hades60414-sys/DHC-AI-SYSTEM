// 中台小助手 post-restart check: asks the assistant in a private test room and logs whether it answered.
// [quick] one Sonnet lookup; [handoff] agrees to a big job and expects a new Opus conversation linked in the reply,
// then archives that test conversation once it has answered.
// Room dm:dhc-assistant~dhc-verify is shown in nobody's private-chat list. Log: cc-web\assistant-verify.log
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:3001';
const ROOM = 'dm:dhc-assistant~dhc-verify';
const KEY = `dhc.chat:${ROOM}`;
const LOG = path.join(__dirname, 'assistant-verify.log');
const log = (line) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, url, body) {
  const response = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text };
}

async function askOnce(label, text) {
  const prefs = (await api('GET', '/api/user/preferences')).json?.preferences ?? {};
  const msgs = Array.isArray(prefs[KEY]?.msgs) ? prefs[KEY].msgs : [];
  const at = new Date().toISOString();
  const question = { id: `v${Date.now().toString(36)}`, by: 'dhc-verify', text, at, refs: [] };
  await api('PATCH', '/api/user/preferences', { [KEY]: { msgs: [...msgs, question].slice(-50) } });
  const ask = await api('POST', '/api/assistant/reply', { roomId: ROOM, triggerAt: at, profileId: 'dhc-verify' });
  log(`[${label}] reply POST ${ask.status} ${ask.text.slice(0, 200)}`);
  if (ask.status !== 202) { log(`[${label}] RESULT FAIL (not started)`); return null; }
  const started = Date.now();
  while (Date.now() - started < 600_000) {
    await sleep(5000);
    const running = (await api('GET', `/api/assistant/status?roomId=${encodeURIComponent(ROOM)}`)).json?.data?.running ?? [];
    if (running.length === 0) break;
  }
  const after = (await api('GET', '/api/user/preferences')).json?.preferences?.[KEY]?.msgs ?? [];
  const answer = after.find((message) => message.by === 'dhc-assistant' && message.replyTo === question.id);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (!answer) { log(`[${label}] RESULT FAIL (no answer after ${seconds}s)`); return null; }
  const ok = !answer.text.startsWith('這次沒回成');
  log(`[${label}] RESULT ${ok ? 'OK' : 'FAIL'} ${seconds}s order=${answer.at > at ? 'after' : 'BEFORE'} refs=${JSON.stringify(answer.refs || [])} :: ${answer.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  return answer;
}

(async () => {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await sleep(2000);
  }
  const html = await (await fetch(`${BASE}/`)).text();
  log(`bundle ${(/index-[\w-]+\.js/.exec(html) || ['?'])[0]}`);

  await askOnce('quick', '自動檢查：用 ragent_status 查 srv-db 代理程式版本，一句話回報版本號。');
  const handoff = await askOnce('handoff', '自動檢查（第 3 級）：這是一件大工作，我已經同意，請直接幫我開一個 Opus 對話。標題用「小助手開對話測試」，給它的訊息只要寫：「這是自動檢查開的對話，請只回一句『收到』，不要做別的事。」');
  const ref = (handoff?.refs || []).find((item) => item.kind === 'session');
  log(`[handoff] ${ref ? `SESSION ${ref.id}` : 'NO SESSION LINK'}`);
  if (!ref) return;
  // The test conversation only proves the handoff works; once it has answered, archive it so it doesn't sit in anyone's list.
  let answered = false;
  for (let i = 0; i < 24 && !answered; i += 1) {
    await sleep(5000);
    const history = (await api('GET', `/api/providers/sessions/${ref.id}/messages`)).text;
    answered = history.includes('收到');
  }
  const archive = await api('DELETE', `/api/providers/sessions/${ref.id}`);
  log(`[handoff] ${answered ? 'ANSWERED' : 'NO ANSWER in 120s'}; archive ${archive.status} ${archive.text.slice(0, 120)}`);
})().catch((error) => log(`RESULT FAIL (script) ${error.message}`));
