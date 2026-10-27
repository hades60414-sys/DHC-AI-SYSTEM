using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using DbAgent;

// v3.2 host action tests: task-list against a fake scheduler source, file-tail against real temp files.
public static class HostTests {
    static void Check(bool b, string why) { if (!b) throw new Exception(why); }
    static void Throws<T>(Action run, string contains) where T : Exception {
        try { run(); } catch (T e) { if (contains != null && !e.Message.Contains(contains)) throw new Exception("Wrong message: " + e.Message); return; }
        throw new Exception("Expected " + typeof(T).Name);
    }
    sealed class FakeTasks : HostActions.ITaskSource {
        public List<HostActions.TaskRow> Rows = new List<HostActions.TaskRow>();
        public IEnumerable<HostActions.TaskRow> Tasks(string folder, out int unreadable) { unreadable = 1; return Rows; }
    }
    // Test folders here inherit write access for another account; config files must look like the console-restricted originals.
    public static void Protect(string f) {
        var acl = new System.Security.AccessControl.FileSecurity(); acl.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { System.Security.Principal.WindowsIdentity.GetCurrent().User.Value, "S-1-5-32-544", "S-1-5-18" })
            acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier(sid), System.Security.AccessControl.FileSystemRights.FullControl, System.Security.AccessControl.AccessControlType.Allow));
        File.SetAccessControl(f, acl);
    }
    static string P(object o) { return Common.Encode(o); }
    static Dictionary<string, object> D(params object[] kv) { var d = new Dictionary<string, object>(); for (int i = 0; i < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1]; return d; }

    public static void Run(string work, Action<string, Action> test) {
        var fake = new FakeTasks();
        fake.Rows.Add(new HostActions.TaskRow { Path = "\\Daily\\LoadQuotes", State = 3, Enabled = true, LastRun = new DateTime(2026, 10, 1, 18, 0, 0), NextRun = new DateTime(2026, 10, 2, 18, 0, 0), LastResult = 1, RunAs = "SVC", Programs = new[] { "C:\\jobs\\load.cmd" } });
        fake.Rows.Add(new HostActions.TaskRow { Path = "\\Daily\\Recon", State = 3, Enabled = true, LastRun = new DateTime(2026, 10, 1, 19, 0, 0), LastResult = 0, RunAs = "SVC" });
        fake.Rows.Add(new HostActions.TaskRow { Path = "\\Daily\\NewJob", State = 3, Enabled = true, LastRun = null, LastResult = 0x41303 });
        fake.Rows.Add(new HostActions.TaskRow { Path = "\\Microsoft\\Windows\\Defrag", State = 1, Enabled = false, LastResult = 0 });
        fake.Rows.Add(new HostActions.TaskRow { Path = "\\Daily\\Running", State = 4, Enabled = true, LastRun = new DateTime(2026, 10, 1, 20, 0, 0), LastResult = 0x41301 });

        test("task-list hides Microsoft tasks by default and maps result codes", () => {
            var d = Common.Decode(HostActions.TaskList(P(D()), fake)); var items = (object[])d["items"];
            Check(items.Length == 4 && Common.N(d, "unreadable_folders") == 1, "count/unreadable");
            var load = (Dictionary<string, object>)items.First(i => (string)((Dictionary<string, object>)i)["path"] == "\\Daily\\LoadQuotes");
            Check((string)load["last_result"] == "exit code 1" && (string)load["last_run"] == "2026-10-01 18:00:00" && (string)load["state"] == "ready", "mapping: " + Common.Encode(load));
            var nj = (Dictionary<string, object>)items.First(i => (string)((Dictionary<string, object>)i)["path"] == "\\Daily\\NewJob");
            Check((string)nj["last_result"] == "never run" && nj["last_run"] == null, "never run");
        });
        test("task-list failed_only keeps only finished non-zero results", () => {
            var items = (object[])Common.Decode(HostActions.TaskList(P(D("failed_only", true)), fake))["items"];
            Check(items.Length == 1 && (string)((Dictionary<string, object>)items[0])["path"] == "\\Daily\\LoadQuotes", "failed_only: " + items.Length);
        });
        test("task-list include_microsoft and name_like filter", () => {
            Check(((object[])Common.Decode(HostActions.TaskList(P(D("include_microsoft", true)), fake))["items"]).Length == 5, "include_microsoft");
            Check(((object[])Common.Decode(HostActions.TaskList(P(D("name_like", "recon")), fake))["items"]).Length == 1, "name_like");
        });
        test("task-list never returns action arguments and rejects bad specs", () => {
            string r = HostActions.TaskList(P(D()), fake); Check(!r.Contains("arguments\""), "arguments leaked");
            Throws<InvalidDataException>(() => HostActions.TaskList(P(D("folder", "C:\\x")), fake), "Task Scheduler path");
            Throws<InvalidDataException>(() => HostActions.TaskList(P(D("x", 1)), fake), "Unknown field");
            Throws<InvalidDataException>(() => HostActions.TaskList(P(D("top", 0)), fake), "top");
        });
        test("task-list caps output to the result bound", () => {
            var many = new FakeTasks(); for (int i = 0; i < 400; i++) many.Rows.Add(new HostActions.TaskRow { Path = "\\Bulk\\" + new string('t', 120) + i, State = 3, Enabled = true, LastResult = 0, Programs = new[] { new string('p', 100) } });
            string r = HostActions.TaskList(P(D("top", 200)), many); var d = Common.Decode(r);
            Check(r.Length <= Common.MaxResult && (bool)d["truncated"] && Common.N(d, "total") == 400, "bound");
        });

        string root = Path.Combine(work, "text-root-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        string outside = Path.Combine(work, "outside-" + Guid.NewGuid().ToString("N") + ".log"); File.WriteAllText(outside, "secret\n");
        string roots = Path.Combine(work, "text-roots-" + Guid.NewGuid().ToString("N") + ".txt"); File.WriteAllText(roots, "# test\r\n" + root + "\r\n", new UTF8Encoding(true)); Protect(roots);
        string saved = HostActions.TextRootsFile;
        try {
            test("file-tail disabled without text-roots.txt", () => { HostActions.TextRootsFile = Path.Combine(work, "missing-roots.txt"); Throws<InvalidOperationException>(() => HostActions.FileTail(P(D("path", Path.Combine(root, "a.log")))), "text-roots.txt"); });
            HostActions.TextRootsFile = roots;
            test("file-tail returns the last N lines of a UTF-8 log", () => {
                string f = Path.Combine(root, "utf8.log"); File.WriteAllText(f, string.Join("\r\n", Enumerable.Range(1, 300).Select(i => "第" + i + "行 OK")) + "\r\n", new UTF8Encoding(false));
                var d = Common.Decode(HostActions.FileTail(P(D("path", f, "lines", 3)))); var lines = ((object[])d["lines"]).Cast<string>().ToArray();
                Check((string)d["encoding"] == "utf-8" && lines.Length == 3 && lines[2] == "第300行 OK" && lines[0] == "第298行 OK" && Common.N(d, "lines_scanned") == 300, "tail: " + Common.Encode(d));
            });
            test("file-tail reads Big5 logs", () => {
                string f = Path.Combine(root, "big5.log"); File.WriteAllBytes(f, Encoding.GetEncoding(950).GetBytes("開始\r\n錯誤：連線逾時\r\n"));
                var d = Common.Decode(HostActions.FileTail(P(D("path", f)))); var lines = ((object[])d["lines"]).Cast<string>().ToArray();
                Check((string)d["encoding"] == "big5" && lines.Length == 2 && lines[1] == "錯誤：連線逾時", "big5: " + Common.Encode(d));
            });
            test("file-tail reads UTF-16 with BOM", () => {
                string f = Path.Combine(root, "u16.log"); File.WriteAllText(f, "a\r\nb\r\n", Encoding.Unicode);
                var d = Common.Decode(HostActions.FileTail(P(D("path", f)))); Check((string)d["encoding"] == "utf-16" && ((object[])d["lines"]).Cast<string>().Last() == "b", "utf16");
            });
            test("file-tail contains filter", () => {
                string f = Path.Combine(root, "mix.log"); File.WriteAllText(f, "ok 1\nERROR x\nok 2\nerror y\nok 3\n");
                var d = Common.Decode(HostActions.FileTail(P(D("path", f, "contains", "error")))); var lines = ((object[])d["lines"]).Cast<string>().ToArray();
                Check(lines.Length == 2 && lines[0] == "ERROR x" && Common.N(d, "lines_matched") == 2, "filter");
            });
            test("file-tail on a large file reads only the last window and drops the cut first line", () => {
                string f = Path.Combine(root, "big.log"); var sb = new StringBuilder(); int i = 0; while (sb.Length < 3 * 1024 * 1024) sb.Append("行").Append(i++).Append(" 測試資料測試資料\n");
                File.WriteAllText(f, sb.ToString(), new UTF8Encoding(false));
                var d = Common.Decode(HostActions.FileTail(P(D("path", f, "lines", 2)))); var lines = ((object[])d["lines"]).Cast<string>().ToArray();
                Check((string)d["encoding"] == "utf-8" && lines[1] == "行" + (i - 1) + " 測試資料測試資料" && ((string)d["window"]).StartsWith("last"), "window: " + Common.Encode(d).Substring(0, 300));
            });
            test("file-tail caps output and refuses binary, outside-root and traversal paths", () => {
                string f = Path.Combine(root, "long.log"); File.WriteAllText(f, string.Join("\n", Enumerable.Range(1, 500).Select(i => new string('x', 200))));
                string r = HostActions.FileTail(P(D("path", f, "lines", 500))); Check(r.Length <= Common.MaxResult && (bool)Common.Decode(r)["truncated"], "bound");
                string bin = Path.Combine(root, "x.bin"); File.WriteAllBytes(bin, new byte[] { 1, 0, 2, 0 });
                Throws<InvalidDataException>(() => HostActions.FileTail(P(D("path", bin))), "binary");
                Throws<UnauthorizedAccessException>(() => HostActions.FileTail(P(D("path", outside))), "outside");
                Throws<UnauthorizedAccessException>(() => HostActions.FileTail(P(D("path", Path.Combine(root, "..\\" + Path.GetFileName(outside))))), "outside");
                Throws<InvalidDataException>(() => HostActions.FileTail(P(D("path", f, "lines", 501))), "lines");
            });
            test("text-roots and readonly-roots are separate: listing roots do not grant contents", () => {
                string ro = Path.Combine(work, "ro-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(ro); string f = Path.Combine(ro, "a.log"); File.WriteAllText(f, "x\n");
                Throws<UnauthorizedAccessException>(() => HostActions.FileTail(P(D("path", f))), "outside");
            });
            test("review: long-line logs are trimmed, not FAILED (400x1000 chars, and 2 MB without newlines)", () => {
                string f = Path.Combine(root, "wide.log"); File.WriteAllText(f, string.Join("\n", Enumerable.Range(1, 400).Select(i => i + new string('w', 1000))) + "\n");
                string r = HostActions.FileTail(P(D("path", f, "lines", 500))); var d = Common.Decode(r); var lines = ((object[])d["lines"]).Cast<string>().ToArray();
                Check(r.Length <= Common.MaxResult && (bool)d["truncated"] && lines.Last().StartsWith("400w"), "wide: " + r.Length);
                string g = Path.Combine(root, "oneline.log"); File.WriteAllText(g, new string('z', 2 * 1024 * 1024 + 10));
                var e = Common.Decode(HostActions.FileTail(P(D("path", g)))); Check((bool)e["long_lines_cut"] || ((object[])e["lines"]).Length == 0, "oneline");
            });
            test("review: UTF-16 big-endian, and UTF-16 larger than the window", () => {
                string f = Path.Combine(root, "be.log"); File.WriteAllText(f, "甲\r\n乙\r\n", Encoding.BigEndianUnicode);
                var d = Common.Decode(HostActions.FileTail(P(D("path", f)))); Check((string)d["encoding"] == "utf-16be" && ((object[])d["lines"]).Cast<string>().Last() == "乙", "be: " + Common.Encode(d));
                string g = Path.Combine(root, "big16.log"); var sb = new StringBuilder(); int i = 0; while (sb.Length < 1200 * 1024) sb.Append("列").Append(i++).Append("\r\n");
                File.WriteAllText(g, sb.ToString(), Encoding.Unicode);
                var e = Common.Decode(HostActions.FileTail(P(D("path", g, "lines", 1)))); Check((string)e["encoding"] == "utf-16" && ((object[])e["lines"]).Cast<string>().Single() == "列" + (i - 1), "big16: " + Common.Encode(e).Substring(0, 200));
            });
            test("review: alternate data streams and device paths are refused", () => {
                string f = Path.Combine(root, "mix.log");
                foreach (var p in new[] { f + ":hidden", "\\\\?\\" + f, "\\\\.\\" + f, f + "::$DATA" }) {
                    bool refused = false; try { HostActions.FileTail(P(D("path", p))); } catch (Exception ex) { refused = ex is UnauthorizedAccessException || ex is NotSupportedException || ex is ArgumentException || ex is InvalidDataException; }
                    Check(refused, "not refused: " + p);
                }
            });
            test("review: task program field never carries arguments", () => {
                Check(HostActions.ProgramOnly("cmd /c sqlcmd -P pw") == "cmd [text after the first space hidden]", "unquoted");
                Check(HostActions.ProgramOnly("\"C:\\Program Files\\x.exe\" -P pw") == "\"C:\\Program Files\\x.exe\"", "quoted");
                Check(HostActions.ProgramOnly("powershell.exe") == "powershell.exe", "plain");
            });
            test("review: secrets are redacted in their JSON-escaped form too", () => {
                var saved2 = Common.Secrets; Common.Secrets = new[] { "Ab<9\"x&'" };
                try { string s = Common.Safe(Common.Encode(new { cell = "pw=Ab<9\"x&' end" })); Check(!s.Contains("Ab") && s.Contains("[REDACTED]"), "leak: " + s); } finally { Common.Secrets = saved2; }
            });
            test("text-roots.txt and sql-config.txt writable by Users are refused", () => {
                string weak = Path.Combine(work, "weak-" + Guid.NewGuid().ToString("N") + ".txt"); File.WriteAllText(weak, root + "\r\n"); Protect(weak);
                var acl = File.GetAccessControl(weak); acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier("S-1-5-32-545"), System.Security.AccessControl.FileSystemRights.Modify, System.Security.AccessControl.AccessControlType.Allow)); File.SetAccessControl(weak, acl);
                HostActions.TextRootsFile = weak;
                Throws<UnauthorizedAccessException>(() => HostActions.FileTail(P(D("path", Path.Combine(root, "mix.log")))), "writable by");
                string savedCfg = SqlActions.ConfigFile; File.WriteAllText(weak, "server=localhost\r\ndatabase=X\r\n"); SqlActions.ConfigFile = weak;
                try { Throws<UnauthorizedAccessException>(() => SqlActions.LoadConfig(), "writable by"); } finally { SqlActions.ConfigFile = savedCfg; HostActions.TextRootsFile = roots; }
            });
        } finally { HostActions.TextRootsFile = saved; }
    }
}
