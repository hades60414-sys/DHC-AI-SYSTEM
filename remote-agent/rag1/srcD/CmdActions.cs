using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

// rag1o (2026-10-06): copy of the srv-db v3.5b CmdActions.cs for RAG1. Differences: the deny list also protects the RAG1 install folder
// (rag1-rag), EKB_USER is passed to the child like the other account names, and credentials set with setx after the agent started
// are picked up per command (Common.RefreshSecrets), so the EKB probe works without restarting the agent.
// v3.5 (2026-10-05): cmd-run. The user asked for full remote operation: the controller sends one CMD command line, the agent
// runs it with cmd.exe /d /s /c under the agent account, and returns exit code, stdout/stderr (head+tail when long) and duration.
// Only signed jobs from the paired controller reach this (same channel as every other action). Safeguards, not a sandbox:
//   - deny list for host-destroying or self-disabling commands (format, shutdown, diskpart, recursive deletes of drive roots or
//     system folders, account/registry/service changes, killing the agent, DROP DATABASE outside TRADE_DB_TEST/aiw_*) and any
//     write keyword on a line that names the read-only source 10.255.0.11;
//   - timeout (default 600 s, max 1800 s) kills the whole process tree;
//   - every command (text, exit code, duration) is appended to <state>\cmd-run.log;
//   - credential variables cleared at agent start (SRC_PWD, DST_PWD, MktData_PWD, SQLCMDPASSWORD) are handed back to the child
//     environment so scripts can use %SRC_PWD% etc.; their values are redacted from the report by Common.Safe.
namespace DbAgent {
public static class CmdActions {
    public static string LogFile = null;
    public const int DefaultTimeout = 600, MaxTimeout = 1800, MaxCmdChars = 8000, HeadChars = 3000, TailChars = 11000;
    public static bool Handles(string action) { return action == "cmd-run"; }

    static readonly Regex[] Deny = new[] {
        @"\bformat(\.com)?\s+[a-z]:", @"\bshutdown\b", @"\b(restart|stop)-computer\b", @"\bdiskpart\b", @"\bbcdedit\b", @"\bcipher\b[^\r\n]*\s/w",
        @"\bvssadmin\b", @"\bwbadmin\b", @"\bnet(1)?\s+(user|localgroup|accounts|share\s+\S+\s+/delete)\b", @"\breg(\.exe)?\s+(delete|add|import|load|restore)\b",
        @"\bsc(\.exe)?\s+(delete|config|stop|create)\b", @"\bnet(1)?\s+stop\b", @"\bschtasks(\.exe)?\b[^\r\n]*/(delete|change|create)\b",
        @"\b(rd|rmdir)\b[^\r\n]*/s[^\r\n]*\s""?[a-z]:\\?""?\s*($|[\r\n&|])", @"\bdel\b[^\r\n]*/s[^\r\n]*\s""?[a-z]:\\?(\*(\.\*)?)?""?\s*($|[\r\n&|])",
        @"\b(rd|rmdir|del|erase|remove-item)\b[^\r\n]*[a-z]:\\(windows|program files|programdata|users\\[^\\\s""]+\\?""?\s*($|[\r\n&|]))",
        @"\b(rd|rmdir|del|erase|remove-item|move|ren|rename)\b[^\r\n]*\\(dhc-agent-v1|dbclone|rag1-rag)\b", @"\btaskkill\b[^\r\n]*(dbclone|llama|/im\s+cmd)", @"\bstop-process\b",
        @"\bicacls\b[^\r\n]*/(grant|deny|remove|reset|setowner)", @"\btakeown\b", @"\bset-executionpolicy\b",
        @"\bdrop\s+database\s+(?!\[?(TRADE_DB_TEST|aiw_[A-Za-z0-9_]+)\]?\b)",
        @"\bdrop\s+login\b", @"\balter\s+login\b", @"\bsp_(addsrvrolemember|password|dropserver)\b",
    }.Select(p => new Regex(p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).ToArray();
    static readonly Regex SourceRO = new Regex(@"10\.255\.0\.11\b", RegexOptions.CultureInvariant);
    static readonly Regex WriteWord = new Regex(@"\b(insert|update|delete|drop|alter|truncate|backup|restore|merge|grant|revoke|create|exec(ute)?\s+sp_|bcp\b[^\r\n]*\sin\s)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static string Blocked(string cmd) {
        foreach (var r in Deny) if (r.IsMatch(cmd)) return "blocked by deny rule: " + r.ToString();
        foreach (var line in cmd.Split('\n', '&', '|')) if (SourceRO.IsMatch(line) && WriteWord.IsMatch(line)) return "blocked: a write keyword appears together with the read-only source 10.255.0.11";
        return null;
    }

    public static string Execute(string action, string prompt) {
        if (action != "cmd-run") throw new InvalidOperationException("Action not allowed");
        var d = Common.Decode(prompt);
        var bad = d.Keys.Where(k => k != "cmd" && k != "cwd" && k != "timeout_sec").ToList();
        if (bad.Count > 0) throw new InvalidDataException("Unknown field(s): " + string.Join(",", bad) + "; allowed: cmd,cwd,timeout_sec");
        var cmd = Common.S(d, "cmd");
        if (cmd.Trim().Length == 0 || cmd.Length > MaxCmdChars) throw new InvalidDataException("cmd must be 1-" + MaxCmdChars + " chars");
        string cwd = null; object v;
        if (d.TryGetValue("cwd", out v) && v != null) { cwd = v as string; if (cwd == null || !Path.IsPathRooted(cwd) || !Directory.Exists(cwd)) throw new InvalidDataException("cwd must be an existing absolute folder"); }
        int timeout = DefaultTimeout;
        if (d.TryGetValue("timeout_sec", out v) && v != null) { long n; if (!(v is int || v is long) || !long.TryParse(v.ToString(), out n) || n < 1 || n > MaxTimeout) throw new InvalidDataException("timeout_sec must be 1-" + MaxTimeout); timeout = (int)n; }
        Common.RefreshSecrets();
        var why = Blocked(cmd);
        if (why != null) { Log(cmd, "BLOCKED", 0, why); return Common.Encode(new { kind = "cmd_run", blocked = true, reason = why, executed = false }); }
        return Run(cmd, cwd ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), timeout);
    }

