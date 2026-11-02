'use strict';
// JEV judgment layer. The fixed-choices + confidence + timeout + threshold-fallback shape follows
// OpenMausBot server/decider (Apache-2.0, https://github.com/milind-soni/OpenMausBot); no code copied.
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA, 'judge-calls.jsonl');
const CACHE_FILE = path.join(DATA, 'judge-cache.json');
const CLAUDE_EXE = 'D:\\TAS\\cc-host\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const TOKEN_FILE = 'C:\\Users\\demo\\.tas\\claude-token.txt';
const CACHE_MAX = 500;

const tasks = {};
for (const f of fs.readdirSync(path.join(ROOT, 'tasks')).filter((f) => f.endsWith('.cjs'))) {
  const t = require(path.join(ROOT, 'tasks', f));
  tasks[t.id] = t;
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function rank(task, choice) { return task.choices.indexOf(choice); }

// Rules read one text field. A `floor` rule can only raise the choice (choices are listed from least to most
// capable route); a `force` rule pins it. Returns the strongest floor and the first force, with the rule ids.
function applyRules(task, input) {
  const text = String((input && input[task.ruleField || 'text']) || '');
  let floor = null, force = null; const hits = [];
  for (const r of task.rules || []) {
    if (!r.re.test(text)) continue;
    hits.push(r.id);
    if (r.force && !force) force = r.force;
    if (r.floor && (floor === null || rank(task, r.floor) > rank(task, floor))) floor = r.floor;
  }
  return { floor, force, hits };
}

function raise(task, choice, floor) {
  return floor && rank(task, floor) > rank(task, choice) ? floor : choice;
}

// Parse claude.exe --output-format json stdout into the task's answer. Throws a short reason on any defect.
function parseAnswer(task, stdout) {
  let env;
  try { env = JSON.parse(stdout); } catch { throw new Error('cli-json'); }
  if (env.is_error) throw new Error('cli-error:' + String(env.result || env.subtype || '').slice(0, 80));
  const text = String(env.result || '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no-json');
  let a;
  try { a = JSON.parse(m[0]); } catch { throw new Error('bad-json'); }
  if (!task.choices.includes(a.choice)) throw new Error('bad-choice:' + String(a.choice).slice(0, 20));
  const confidence = Number(a.confidence);
  if (!(confidence >= 0 && confidence <= 1)) throw new Error('bad-confidence');
  const out = { choice: a.choice, confidence, reason: String(a.reason || '').slice(0, 200) };
  if (task.extra) {
    out.extra = {};
    for (const [k, spec] of Object.entries(task.extra)) {
      const v = Array.isArray(a[k]) ? a[k] : [];
      out.extra[k] = v.map((s) => String(s).trim()).filter(Boolean).slice(0, spec.maxItems).map((s) => s.slice(0, spec.maxLen));
      if ((spec.requiredFor || []).includes(out.choice) && out.extra[k].length === 0) throw new Error('missing-' + k);
    }
  }
  return out;
}

function claudeEnv() {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    try { env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/)[0].trim(); } catch {}
  }
  return env;
}

// Default runner: one isolated claude.exe -p call in an empty temp cwd, prompt on stdin.
function claudeRunner({ system, prompt, model, timeoutMs }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-'));
  const args = ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--no-session-persistence', '--disable-slash-commands', '--system-prompt', system, '--output-format', 'json'];
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false;
    const child = spawn(CLAUDE_EXE, args, { cwd, env: claudeEnv(), windowsHide: true });
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(timer);
      try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill(); }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ code: null, stdout, stderr: String(e.message), spawnError: true }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
    child.stdin.end(prompt);
  });
}

// Cache: in memory, mirrored to one JSON file so separate CLI runs share it.
let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')))); } catch { cache = new Map(); }
  return cache;
}
function cacheGet(key, now) {
  const e = loadCache().get(key);
  if (!e) return null;
  if (e.exp <= now) { cache.delete(key); return null; }
  return e.value;
}
function cachePut(key, value, ttlMs, now) {
  const c = loadCache();
  c.set(key, { exp: now + ttlMs, value });
  for (const [k, e] of c) if (e.exp <= now || c.size > CACHE_MAX) c.delete(k);
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(c))); } catch {}
}

