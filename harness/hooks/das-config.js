// Local opt-in settings; copied next to the hooks by install-hooks.cjs.
const fs = require('fs'), path = require('path'), os = require('os');
function load() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'das-hooks.json'), 'utf8')); }
  catch { return {}; }
}
function applies(cwd, config = load()) {
  if (!cwd || !Array.isArray(config.workspaces)) return false;
  const normalize = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const target = normalize(cwd);
  return config.workspaces.some((p) => typeof p === 'string' && path.isAbsolute(p) &&
    (target === normalize(p) || target.startsWith(normalize(p) + '/')));
}
module.exports = { load, applies };
