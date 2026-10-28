// DHC CLI 2026-10-27: 按「停止」只送 interrupt 並關 stdin，CLI 會結束，但子代理開的 Bash（和其他子程序）
// 不會跟著結束，變成孤兒繼續跑。停止後等一下，把這個 CLI 的整棵程序樹中還活著的都結束掉。
// 子程序的 ParentProcessId 在父程序結束後仍保留，所以 CLI 已經退出也找得到；只收建立時間不早於這輪
// 開始的程序，避免 PID 被重用時誤殺。
import { execFile, spawn } from 'child_process';

export const STOP_SWEEP_DELAY_MS = 5000;

// SDK 包起來的程序物件拿不到 pid，所以自己 spawn（選項同 SDK 預設；ChildProcess 符合 SpawnedProcess 介面），
// 把 pid 記在 holder。stderr 要讀掉，否則管線塞滿會卡住 CLI。
export function spawnTrackedCli(holder) {
  return ({ command, args, cwd, env, signal }) => {
    const child = spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    holder.pid = child.pid;
    holder.startedAt = Date.now();
    child.stderr.on('data', () => {});
    child.stderr.on('error', () => {});
    return child;
  };
}

export function sweepCliProcessTree(pid, sinceMs, { delayMs = STOP_SWEEP_DELAY_MS, log = console.log } = {}) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve([]);
  const since = Math.max(0, Math.floor(Number(sinceMs) || 0) - 60 * 1000);
  const script = [
    `$root=${pid}; $since=[DateTimeOffset]::FromUnixTimeMilliseconds(${since}).LocalDateTime`,
    '$all=@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ge $since })',
    '$ids=New-Object System.Collections.Generic.List[int]; $ids.Add($root); $i=0',
    'while ($i -lt $ids.Count) { $p=$ids[$i]; $i++; foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and -not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } } }',
    '$killed=@(); foreach ($id in $ids) { $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $killed+=("{0}:{1}" -f $id,$p.ProcessName) } }',
    '$killed -join " "',
  ].join('\n');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000 }, (error, stdout) => {
        const killed = String(stdout || '').trim().split(/\s+/).filter(Boolean);
        if (error) log(`[Claude SDK] stop sweep for CLI ${pid} failed: ${error.message}`);
        else if (killed.length) log(`[Claude SDK] stop sweep for CLI ${pid} ended ${killed.length} leftover process(es): ${killed.join(' ')}`);
        resolve(killed);
      });
    }, delayMs);
    timer.unref?.();
  });
}
