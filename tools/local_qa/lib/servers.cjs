'use strict';
// Start/stop/status of the three local llama-server processes (chat, embed, rerank).
// Servers are spawned detached so they keep running after this CLI process exits;
// their PIDs are recorded in state/servers.json and only those PIDs are ever killed.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const P = require('./paths.cjs');

function readState() {
  try { return JSON.parse(fs.readFileSync(P.SERVERS_JSON, 'utf8')); } catch { return []; }
}
function writeState(list) {
  fs.mkdirSync(P.STATE_DIR, { recursive: true });
  fs.writeFileSync(P.SERVERS_JSON, JSON.stringify(list, null, 2) + '\n');
}

async function health(port, timeoutMs = 1000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status === 200;
  } catch { return false; }
}

function argsFor(name) {
  const common = ['--host', '127.0.0.1', '--n-gpu-layers', '0', '--offline', '--no-webui'];
  if (name === 'chat') {
    return ['--model', P.CHAT_MODEL, '--alias', 'local-chat', '--port', String(P.PORTS.chat),
      '--ctx-size', '8192', '--threads', '8', '--threads-batch', '8', '--parallel', '1',
      '--jinja', '--reasoning-budget', '0', '--chat-template-kwargs', '{"enable_thinking":false}',
      '--no-agent', '--no-ui-mcp-proxy', ...common];
  }
  if (name === 'embed') {
    // Chunks are <=450 chars, so a small context is enough; keeps this server's memory footprint low.
    return ['--model', P.EMBED_MODEL, '--port', String(P.PORTS.embed), '--embeddings', '--pooling', 'last',
      '--ctx-size', '2048', '--batch-size', '512', '--ubatch-size', '512', '--parallel', '1',
      '--threads', '8', '--threads-batch', '8', ...common];
  }
  if (name === 'rerank') {
    // Rerank pairs (query + one chunk) are short too.
    return ['--model', P.RERANK_MODEL, '--port', String(P.PORTS.rerank), '--reranking',
      '--ctx-size', '2048', '--batch-size', '512', '--ubatch-size', '512', '--parallel', '1',
      '--threads', '8', '--threads-batch', '8', ...common];
  }
  throw Error('unknown_server:' + name);
}

// Spawns the server and records its PID in state/servers.json BEFORE waiting for /health, so that if
// the process later fails to become healthy it is still tracked and `stop` can still kill it (no orphans).
function spawnOne(name, currentState) {
  fs.mkdirSync(P.LOG_DIR, { recursive: true });
  const logPath = path.join(P.LOG_DIR, `${name}-${P.PORTS[name]}.log`);
  const log = fs.openSync(logPath, 'a');
  const args = argsFor(name);
  for (const old of currentState.filter(s => s.name === name)) killPid(old.pid); // a hung old server would otherwise be dropped from state
  const child = spawn(P.BIN, args, { windowsHide: true, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  const entry = { name, pid: child.pid, port: P.PORTS[name], args, log: logPath, started_at: new Date().toISOString() };
  writeState([...currentState.filter(s => s.name !== name), entry]); // record immediately, before health wait
  return entry;
}

async function waitHealthy(entry) {
  const dl = Date.now() + 180000;
  while (Date.now() < dl) {
    if (await health(entry.port)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw Error(`server_not_ready:${entry.name} (see ${entry.log})`);
}

// Ensure all three servers are up. Starts only the ones that are not already answering /health.
async function ensureAll() {
  let state = readState();
  const byName = Object.fromEntries(state.map(s => [s.name, s]));
  const names = ['chat', 'embed', 'rerank'];
  const alive = {};
  for (const n of names) alive[n] = byName[n] && await health(byName[n].port);
  const toStart = names.filter(n => !alive[n]);
  if (!toStart.length) return state;
  for (const n of toStart) {
    const entry = spawnOne(n, readState());
    await waitHealthy(entry); // if this throws, entry is already in state.json (see spawnOne) -> `stop` will still kill it
  }
  return readState();
}

async function statusAll() {
  const state = readState();
  const out = [];
  for (const n of ['chat', 'embed', 'rerank']) {
    const s = state.find(x => x.name === n);
    out.push({ name: n, port: P.PORTS[n], recorded_pid: s ? s.pid : null, healthy: s ? await health(s.port) : await health(P.PORTS[n]) });
  }
  return out;
}

// A dead server's PID can be reused by an unrelated process, so only kill a recorded PID that is still llama-server.exe.
function isLlama(pid) {
  try { return /^"llama-server\.exe"/i.test(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).trim()); } catch { return false; }
}
function killPid(pid) {
  if (!isLlama(pid)) return false;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function stopAll() {
  const state = readState();
  const results = state.map(s => ({ name: s.name, pid: s.pid, killed: killPid(s.pid) }));
  writeState([]);
  return results;
}

module.exports = { readState, writeState, health, ensureAll, statusAll, stopAll, spawnOne, argsFor };
