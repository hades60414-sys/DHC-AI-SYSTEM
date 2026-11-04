// Isolated installer/config regression checks. No real home or service is modified.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'das-package-test-'));
const home = path.join(temp, 'home');
fs.mkdirSync(home);
const preload = path.join(temp, 'home.cjs');
fs.writeFileSync(preload, "require('node:os').homedir = () => process.env.DAS_TEST_HOME;\n");
const env = { ...process.env, USERPROFILE: home, DAS_TEST_HOME: home };
let checks = 0;
function check(ok, label) { assert.ok(ok, label); checks++; }
function run(file, args = [], input = '') {
  const r = spawnSync(process.execPath, ['--require', preload, path.join(root, file), ...args],
    { cwd: root, env, input, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return r.stdout;
}
const installer = 'harness/ops/install-hooks.cjs';
run(installer, ['--check']);
check(!fs.existsSync(path.join(home, '.claude')), 'dry run leaves home untouched');
run(installer);
const configFile = path.join(home, '.claude', 'das-hooks.json');
const cfg = JSON.parse(fs.readFileSync(configFile));
check(cfg.toolsRoot === path.join(root, 'tools') && !cfg.keepgoingEnabled && !cfg.workspaces.length, 'portable defaults, automation opt-in');
const settingsFile = path.join(home, '.claude', 'settings.json');
let settings = JSON.parse(fs.readFileSync(settingsFile));
const entries = Object.values(settings.hooks).flatMap(g => g.flatMap(x => x.hooks));
check(entries.length === 16 && entries.every(h => !h.command.includes('gemini-takeover')), '16 default registrations, Gemini opt-in');
check(fs.existsSync(path.join(home, '.claude', 'hooks', 'das-config.js')), 'shared config helper installed');
const settingsBytes = fs.readFileSync(settingsFile);
run(installer);
check(settingsBytes.equals(fs.readFileSync(settingsFile)), 'idempotent installer');
const workspace = path.join(temp, 'work');
cfg.workspaces = [workspace];
cfg.toolsRoot = path.join(temp, 'tools');
fs.mkdirSync(path.join(cfg.toolsRoot, 'approvals'), { recursive: true });
fs.writeFileSync(path.join(cfg.toolsRoot, 'approvals', 'keepgoing.cjs'),
  "module.exports={KDIR:'test-state',DONE:'DONE',start:(_sid,until)=>({until}),stop:()=>true};");
fs.writeFileSync(configFile, JSON.stringify(cfg));
run(installer);
check(JSON.parse(fs.readFileSync(configFile)).toolsRoot === cfg.toolsRoot, 'preserve user configuration');
const event = { cwd: workspace, session_id: '00000000-0000-0000-0000-000000000000', prompt: '再做兩小時' };
const hook = 'harness/hooks/keepgoing-detect.js';
check(run(hook, [], JSON.stringify(event)) === '', 'disabled keepgoing never promises wakeup');
cfg.keepgoingEnabled = true;
fs.writeFileSync(configFile, JSON.stringify(cfg));
check(run(hook, [], JSON.stringify(event)).includes('additionalContext'), 'keepgoing resolves configured backend');
check(run(hook, [], JSON.stringify({ ...event, cwd: workspace + '-other' })) === '', 'sibling prefix not authorized');
check(run(hook, [], JSON.stringify({ ...event, cwd: path.join(workspace, 'sub') })).includes('additionalContext'), 'descendant included');
const guard = 'harness/hooks/turn-end-guard.js';
const stop = { cwd: workspace, last_assistant_message: '請雙擊這個檔案.cmd' };
check(run(guard, [], JSON.stringify(stop)).includes('block'), 'handoff guard enabled for configured workspace');
check(run(guard, [], JSON.stringify({ ...stop, stop_hook_active: true })) === '', 'guard never loops');
check(run(guard, [], JSON.stringify({ ...stop, cwd: workspace + '-other' })) === '', 'guard respects workspace boundary');
cfg.drainRoot = path.join(temp, 'maintenance');
fs.mkdirSync(cfg.drainRoot);
fs.writeFileSync(configFile, JSON.stringify(cfg));
fs.writeFileSync(path.join(cfg.drainRoot, 'drain.json'), JSON.stringify({ since: new Date().toISOString(), reason: 'test' }));
check(run('harness/hooks/drain-guard.js', [], JSON.stringify(event)).includes('deny'), 'drain reads configured service root');
run(installer, ['--gemini']);
settings = JSON.parse(fs.readFileSync(settingsFile));
check(Object.values(settings.hooks).flatMap(g => g.flatMap(x => x.hooks)).length === 18, 'explicit Gemini registration');
run(installer, ['--remove']);
check(!JSON.parse(fs.readFileSync(settingsFile)).hooks, 'remove includes optional registrations');
check(fs.existsSync(configFile), 'remove preserves user configuration');
if (process.platform === 'win32') {
  for (const target of ['Codex', 'All']) {
    for (const script of ['sync-harness.ps1', 'healthcheck.ps1']) {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(root, 'harness', 'ops', script), '-Target', target], { env, encoding: 'utf8', timeout: 120000 });
      fs.writeFileSync(path.join(temp, target + '-' + script + '.log'), (r.stdout || '') + (r.stderr || ''));
      check(r.status === 0, target + ' ' + script + ': ' + (r.stdout || '').slice(-1500) + (r.stderr || ''));
    }
    if (target === 'Codex') check(!fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')), 'Codex-only does not require Claude installation');
  }
}
const scanRoot = path.join(temp, 'scan-repo');
fs.mkdirSync(path.join(scanRoot, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts', 'scan-sensitive.mjs'), path.join(scanRoot, 'scripts', 'scan-sensitive.mjs'));
const init = spawnSync('git', ['init', '--quiet', scanRoot], { encoding: 'utf8' });
assert.equal(init.status, 0, init.stderr);
const terms = path.join(temp, 'terms.json');
fs.writeFileSync(terms, '{"terms":[]}');
function scan() {
  return spawnSync(process.execPath, [path.join(scanRoot, 'scripts', 'scan-sensitive.mjs'), '--summary'],
    { env: { ...env, SCAN_SENSITIVE_TERMS: terms }, encoding: 'utf8', timeout: 30000 });
}
check(scan().status === 0, 'clean isolated scanner baseline');
const fixture = path.join(scanRoot, 'fixture.txt');
const posixFixture = (base) => '/' + [base, 'private-user', 'project'].join('/');
fs.writeFileSync(fixture, [posixFixture('Users'), posixFixture('home'), 'C:' + posixFixture('Users')].join('\n'));
check(scan().status === 1, 'scanner rejects Windows, macOS and Linux personal paths');
fs.unlinkSync(fixture);
check(scan().status === 0, 'scanner passes after personal paths removed');
fs.writeFileSync(fixture, '/' + ['home', 'u'].join('/') + '、工作區；' + '/' + ['home', '...'].join('/') + '）');
check(scan().status === 0, 'Chinese punctuation terminates a placeholder path');
console.log(`PASS ${checks} package checks; isolated evidence: ${temp}`);
