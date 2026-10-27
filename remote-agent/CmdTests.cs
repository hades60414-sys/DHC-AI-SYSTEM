using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

// v3.5 cmd-run tests (2026-10-05). Runs real cmd.exe locally; no network, no database.
namespace DbAgent {
public static class CmdTests {
    static int pass = 0, fail = 0;
    static void Check(string name, bool ok, string detail = "") { if (ok) { pass++; Console.WriteLine("PASS " + name); } else { fail++; Console.WriteLine("FAIL " + name + " " + detail); } }
    static Dictionary<string, object> Run(object spec) { return Common.Decode(CmdActions.Execute("cmd-run", Common.Encode(spec))); }
    public static int Main(string[] args) {
        var dir = Path.Combine(Path.GetTempPath(), "cmdtests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        CmdActions.LogFile = Path.Combine(dir, "cmd-run.log");
        Check("action wired", AgentCore.ActionAllowed("cmd-run") && AgentCore.UsesPrompt("cmd-run") && AgentCore.Names.Contains("cmd-run"));

        var r = Run(new { cmd = "echo hello& ver" });
        Check("echo runs, exit 0", (int)r["exit_code"] == 0 && ((string)r["stdout"]).Contains("hello") && (bool)r["executed"], Common.Encode(r));
        r = Run(new { cmd = "exit /b 7" });
        Check("exit code returned", (int)r["exit_code"] == 7);
        r = Run(new { cmd = "echo err 1>&2" });
        Check("stderr captured", ((string)r["stderr"]).Contains("err"));
        r = Run(new { cmd = "cd", cwd = dir });
        Check("cwd honoured", ((string)r["stdout"]).Trim().Equals(dir, StringComparison.OrdinalIgnoreCase), (string)r["stdout"]);
        r = Run(new { cmd = "echo 中文測試" });
        Check("Chinese output decoded", ((string)r["stdout"]).Contains("中文測試"), (string)r["stdout"]);
        r = Run(new { cmd = "for /l %i in (1,1,3000) do @echo line%i" });
        var so = (string)r["stdout"];
        Check("long output head+tail", so.Contains("line1\r") && so.Contains("line3000") && so.Contains("chars omitted") && so.Length < 15000, so.Length.ToString());
        var t0 = DateTime.UtcNow;
        r = Run(new { cmd = "ping -n 30 127.0.0.1 >nul", timeout_sec = 3 });
        Check("timeout kills tree", (bool)r["timed_out"] && (DateTime.UtcNow - t0).TotalSeconds < 20, Common.Encode(r));

        Common.Secrets = new[] { "S3cr3t!Pw", null, null, null };
        r = Run(new { cmd = "echo pw=%SRC_PWD%" });
        Check("credential passed to child and redacted in report", Common.Safe(Common.Encode(r)).Contains("pw=[REDACTED]") && !Common.Safe(Common.Encode(r)).Contains("S3cr3t"), Common.Safe(Common.Encode(r)));
        Common.Secrets = new string[0];

        string[] blocked = { "format d: /q", "shutdown /r /t 0", "diskpart", "rd /s /q C:\\", "del /s /q c:\\*", "rmdir /s /q \"C:\\Windows\"", "net user x y /add",
            "reg delete HKLM\\Software\\X /f", "sc stop MSSQLSERVER", "net stop mssqlserver", "taskkill /f /im dbclone-agent-v1.exe", "schtasks /delete /tn X /f",
            "del /q C:\\dbclone\\dhc-agent-v1\\agent-state.json", "sqlcmd -S . -Q \"DROP DATABASE TRADE_DB\"", "sqlcmd -S 10.255.0.11 -Q \"DELETE FROM t\"",
            "sqlcmd -S 10.255.0.11 -Q \"BACKUP DATABASE TRADE_DB TO DISK='x'\"", "bcp TRADE_DB.dbo.t in x.dat -S 10.255.0.11", "icacls C:\\x /grant Everyone:F", "powershell Stop-Process -Name sqlservr" };
        foreach (var b in blocked) { var x = Run(new { cmd = b }); Check("blocked: " + b, x.ContainsKey("blocked") && (bool)x["blocked"] && !(bool)x["executed"], Common.Encode(x)); }
        string[] allowed = { "sqlcmd -S 10.255.0.11 -d TRADE_DB -Q \"SELECT COUNT(*) FROM sys.tables\"", "sqlcmd -S localhost -Q \"DROP DATABASE [TRADE_DB_TEST]\"",
            "sqlcmd -S localhost -Q \"CREATE DATABASE TRADE_DB_TEST\"", "bcp TRADE_DB.dbo.t out C:\\work\\t.dat -S 10.255.0.11 -n", "dir C:\\", "del /q C:\\work\\t.dat", "rd /s /q C:\\work\\otc_copy" };
        foreach (var a in allowed) Check("not blocked: " + a, CmdActions.Blocked(a) == null, CmdActions.Blocked(a));

        foreach (var badSpec in new object[] { new { cmd = "" }, new { cmd = "dir", extra = 1 }, new { cmd = "dir", timeout_sec = 99999 }, new { cmd = "dir", cwd = "relative" } }) {
            bool threw = false; try { Run(badSpec); } catch (InvalidDataException) { threw = true; }
            Check("bad spec rejected: " + Common.Encode(badSpec), threw);
        }
        var log = File.ReadAllText(CmdActions.LogFile);
        Check("log has EXIT, TIMEOUT, BLOCKED", log.Contains("EXIT 0") && log.Contains("TIMEOUT") && log.Contains("BLOCKED"));
        Console.WriteLine("RESULT passed=" + pass + " failed=" + fail);
        try { Directory.Delete(dir, true); } catch (Exception) { }
        return fail == 0 ? 0 : 1;
    }
}
}
