import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createEnterpriseSecurityHeaders, inlineScriptHashes } from '../enterprise-security-headers.js';

test('企業模式安全標頭：CSP 只以 hash 放行實際內嵌片段，不含 unsafe-inline script；禁止嵌入與 sniff', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dhc-csp-'));
  try {
    const snippet = "\n  navigator.serviceWorker.register('/sw.js');\n";
    const file = path.join(dir, 'index.html');
    await writeFile(file, `<html><script type="module" src="/a.js"></script><script>${snippet}</script></html>`);
    const expected = `'sha256-${createHash('sha256').update(snippet).digest('base64')}'`;
    assert.deepEqual(inlineScriptHashes(file), [expected]);
    const headers: Record<string, string> = {};
    let nextCalled = false;
    createEnterpriseSecurityHeaders({ indexHtmlPath: file })({} as never, { setHeader: (k: string, v: string) => { headers[k] = v; } } as never, () => { nextCalled = true; });
    assert.ok(nextCalled);
    const scriptSrc = headers['Content-Security-Policy'].split('; ').find(part => part.startsWith('script-src'))!;
    assert.equal(scriptSrc, `script-src 'self' ${expected}`);
    assert.ok(!scriptSrc.includes('unsafe-inline'));
    assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['Referrer-Policy'], 'no-referrer');
    assert.deepEqual(inlineScriptHashes(path.join(dir, 'missing.html')), [], '沒有建置檔時不放行任何內嵌 script');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
