import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TOOL_PROMPTS } from '@/modules/providers/services/tool-assist/prompts/index.js';
import {
  claudeArgs, extractToolAnswer, failureKind, memoryFiles, runCli, toolAssistService,
} from '@/modules/providers/services/tool-assist/tool-assist.service.js';

test('the answer JSON is found even inside a code fence, and plain text becomes the reply', () => {
  assert.deepEqual(extractToolAnswer('```json\n{"reply":"好","result":{"items":[]}}\n```'), { reply: '好', result: { items: [] }, lostResult: false });
  assert.deepEqual(extractToolAnswer('沒有 JSON'), { reply: '沒有 JSON', result: null, lostResult: false });
  assert.deepEqual(extractToolAnswer('{"reply":"只回答"}'), { reply: '只回答', result: null, lostResult: false });
});

test('every 工具庫 tool has instructions, and an unknown tool or empty request is refused before Claude runs', async () => {
  for (const tool of ['project-board', 'code-review', 'sheet-bench', 'doc-editor', 'tool-workshop', 'deck-studio']) {
    assert.ok(TOOL_PROMPTS[tool]?.length > 50, tool);
  }
  await assert.rejects(toolAssistService.assist({ tool: 'nope', message: 'x' }), /Unknown tool/);
  await assert.rejects(toolAssistService.assist({ tool: 'toString', message: 'x' }), /Unknown tool/);
  await assert.rejects(toolAssistService.assist({ tool: 'doc-editor', message: '  ' }), /Say what/);
});

const PAGE = '<!doctype html>\n<style>p { color: red; }</style>\n<p>"引號" {大括號}</p>';
const filled = { reply: '做好了', result: { name: '計算機', html: PAGE }, lostResult: false };

test('a long page written after the JSON fills the "@@BLOCK@@" string, whatever the fences look like', () => {
  const json = '{"reply":"做好了","result":{"name":"計算機","html":"@@BLOCK@@"}}';
  assert.deepEqual(extractToolAnswer(`${json}\n\`\`\`html\n${PAGE}\n\`\`\``), filled);
  assert.deepEqual(extractToolAnswer(`${json}\r\n\`\`\`html\r\n${PAGE.replace(/\n/g, '\r\n')}\r\n\`\`\`\r\n`), filled, 'CRLF');
  assert.deepEqual(extractToolAnswer(`${json}\n\`\`\`html\n${PAGE}\n`), filled, 'closing fence missing');
  assert.deepEqual(extractToolAnswer(`${json}\n\n${PAGE}\n`), filled, 'no fence at all');
  assert.deepEqual(extractToolAnswer(`\`\`\`json\n${json}\n\`\`\`\n\`\`\`html\n${PAGE}\n\`\`\``), filled, 'JSON in its own fence');
  assert.deepEqual(extractToolAnswer(`思考：先寫 JSON。${json}\n\`\`\`\n${PAGE}\n\`\`\``), filled, 'stray sentence, bare fence');
});

test('a result that cannot be read is reported as lost instead of silently becoming a plain reply', () => {
  assert.deepEqual(
    extractToolAnswer('{"reply":"做好了","result":{"name":"x","html":"@@BLOCK@@"}}'),
    { reply: '做好了', result: null, lostResult: true },
  );
  assert.deepEqual(
    extractToolAnswer('{"reply":"已更新清單","result":{"items":[{"id":"a",}]}}'),
    { reply: '已更新清單', result: null, lostResult: true },
  );
});

test('Claude CLI messages are sorted into quota, login and other', () => {
  assert.equal(failureKind("You've hit your limit · resets 11am"), 'quota');
  assert.equal(failureKind('Claude AI usage limit reached|1761300000'), 'quota');
  assert.equal(failureKind('Invalid API key · Please run /login'), 'auth');
  assert.equal(failureKind('OAuth token has expired. Please obtain a new token'), 'auth');
  assert.equal(failureKind('Not logged in · Please run /login'), 'auth');
  assert.equal(failureKind('API Error: 500 overloaded'), 'other');
});

const node = process.execPath;
const env = { ...process.env };

