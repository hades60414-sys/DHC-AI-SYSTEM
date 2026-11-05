// Local opt-in settings; copied next to the hooks by install-hooks.cjs.
const fs = require('fs'), path = require('path'), os = require('os');
function load() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'das-hooks.json'), 'utf8')); }
  catch { return {}; }
}
function applies(cwd, config = load()) {
  if (!cwd || !Array.isArray(config.workspaces)) return false;
  // 只有 Windows 路徑不分大小寫；Linux／macOS 上 /home/User/ws 和 /home/user/ws 是不同資料夾
  const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const normalize = (p) => fold(path.resolve(p).replace(/\\/g, '/').replace(/\/$/, ''));
  const target = normalize(cwd);
  return config.workspaces.some((p) => typeof p === 'string' && path.isAbsolute(p) &&
    (target === normalize(p) || target.startsWith(normalize(p) + '/')));
}
module.exports = { load, applies };
