@echo off
rem Run as Administrator. Creates CC-Hosts-ForceRestart (used by restart-all.cmd; never runs on its own).
rem schtasks asks for the demo password at the prompt; the password is not stored in this file.
schtasks /Create /TN CC-Hosts-ForceRestart /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\TAS\cc-hosts\health-check.ps1 -Force" /SC ONCE /ST 00:00 /RU %COMPUTERNAME%\demo /RP * /RL HIGHEST /F
powershell.exe -NoProfile -Command "$t=Get-ScheduledTask CC-Hosts-ForceRestart; 'CHECK: ' + $t.TaskName + ' LogonType=' + $t.Principal.LogonType + ' RunLevel=' + $t.Principal.RunLevel"
