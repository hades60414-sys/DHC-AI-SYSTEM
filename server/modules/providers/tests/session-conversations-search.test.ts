import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';

async function withIsolatedDatabase(runTest: (workspace: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'conversation-search-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Writes a one-message Claude transcript and indexes it; returns the app session id and its project id. */
async function addClaudeSession(
  workspace: string,
  options: { providerId: string; project: string; title: string; text: string; updatedAt?: string },
): Promise<{ sessionId: string; projectId: string }> {
  const projectPath = path.join(workspace, options.project);
  const jsonlPath = path.join(workspace, `${options.providerId}.jsonl`);
  const entry = {
    type: 'user',
    sessionId: options.providerId,
    uuid: `${options.providerId}-u1`,
    timestamp: '2026-10-05T03:00:00.000Z',
    message: { role: 'user', content: options.text },
  };
  await writeFile(jsonlPath, `${JSON.stringify(entry)}\n`);

  const sessionId = sessionsDb.createSession(
    options.providerId,
    'claude',
    projectPath,
    options.title,
    options.updatedAt,
    options.updatedAt,
    jsonlPath,
  );
  const storedPath = sessionsDb.getSessionById(sessionId)?.project_path ?? projectPath;
  const projectId = projectsDb.getProjectPath(storedPath)?.project_id;
  assert.ok(projectId, 'fixture project must be registered');
  return { sessionId, projectId };
}

const matchedSessionIds = (results: Awaited<ReturnType<typeof searchConversations>>['results']): string[] =>
  results.flatMap((project) => project.sessions.map((session) => session.sessionId));

test('space-separated words match when each appears anywhere in the message, CJK included', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const { sessionId } = await addClaudeSession(workspace, {
      providerId: 'cjk-session',
      project: 'desk',
      title: '晨會',
      text: '請問 VaR限額怎麼算？',
    });

    const { results } = await searchConversations('限額 var');

    assert.deepEqual(matchedSessionIds(results), [sessionId]);
    const [match] = results[0].sessions[0].matches;
    const highlighted = match.highlights.map(({ start, end }) => match.snippet.slice(start, end));
    assert.deepEqual(highlighted, ['VaR限額']);
  });
});

test('a message missing one of the words does not match', async () => {
  await withIsolatedDatabase(async (workspace) => {
    await addClaudeSession(workspace, {
      providerId: 'partial-session',
      project: 'desk',
      title: '晨會',
      text: '請問 VaR 怎麼算？',
    });

    const { results } = await searchConversations('限額 var');

    assert.deepEqual(results, []);
  });
});

test('session titles match every word in any order', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const { sessionId } = await addClaudeSession(workspace, {
      providerId: 'title-session',
      project: 'desk',
      title: '問 DB2：VaR 限額怎麼算？',
      text: 'unrelated',
    });

    const { titleResults } = await searchConversations('限額 var');

    assert.deepEqual(titleResults.map((result) => result.sessionId), [sessionId]);
  });
});

test('projectIds limits both title and content results to those projects', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const visible = await addClaudeSession(workspace, {
      providerId: 'visible-session',
      project: 'desk',
      title: '報表 visible',
      text: '月報表',
    });
    await addClaudeSession(workspace, {
      providerId: 'batch-session',
      project: 'batch-run',
      title: '報表 batch',
      text: '月報表',
    });

    const scoped = await searchConversations('報表', 50, null, null, null, [visible.projectId]);

    assert.deepEqual(matchedSessionIds(scoped.results), [visible.sessionId]);
    assert.deepEqual(scoped.titleResults.map((result) => result.sessionId), [visible.sessionId]);

    const unscoped = await searchConversations('報表');
    assert.equal(matchedSessionIds(unscoped.results).length, 2, 'no projectIds still searches everything');
  });
});

test('the most recently active project is searched first', async () => {
  await withIsolatedDatabase(async (workspace) => {
    // Indexed first, so table order alone would put it first.
    const old = await addClaudeSession(workspace, {
      providerId: 'old-session',
      project: 'old-project',
      title: 'old',
      text: '對帳',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const recent = await addClaudeSession(workspace, {
      providerId: 'recent-session',
      project: 'recent-project',
      title: 'recent',
      text: '對帳',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });

    const { results } = await searchConversations('對帳', 1);

    assert.deepEqual(matchedSessionIds(results), [recent.sessionId]);
    assert.notEqual(recent.sessionId, old.sessionId);
  });
});