test('runCli answers with the result, and says why when there is none', async () => {
  assert.equal(await runCli(node, ['-e', 'process.stdout.write(JSON.stringify({result: require("fs").readFileSync(0, "utf8")}))'], '回聲', { env }), '回聲');
  await assert.rejects(
    runCli(node, ['-e', 'process.stdout.write(JSON.stringify({is_error: true, result: "Claude AI usage limit reached|1"})); process.exit(1)'], '', { env }),
    (error: Error & { kind?: string }) => error.kind === 'quota' && /usage limit/.test(error.message),
  );
  await assert.rejects(
    runCli(node, ['-e', 'console.error("Invalid API key · Please run /login"); process.exit(1)'], '', { env }),
    (error: Error & { kind?: string }) => error.kind === 'auth',
  );
  await assert.rejects(
    runCli(node, ['-e', 'process.stdout.write("not json")'], '', { env }),
    (error: Error & { kind?: string }) => error.kind === 'format',
  );
  await assert.rejects(
    runCli(node, ['-e', 'setTimeout(() => {}, 60000)'], '', { env, timeoutMs: 300 }),
    (error: Error & { kind?: string }) => error.kind === 'timeout',
  );
});

test('aborting stops the CLI at once instead of waiting for it to finish', async () => {
  const stop = new AbortController();
  const started = Date.now();
  const run = runCli(node, ['-e', 'setTimeout(() => {}, 60000)'], '', { env, signal: stop.signal });
  setTimeout(() => stop.abort(), 200);
  await assert.rejects(run, (error: Error & { kind?: string }) => error.kind === 'aborted');
  assert.ok(Date.now() - started < 5000, `stopped after ${Date.now() - started} ms`);
});

test("a dropped client fires res 'close' while the answer is pending (req 'close' already fired after the body)", async () => {
  const events: string[] = [];
  let closed!: () => void;
  const resClosed = new Promise<void>((resolve) => { closed = resolve; });
  const server = http.createServer((req, res) => {
    req.on('close', () => events.push('req'));
    req.resume();
    req.on('end', () => {
      res.writeHead(200);
      res.flushHeaders();
      setTimeout(() => {
        events.push(`req-before-drop=${events.includes('req')}`);
        res.on('close', () => { events.push(`res writableEnded=${res.writableEnded}`); closed(); });
      }, 100);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const client = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/' });
  client.on('error', () => {});
  client.end('{"x":1}');
  setTimeout(() => client.destroy(), 300);
  await resClosed;
  server.close();
  assert.deepEqual(events.slice(-2), ['req-before-drop=true', 'res writableEnded=false']);
});

test('小工具工坊 reads files without loading settings; the other tools get no tools at all', () => {
  const workshop = claudeArgs('sys', true);
  const plain = claudeArgs('sys', false);
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after(workshop, '--setting-sources'), '');
  assert.equal(after(plain, '--setting-sources'), '');
  assert.equal(after(workshop, '--tools'), 'Read,Glob,Grep');
  assert.equal(after(plain, '--tools'), '');
  assert.equal(after(plain, '--model'), 'opus');
});

test('the workshop prompt names the project CLAUDE.md files, 專案記憶 index and Claude memory that exist', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ta-mem-'));
  const savedConfig = process.env.CLAUDE_CONFIG_DIR;
  try {
    const project = path.join(root, 'work', '同事C');
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(root, 'work', '專案記憶'));
    writeFileSync(path.join(project, 'CLAUDE.md'), 'x');
    writeFileSync(path.join(root, 'work', '專案記憶', 'INDEX.md'), 'x');
    const config = path.join(root, 'cfg');
    const memoryDir = path.join(config, 'projects', path.resolve(project).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(path.join(memoryDir, 'MEMORY.md'), 'x');
    process.env.CLAUDE_CONFIG_DIR = config;
    const files = memoryFiles(project);
    assert.deepEqual(files.slice(0, 2), [path.join(project, 'CLAUDE.md'), path.join(root, 'work', '專案記憶', 'INDEX.md')]);
    assert.equal(files[files.length - 1], path.join(memoryDir, 'MEMORY.md'));
  } finally {
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