    internal static string Run(string cmd, string cwd, int timeoutSec) {
        var oem = Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage);
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d /s /c \"" + cmd + "\"") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = oem, StandardErrorEncoding = oem, WorkingDirectory = cwd };
        for (int i = 0; i < Common.CredentialKeys.Length && i < Common.Secrets.Length; i++)
            if (!string.IsNullOrEmpty(Common.Secrets[i])) psi.EnvironmentVariables[Common.CredentialKeys[i]] = Common.Secrets[i];
        foreach (var k in new[] { "SRC_USER", "DST_USER", "MktData_USER", "EKB_USER" }) {   // v3.5b: account names set with setx after the agent started
            var u = Environment.GetEnvironmentVariable(k) ?? Environment.GetEnvironmentVariable(k, EnvironmentVariableTarget.User); if (!string.IsNullOrEmpty(u)) psi.EnvironmentVariables[k] = u; }
        var sw = Stopwatch.StartNew(); bool timedOut = false;
        using (var p = Process.Start(psi)) {
            p.StandardInput.Close();
            var outBuf = new Capture(); var errBuf = new Capture();
            var to = Task.Run(() => Pump(p.StandardOutput, outBuf)); var te = Task.Run(() => Pump(p.StandardError, errBuf));
            if (!p.WaitForExit(timeoutSec * 1000)) { timedOut = true; KillTree(p.Id); p.WaitForExit(15000); }
            Task.WaitAll(new[] { to, te }, 15000);
            sw.Stop();
            int code = p.HasExited ? p.ExitCode : -1;
            Log(cmd, timedOut ? "TIMEOUT" : "EXIT " + code, sw.ElapsedMilliseconds, null);
            return Common.Encode(new { kind = "cmd_run", executed = true, exit_code = code, timed_out = timedOut, duration_ms = sw.ElapsedMilliseconds, cwd = cwd,
                stdout = outBuf.Text(), stdout_chars = outBuf.Total, stderr = errBuf.Text(), stderr_chars = errBuf.Total });
        }
    }

    // Keeps the first HeadChars and last TailChars characters; total report stays under Common.MaxResult after JSON escaping in most cases.
    sealed class Capture {
        readonly StringBuilder head = new StringBuilder(); readonly StringBuilder tail = new StringBuilder(); public long Total;
        public void Add(char[] b, int n) { lock (this) { for (int i = 0; i < n; i++) { Total++; if (head.Length < HeadChars) head.Append(b[i]); else { tail.Append(b[i]); if (tail.Length > TailChars * 2) tail.Remove(0, tail.Length - TailChars); } } } }
        public string Text() { lock (this) { var t = tail.Length > TailChars ? tail.ToString(tail.Length - TailChars, TailChars) : tail.ToString(); long skipped = Total - head.Length - t.Length; return skipped > 0 ? head + "\n...[" + skipped + " chars omitted]...\n" + t : head.ToString() + t; } }
    }
    static void Pump(StreamReader r, Capture c) { var b = new char[4096]; int n; while ((n = r.Read(b, 0, b.Length)) > 0) c.Add(b, n); }
    static void KillTree(int pid) {
        try { using (var k = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "taskkill.exe"), "/T /F /PID " + pid) { UseShellExecute = false, CreateNoWindow = true })) k.WaitForExit(15000); } catch (Exception) { }
    }
    static void Log(string cmd, string outcome, long ms, string note) {
        if (LogFile == null) return;
        try { File.AppendAllText(LogFile, DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + "\t" + outcome + "\t" + ms + "ms\t" + (note ?? "") + "\t" + Common.Safe(cmd.Replace("\r", " ").Replace("\n", " ")) + "\r\n", new UTF8Encoding(false)); } catch (Exception) { }
    }
}
}
