// Runs vitest with a hard memory ceiling: any node.exe under the vitest process tree above LIMIT_MB is killed.
// Usage: node vitest-capped.cjs <cwd> <limitMB> <vitest args...>
const { spawn, execFileSync } = require('node:child_process');

const [cwd, limitArg, ...args] = process.argv.slice(2);
const LIMIT = Number(limitArg) * 1024 * 1024;
const child = spawn('npx.cmd', ['vitest', 'run', ...args], { cwd, shell: true, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'inherit' });

function tree() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,PrivatePageCount,Name | ConvertTo-Json -Compress'], { encoding: 'utf8' });
  const all = JSON.parse(out);
  const kids = new Set([child.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (kids.has(p.ParentProcessId) && !kids.has(p.ProcessId)) { kids.add(p.ProcessId); grew = true; }
  }
  return all.filter((p) => kids.has(p.ProcessId));
}

const timer = setInterval(() => {
  let procs;
  try { procs = tree(); } catch { return; }
  const fat = procs.find((p) => p.PrivatePageCount > LIMIT);
  if (!fat) return;
  console.error(`\n[vitest-capped] ${fat.Name} pid=${fat.ProcessId} ${(fat.PrivatePageCount / 2 ** 30).toFixed(1)}GB > limit, killing tree`);
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {}
  process.exitCode = 99;
}, 700);

child.on('exit', (code) => { clearInterval(timer); if (!process.exitCode) process.exitCode = code ?? 1; });
