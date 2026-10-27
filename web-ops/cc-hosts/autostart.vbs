' autostart.vbs - hidden autostart for the Claude Code hosts on this machine (registered as a logon Scheduled Task). 2026-09-10.
' 1) CC Web UI (DHC CLI): CloudCLI + seal-proxy + tunnel watchdog -> https://tas-ui.example.workers.dev
' 2) Discord personal host (DM)
' 3) Discord project host: demo-chat
' Each .cmd has its own restart loop; hidden windows mean nobody closes them by accident.
' Stop one: D:\TAS\cc-hosts\stop-host.cmd <name>, or end the cmd loop in Task Manager.
' 2026-09-16: Discord hosts (DM, demo-chat, mike-anc) removed on request - user moved to DHC CLI. Only CC Web UI autostarts now.
' 2026-10-08: de-identification proxy (127.0.0.1:3003) for DHC CLI; CloudCLI's .env points the model traffic at it.
' 2026-10-19: the task now runs at boot AND at logon without needing a logon (S4U), so each launcher starts only if its
' loop is not already running; otherwise boot + logon (or restart-all) would stack duplicate loops.
Set sh = CreateObject("Wscript.Shell")
Set wmi = GetObject("winmgmts:")
Sub StartOnce(script)
  For Each p In wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='cmd.exe'")
    If Not IsNull(p.CommandLine) Then
      If InStr(1, p.CommandLine, script, 1) > 0 Then Exit Sub
    End If
  Next
  sh.Run "cmd.exe /c """"" & script & """""", 0, False
End Sub
StartOnce "D:\TAS\cc-web\run-deid-proxy.cmd"
StartOnce "D:\TAS\cc-web\start-cc-web.cmd"
