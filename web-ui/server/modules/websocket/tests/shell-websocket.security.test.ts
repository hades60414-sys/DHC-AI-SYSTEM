import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

// SEC-01：Shell WebSocket 的工作區邊界與撤權（fake PTY，不啟動真 shell）。

function createSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number; frames: string[]; closed: { code?: number; reason?: string } | null;
    send: (data: string) => void; close: (code?: number, reason?: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.closed = null;
  socket.send = (data: string) => socket.frames.push(data);
  socket.close = (code?: number, reason?: string) => { socket.closed = { code, reason }; socket.readyState = WebSocket.CLOSED; };
  return socket;
}

function createPty() {
  return {
    writes: [] as string[], killed: false,
    onData() { return { dispose: () => undefined }; },
    onExit() { return { dispose: () => undefined }; },
    write(data: string) { this.writes.push(data); },
    resize() {},
    kill() { this.killed = true; },
  };
}

const init = (projectPath: string, sessionId: string) => JSON.stringify({
  type: 'init', projectPath, sessionId, hasSession: false, provider: 'plain-shell', isPlainShell: true, initialCommand: '/bin/sh',
});

test('預設邊界：WORKSPACES_ROOT 之外的目錄不啟動 PTY，回 Invalid project path', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'dhc-sec01-outside-'));
  try {
    const socket = createSocket();
    let spawned = 0;
    handleShellConnection(socket as never, { resolveProviderSessionId: () => null, spawnPty: () => { spawned += 1; return createPty() as never; } });
    socket.emit('message', init(outside, `outside-${Date.now()}`));
    assert.equal(spawned, 0);
    assert.deepEqual(socket.frames.map(frame => JSON.parse(frame)), [{ type: 'error', message: 'Invalid project path' }]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('撤權：主體失效後下一則輸入不寫入 PTY，PTY 被終止，連線以 4401 關閉', () => {
  const socket = createSocket();
  const pty = createPty();
  let active = true;
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => null, isProjectPathAllowed: () => true, spawnPty: () => pty as never, isPrincipalActive: () => active,
  });
  socket.emit('message', init(process.cwd(), `revoke-${Date.now()}`));
  socket.emit('message', JSON.stringify({ type: 'input', data: 'echo before\n' }));
  assert.deepEqual(pty.writes, ['echo before\n']);
  active = false;
  socket.emit('message', JSON.stringify({ type: 'input', data: 'echo after\n' }));
  assert.deepEqual(pty.writes, ['echo before\n']);
  assert.equal(pty.killed, true);
  assert.deepEqual(socket.closed, { code: 4401, reason: 'principal revoked' });
});

test('撤權：連線一開始主體就已失效時，init 不啟動任何 PTY', () => {
  const socket = createSocket();
  let spawned = 0;
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => null, isProjectPathAllowed: () => true, isPrincipalActive: () => false,
    spawnPty: () => { spawned += 1; return createPty() as never; },
  });
  socket.emit('message', init(process.cwd(), `revoked-init-${Date.now()}`));
  assert.equal(spawned, 0);
  assert.equal(socket.closed?.code, 4401);
});
