import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { probeHealth } from './healthcheck.mjs';

async function withServer(handler, check) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await check(`http://127.0.0.1:${server.address().port}/health`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('200 + status ok 為存活', async () => {
  await withServer((_req, res) => res.end(JSON.stringify({status:'ok',version:'1.37.3'})),
    async url => { await probeHealth(url); });
});
test('500 即使 body 為 ok 也拒絕', async () => {
  await withServer((_req, res) => { res.writeHead(500); res.end('{"status":"ok"}'); },
    async url => { await assert.rejects(probeHealth(url), /HTTP 500/); });
});
test('不健康 body 拒絕', async () => {
  await withServer((_req, res) => res.end('{"status":"failed"}'),
    async url => { await assert.rejects(probeHealth(url), /status/); });
});
test('無效 JSON 拒絕', async () => {
  await withServer((_req, res) => res.end('<html>fallback</html>'),
    async url => { await assert.rejects(probeHealth(url)); });
});
test('逾時會失敗且不永久卡住', async () => {
  await withServer(() => {}, async url => { await assert.rejects(probeHealth(url, 50),
    error => error.name === 'TimeoutError'); });
});
test('連線中斷會失敗', async () => {
  await withServer((req) => req.socket.destroy(),
    async url => { await assert.rejects(probeHealth(url)); });
});