function logCall(row, file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + '\n'); } catch {}
}

/**
 * judge(taskId, input, opts) -> {choice, confidence, reason, source, ms, extra?, rules?, err?}
 * opts: runner (inject for tests), timeoutMs, cache (false to bypass), now, logFile.
 */
async function judge(taskId, input, opts = {}) {
  const task = opts.task || tasks[taskId];
  if (!task) throw new Error('unknown task ' + taskId);
  const started = Date.now();
  const now = opts.now ?? started;
  const raw = JSON.stringify(input);
  const key = sha(task.id + '\n' + raw);
  const ruled = applyRules(task, input);
  let result, ok = true, err;

  const cached = opts.cache === false ? null : cacheGet(key, now);
  if (ruled.force) {
    result = { choice: ruled.force, confidence: 1, reason: 'rule:' + ruled.hits.join(','), source: 'rule' };
  } else if (ruled.floor && rank(task, ruled.floor) === task.choices.length - 1) {
    result = { choice: ruled.floor, confidence: 1, reason: 'rule:' + ruled.hits.join(','), source: 'rule' };
  } else if (cached) {
    result = { ...cached, source: 'cache' };
  } else {
    const timeoutMs = opts.timeoutMs || task.timeoutMs;
    const runner = opts.runner || claudeRunner;
    // Haiku first; when it is unsure or answers malformed, one second opinion from task.escalate.model (Sonnet).
    // A timeout is not escalated: the caller's time budget is already spent.
    const ask = async (model) => {
      const r = await runner({ system: task.system, prompt: task.prompt(input), model, timeoutMs });
      if (r.timedOut) throw Object.assign(new Error('timeout'), { final: true });
      if (r.spawnError) throw Object.assign(new Error('spawn:' + String(r.stderr).slice(0, 80)), { final: true });
      const a = parseAnswer(task, r.stdout);
      if (a.confidence < task.minConfidence) throw new Error('low-confidence:' + a.confidence);
      return a;
    };
    try {
      let a, source = 'haiku';
      try {
        a = await ask(task.model || 'haiku');
        if (task.escalate && a.confidence < task.escalate.below) throw new Error('unsure:' + a.confidence);
      } catch (e) {
        if (e.final || !task.escalate) throw e;
        a = await ask(task.escalate.model);
        source = task.escalate.model;
      }
      result = { ...a, source };
      if (opts.cache !== false) cachePut(key, a, task.cacheTtlMs, now);
    } catch (e) {
      ok = false; err = e.message;
      result = { choice: task.default, confidence: 0, reason: 'fallback:' + err, source: 'default' };
      if (task.extra) result.extra = Object.fromEntries(Object.keys(task.extra).map((k) => [k, []]));
    }
  }
  if (!ruled.force) {
    const lifted = raise(task, result.choice, ruled.floor);
    if (lifted !== result.choice) {
      result = { ...result, choice: lifted, source: 'rule', reason: ('rule:' + ruled.hits.join(',') + '; ' + result.reason).slice(0, 240) };
    }
  }
  if (ruled.hits.length) result.rules = ruled.hits;
  result.ms = Date.now() - started;
  if (err) result.err = err;
  logCall({ ts: new Date(started).toISOString(), task: task.id, choice: result.choice, confidence: result.confidence,
    source: result.source, ms: result.ms, ok, ...(err ? { err } : {}), inLen: raw.length, inHash: key.slice(0, 16) },
  opts.logFile || LOG_FILE);
  return result;
}

module.exports = { judge, tasks, parseAnswer, applyRules, claudeRunner };

if (require.main === module) {
  const [taskId, json] = process.argv.slice(2);
  if (!taskId || !json) {
    console.error('usage: node judge.cjs <task> \'<input json>\'   tasks: ' + Object.keys(tasks).join(', '));
    process.exit(2);
  }
  judge(taskId, JSON.parse(json)).then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exit(1); });
}
