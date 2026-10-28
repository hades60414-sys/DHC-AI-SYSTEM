import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * DHC CLI 10/13, end to end on a throwaway home and database: creating a session names it with the creation phrase;
 * syncing its transcript renames it to Claude Code's ai-title (simplified characters made traditional); a session the
 * user renamed, and a session older than the rollout, keep their names.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dhc-title-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.DATABASE_PATH = path.join(home, 'auth.db');

const projectDir = path.join(home, '.claude', 'projects', 'C--work');
fs.mkdirSync(projectDir, { recursive: true });
const cwd = path.join(home, 'work');
fs.mkdirSync(cwd, { recursive: true });

const transcript = (providerId: string, prompt: string, title: string) => [
  JSON.stringify({ type: 'user', sessionId: providerId, cwd, message: { role: 'user', content: prompt }, timestamp: new Date().toISOString() }),
  JSON.stringify({ type: 'ai-title', sessionId: providerId, aiTitle: title }),
].join('\n') + '\n';

test('new sessions get the creation phrase, then the ai-title; typed names and old sessions stay', async () => {
  const { initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
  const { ClaudeSessionSynchronizer } = await import('@/modules/providers/list/claude/claude-session-synchronizer.provider.js');
  const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
  await initializeDatabase();
  const prompt = '幫我規劃這個待辦任務：資安疑慮 子任務：去識別層 先弄清楚目標和範圍';

  // A session from before the rollout (the table stores whole seconds).
  sessionsDb.createAppSession('app-old', 'claude', cwd, prompt);
  sessionsDb.assignProviderSessionId('app-old', 'prov-old');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  // Whole seconds, like the table.
  process.env.DHC_AUTO_TITLE_SINCE = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();

  const created = sessionsService.createAppSession('claude', cwd, prompt);
  const creationName = sessionsDb.getSessionById(created.sessionId)?.custom_name ?? '';
  assert.ok(!creationName.startsWith('幫我'), `the creation phrase drops the greeting: ${creationName}`);
  sessionsDb.assignProviderSessionId(created.sessionId, 'prov-new');

  sessionsDb.createAppSession('app-typed', 'claude', cwd, '我自己取的名字');
  sessionsDb.assignProviderSessionId('app-typed', 'prov-typed');

  const files = {
    old: path.join(projectDir, 'prov-old.jsonl'),
    fresh: path.join(projectDir, 'prov-new.jsonl'),
    typed: path.join(projectDir, 'prov-typed.jsonl'),
  };
  fs.writeFileSync(files.old, transcript('prov-old', prompt, '舊對話的標題'));
  fs.writeFileSync(files.fresh, transcript('prov-new', prompt, '去识别层资安疑虑'));
  fs.writeFileSync(files.typed, transcript('prov-typed', '隨便問一句', '別的標題'));

  const synchronizer = new ClaudeSessionSynchronizer();
  for (const file of Object.values(files)) await synchronizer.synchronizeFile(file);

  assert.equal(sessionsDb.getSessionById(created.sessionId)?.custom_name, '去識別層資安疑慮', 'renamed to the ai-title, made traditional');
  assert.equal(sessionsDb.getSessionById('app-typed')?.custom_name, '我自己取的名字', 'a name the user typed is kept');
  assert.equal(sessionsDb.getSessionById('app-old')?.custom_name, prompt, 'a session from before the rollout is not touched');

  // Renaming by hand afterwards sticks: the next sync must not put the ai-title back.
  sessionsDb.updateSessionCustomName(created.sessionId, '資安：去識別層');
  fs.appendFileSync(files.fresh, JSON.stringify({ type: 'ai-title', sessionId: 'prov-new', aiTitle: '去識別層資安疑慮 v2' }) + '\n');
  await new ClaudeSessionSynchronizer().synchronizeFile(files.fresh);
  assert.equal(sessionsDb.getSessionById(created.sessionId)?.custom_name, '資安：去識別層');
});
