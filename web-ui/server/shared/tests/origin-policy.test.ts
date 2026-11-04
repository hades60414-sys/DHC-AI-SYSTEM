// Security audit 2026-11-04: regression tests for SEC-WEB-01 / SEC-WEB-02.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import cors from 'cors';
import express from 'express';

import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import {
  checkPlatformModeBinding,
  createOriginGuard,
  isOriginAllowed,
  parseAllowedOrigins,
} from '@/shared/origin-policy.js';

const none = new Set<string>();

test('requests without Origin (curl, Electron main, node ws) are allowed', () => {
  assert.equal(isOriginAllowed(undefined, '127.0.0.1:3001', none), true);
  assert.equal(isOriginAllowed('', '127.0.0.1:3001', none), true);
});

test('loopback origins on any port are allowed', () => {
  for (const o of ['http://localhost:5173', 'http://127.0.0.1:3001', 'http://[::1]:5173', 'http://127.1.2.3', 'http://app.localhost:8080']) {
    assert.equal(isOriginAllowed(o, '127.0.0.1:3001', none), true, o);
  }
});

test('same-origin (Origin host === Host header) is allowed for LAN/tunnel deployments', () => {
  assert.equal(isOriginAllowed('https://cc.example.org', 'cc.example.org', none), true);
  assert.equal(isOriginAllowed('http://192.168.1.20:3001', '192.168.1.20:3001', none), true);
});

test('foreign, opaque and non-http origins are rejected', () => {
  assert.equal(isOriginAllowed('https://evil.example', '127.0.0.1:3001', none), false);
  assert.equal(isOriginAllowed('http://localhost.evil.example', '127.0.0.1:3001', none), false);
  assert.equal(isOriginAllowed('http://127.0.0.1.evil.example', '127.0.0.1:3001', none), false);
  assert.equal(isOriginAllowed('null', '127.0.0.1:3001', none), false);
  assert.equal(isOriginAllowed('file://', '127.0.0.1:3001', none), false);
  assert.equal(isOriginAllowed('not a url', '127.0.0.1:3001', none), false);
});

test('DHC_ALLOWED_ORIGINS adds exact origins only', () => {
  const allowed = parseAllowedOrigins(' https://ui.example.com , bogus, http://10.0.0.5:8080 ');
  assert.equal(isOriginAllowed('https://ui.example.com', '127.0.0.1:3001', allowed), true);
  assert.equal(isOriginAllowed('http://10.0.0.5:8080', '127.0.0.1:3001', allowed), true);
  assert.equal(isOriginAllowed('https://sub.ui.example.com', '127.0.0.1:3001', allowed), false);
  assert.equal(isOriginAllowed('http://ui.example.com', '127.0.0.1:3001', allowed), false);
});

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createOriginGuard(none));
  app.use(cors({ origin: true }));
  app.use(express.json());
  let registered = 0;
  app.post('/api/auth/register', (_req, res) => {
    registered += 1;
    res.json({ token: 'jwt' });
  });
  app.get('/count', (_req, res) => res.json({ registered }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('drive-by page cannot register the first account (repro of SEC-WEB-01)', async () => {
  await withServer(async (base) => {
    const evil = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ username: 'evil', password: 'evilpass' }),
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${base}/api/auth/register`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 403);

    const count = await (await fetch(`${base}/count`)).json();
    assert.deepEqual(count, { registered: 0 });

    const local = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: '{}',
    });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });
});

function wsInfo(origin: string | undefined, token?: string) {
  const url = token ? `/shell?token=${token}` : '/shell';
  return {
    origin: origin ?? '',
    secure: false,
    req: { url, headers: { host: '127.0.0.1:3001', ...(origin ? { origin } : {}) } },
  } as unknown as Parameters<typeof verifyWebSocketClient>[0];
}

test('WebSocket upgrade from a foreign origin is rejected even with a valid token / platform mode', () => {
  const user = { id: 1, username: 'u' };
  const deps = { isPlatform: false, allowedOrigins: none, authenticateWebSocket: (t: string | null) => (t === 'good' ? user : null) };
  assert.equal(verifyWebSocketClient(wsInfo('https://evil.example', 'good'), deps), false);
  assert.equal(verifyWebSocketClient(wsInfo('http://localhost:5173', 'good'), deps), true);
  assert.equal(verifyWebSocketClient(wsInfo(undefined, 'good'), deps), true);
  assert.equal(verifyWebSocketClient(wsInfo('http://localhost:5173', 'bad'), deps), false);

  const platform = { isPlatform: true, allowedOrigins: none, authenticateWebSocket: () => user };
  assert.equal(verifyWebSocketClient(wsInfo('https://evil.example'), platform), false);
  assert.equal(verifyWebSocketClient(wsInfo('http://127.0.0.1:3001'), platform), true);
});

test('platform (no-auth) mode refuses non-loopback bind unless explicitly trusted (SEC-WEB-02)', () => {
  assert.equal(checkPlatformModeBinding(false, '0.0.0.0', {}), null);
  assert.equal(checkPlatformModeBinding(true, '127.0.0.1', {}), null);
  assert.equal(checkPlatformModeBinding(true, 'localhost', {}), null);
  assert.equal(checkPlatformModeBinding(true, '::1', {}), null);
  assert.equal(checkPlatformModeBinding(true, '[::1]', {}), null);
  assert.match(checkPlatformModeBinding(true, '0.0.0.0', {}) ?? '', /Refusing to start/);
  assert.match(checkPlatformModeBinding(true, '::', {}) ?? '', /Refusing to start/);
  assert.match(checkPlatformModeBinding(true, '192.168.1.5', {}) ?? '', /Refusing to start/);
  assert.equal(checkPlatformModeBinding(true, '0.0.0.0', { DHC_PLATFORM_TRUSTED_PROXY: '1' }), null);
});
