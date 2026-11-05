import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { claimClientRequest, handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'dedupe-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withGateway(runTest: (context: { socket: ReturnType<typeof createFakeSocket>; runs: string[] }) => Promise<void>) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-send-dedupe-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const runs: string[] = [];
  const socket = createFakeSocket();
  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Dedupe session', now, now);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, command: string) => {
          runs.push(command);
        },
      } as never,
    });
    await runTest({ socket, runs });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

const send = (socket: ReturnType<typeof createFakeSocket>, frame: Record<string, unknown>) =>
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, ...frame }));

test('a resent turn with the same clientRequestId runs once and the copy is reported as a duplicate', async () => {
  await withGateway(async ({ socket, runs }) => {
    send(socket, { content: '查一下昨天的部位', clientRequestId: 'voice-turn-1' });
    await settle();
    send(socket, { content: '查一下昨天的部位', clientRequestId: 'voice-turn-1' });
    await settle();

    assert.deepEqual(runs, ['查一下昨天的部位']);
    const duplicates = socket.frames.filter((frame) => frame.kind === 'chat_send_duplicate');
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].clientRequestId, 'voice-turn-1');
    assert.equal(duplicates[0].sessionId, SESSION_ID);
  });
});

test('different clientRequestIds and frames without one are dispatched as before', async () => {
  await withGateway(async ({ socket, runs }) => {
    send(socket, { content: 'a', clientRequestId: 'voice-turn-a' });
    await settle();
    send(socket, { content: 'b', clientRequestId: 'voice-turn-b' });
    await settle();
    send(socket, { content: 'same text' });
    await settle();
    send(socket, { content: 'same text' });
    await settle();

    assert.deepEqual(runs, ['a', 'b', 'same text', 'same text']);
    assert.equal(socket.frames.some((frame) => frame.kind === 'chat_send_duplicate'), false);
  });
});

test('a claim expires after ten minutes and is scoped to its session', () => {
  const t0 = 1_000_000;
  assert.equal(claimClientRequest('s1', 'expiring', t0), true);
  assert.equal(claimClientRequest('s1', 'expiring', t0 + 60_000), false);
  assert.equal(claimClientRequest('s2', 'expiring', t0 + 60_000), true);
  assert.equal(claimClientRequest('s1', 'expiring', t0 + 10 * 60_000 + 1), true);
});
