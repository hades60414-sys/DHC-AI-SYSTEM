#!/usr/bin/env node
// Install the harness hooks (and optionally the dhc-guard mod) into ~/.claude without hand-editing JSON.
//   node install-hooks.cjs --check            show what would change, change nothing
//   node install-hooks.cjs                    copy hooks\*.js to ~/.claude/hooks and merge them into settings.json
//   node install-hooks.cjs --guard            also register the dhc-guard mod (dangerous commands need "確認執行")
//   node install-hooks.cjs --no-zh            leave out zh-reply-guard (it makes Claude rewrite English replies in Chinese)
//   node install-hooks.cjs --remove           take all of the above back out of settings.json
// settings.json is backed up to settings.json.bak-<time> before any write; existing hooks are kept.
const fs = require('fs'), path = require('path'), os = require('os');

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check'), REMOVE = args.has('--remove');
const claudeDir = path.join(os.homedir(), '.claude');
const hooksDir = path.join(claudeDir, 'hooks');
const settingsPath = path.join(claudeDir, 'settings.json');
const srcDir = path.join(__dirname, '..', 'hooks');
const modsDir = path.join(__dirname, '..', 'mods');
const OUTBOUND = 'WebFetch|WebSearch|Bash|PowerShell|SendMessage|PushNotification|RemoteTrigger|DesignSync|mcp__.*';

const PLAN = [
  ['PreToolUse', OUTBOUND, 'egress-log.js'],
  ['PreToolUse', OUTBOUND, 'secret-guard.js'],
  ['PreToolUse', 'Write', 'build-check.js'],
  ['PostToolUse', OUTBOUND, 'egress-log.js'],
  ['Stop', null, 'zh-reply-guard.js'],
].filter(([, , f]) => !(f === 'zh-reply-guard.js' && args.has('--no-zh')));
const OURS = ['egress-log.js', 'secret-guard.js', 'build-check.js', 'zh-reply-guard.js'];
const command = (f) => `node "${path.join(hooksDir, f).split(path.sep).join('/')}"`;
const mentions = (h, f) => typeof h.command === 'string' && h.command.includes(f);

const before = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const s = JSON.parse(before || '{}');
s.hooks ??= {};
const log = [];

if (REMOVE) {
  for (const [event, groups] of Object.entries(s.hooks)) {
    for (const g of groups) {
      const keep = (g.hooks || []).filter((h) => !OURS.some((f) => mentions(h, f)));
      if (keep.length !== (g.hooks || []).length) log.push(`remove ${event} ${OURS.filter((f) => g.hooks.some((h) => mentions(h, f))).join(', ')}`);
      g.hooks = keep;
    }
    s.hooks[event] = groups.filter((g) => g.hooks.length);
    if (!s.hooks[event].length) delete s.hooks[event];
  }
  if (s.enabledPlugins?.['dhc-guard@dhc-mods'] !== undefined) { delete s.enabledPlugins['dhc-guard@dhc-mods']; log.push('remove dhc-guard plugin'); }
  if (s.extraKnownMarketplaces?.['dhc-mods']) { delete s.extraKnownMarketplaces['dhc-mods']; log.push('remove dhc-mods marketplace'); }
} else {
  for (const f of new Set(PLAN.map(([, , f]) => f))) {
    const from = path.join(srcDir, f), to = path.join(hooksDir, f);
    const same = fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from));
    if (same) continue;
    log.push(`${fs.existsSync(to) ? 'update' : 'copy'} hooks/${f}`);
    if (!CHECK) {
      fs.mkdirSync(hooksDir, { recursive: true });
      if (fs.existsSync(to)) fs.copyFileSync(to, `${to}.bak-${Date.now()}`);
      fs.copyFileSync(from, to);
    }
  }
  for (const [event, matcher, f] of PLAN) {
    const groups = (s.hooks[event] ??= []);
    if (groups.some((g) => (g.hooks || []).some((h) => mentions(h, f)) && (g.matcher ?? null) === matcher)) continue;
    let g = groups.find((x) => (x.matcher ?? null) === matcher);
    if (!g) { g = matcher ? { matcher, hooks: [] } : { hooks: [] }; groups.push(g); }
    g.hooks.push({ type: 'command', command: command(f) });
    log.push(`add ${event}${matcher ? ` [${matcher === OUTBOUND ? 'outbound tools' : matcher}]` : ''} ${f}`);
  }
  const market = { source: { source: 'directory', path: modsDir } };
  if (args.has('--guard') && (JSON.stringify(s.extraKnownMarketplaces?.['dhc-mods']) !== JSON.stringify(market) || s.enabledPlugins?.['dhc-guard@dhc-mods'] !== true)) {
    (s.extraKnownMarketplaces ??= {})['dhc-mods'] = market;
    (s.enabledPlugins ??= {})['dhc-guard@dhc-mods'] = true;
    log.push(`register dhc-guard mod from ${modsDir}`);
  }
}
for (const k of ['hooks', 'extraKnownMarketplaces', 'enabledPlugins']) if (s[k] && !Object.keys(s[k]).length) delete s[k];

const after = JSON.stringify(s, null, 2) + '\n';
if (!log.length) { console.log('Nothing to change: already as requested.'); process.exit(0); }
for (const l of log) console.log(`  ${l}`);
if (CHECK) { console.log('CHECK only: nothing changed.'); process.exit(0); }
if (after !== JSON.stringify(JSON.parse(before || '{}'), null, 2) + '\n') {
  if (fs.existsSync(settingsPath)) {
    let bak = `${settingsPath}.bak-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
    for (let i = 2; fs.existsSync(bak); i++) bak = bak.replace(/(-d+)?$/, `-${i}`); // never overwrite an earlier backup
    fs.copyFileSync(settingsPath, bak);
    console.log(`backup: ${bak}`);
  }
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, after);
}
console.log('DONE. Open a new Claude Code session for the change to take effect.');
