using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

// v3.2 (2026-10-01 night): read-only host actions for checking batch-job outcomes.
//   task-list  scheduled tasks with last/next run and result code. Action arguments are never returned (they can hold passwords).
//   file-tail  last lines of a text file under <state>\text-roots.txt (console-edited; absent = disabled). Separate from
//              readonly-roots.txt on purpose: those roots were approved for metadata only, not for contents.
namespace DbAgent {
public static class HostActions {
    public static string TextRootsFile = null;
    public const int MaxTailLines = 500, TailWindowBytes = 2 * 1024 * 1024, MaxTasks = 200;
    static readonly string[] Actions = { "task-list", "file-tail" };
    public static bool Handles(string action) { return Actions.Contains(action); }
    public static string Names { get { return string.Join(",", Actions); } }
    public static string Execute(string action, string prompt) {
        if (action == "task-list") return TaskList(prompt, new SchedulerSource());
        if (action == "file-tail") return FileTail(prompt);
        throw new InvalidOperationException("Action not allowed");
    }

    static Dictionary<string, object> Spec(string prompt, string keys) {
        var d = Common.Decode(prompt); var allowed = keys.Split(',');
        var bad = d.Keys.Where(k => !allowed.Contains(k)).ToList();
        if (bad.Count > 0) throw new InvalidDataException("Unknown field(s): " + string.Join(",", bad) + "; allowed: " + keys);
        return d;
    }
    static string OptStr(Dictionary<string, object> d, string k, int max) {
        object v; if (!d.TryGetValue(k, out v) || v == null) return null;
        var s = v as string; if (s == null || s.Length == 0 || s.Length > max) throw new InvalidDataException(k + " must be a nonempty string of at most " + max + " chars");
        return s;
    }
    static int OptInt(Dictionary<string, object> d, string k, int def, int min, int max) {
        object v; if (!d.TryGetValue(k, out v) || v == null) return def;
        long n; if (!(v is int || v is long) || !long.TryParse(v.ToString(), out n) || n < min || n > max) throw new InvalidDataException(k + " must be an integer " + min + "-" + max);
        return (int)n;
    }
    static bool OptBool(Dictionary<string, object> d, string k) { object v; if (!d.TryGetValue(k, out v) || v == null) return false; if (!(v is bool)) throw new InvalidDataException(k + " must be true/false"); return (bool)v; }
    static string Iso(DateTime t) { return t.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture); }

    // ---- task-list ----
    public sealed class TaskRow { public string Path, RunAs; public int State; public bool Enabled; public DateTime? LastRun, NextRun; public int LastResult, MissedRuns; public string[] Programs = new string[0]; }
    public interface ITaskSource { IEnumerable<TaskRow> Tasks(string folder, out int unreadableFolders); }
    public sealed class SchedulerSource : ITaskSource {
        // "Never" comes back as a placeholder date (observed 1999-11-30 on Windows 11, 1899-12-30 documented).
        static DateTime? When(object v) { var t = (DateTime)v; return t.Year < 2000 ? (DateTime?)null : t; }
        public IEnumerable<TaskRow> Tasks(string folder, out int unreadable) {
            var type = Type.GetTypeFromProgID("Schedule.Service"); if (type == null) throw new InvalidOperationException("Task Scheduler COM service unavailable");
            dynamic svc = Activator.CreateInstance(type); svc.Connect();
            var rows = new List<TaskRow>(); unreadable = 0; var stack = new Stack<dynamic>();
            try { stack.Push(svc.GetFolder(folder)); } catch (COMException) { throw new InvalidDataException("Task folder not found: " + folder); }
            while (stack.Count > 0) {
                dynamic f = stack.Pop();
                try {
                    foreach (dynamic t in f.GetTasks(1)) {   // 1 = TASK_ENUM_HIDDEN
                        var row = new TaskRow { Path = t.Path, State = t.State, Enabled = t.Enabled, LastRun = When(t.LastRunTime), NextRun = When(t.NextRunTime), LastResult = t.LastTaskResult, MissedRuns = t.NumberOfMissedRuns };
                        try {
                            dynamic def = t.Definition; row.RunAs = def.Principal.UserId;
                            var progs = new List<string>(); foreach (dynamic a in def.Actions) if ((int)a.Type == 0) progs.Add(ProgramOnly((string)a.Path)); row.Programs = progs.ToArray();
                        } catch (COMException) { row.RunAs = "(definition not readable)"; }
                        rows.Add(row);
                    }
                    foreach (dynamic sub in f.GetFolders(0)) stack.Push(sub);
                } catch (COMException) { unreadable++; } catch (UnauthorizedAccessException) { unreadable++; }
            }
            return rows;
        }
    }
    static readonly string[] StateNames = { "unknown", "disabled", "queued", "ready", "running" };
    public static string ResultText(int code) {
        switch ((uint)code) {
            case 0: return "success"; case 0x41300: return "ready"; case 0x41301: return "running"; case 0x41302: return "disabled";
            case 0x41303: return "never run"; case 0x41306: return "terminated by user"; case 0x8004131F: return "already running (new instance refused)";
            case 0x800710E0: return "refused by operator/policy"; case 0xC000013A: return "terminated (Ctrl+C / closed)";
        }
        return code > 0 && code < 0x10000 ? "exit code " + code : "error 0x" + ((uint)code).ToString("X8", CultureInfo.InvariantCulture);
    }
    public static string TaskList(string prompt, ITaskSource source) {
        var d = Spec(prompt, "folder,name_like,include_microsoft,failed_only,top");
        string folder = OptStr(d, "folder", 260) ?? "\\", like = OptStr(d, "name_like", 128); bool ms = OptBool(d, "include_microsoft"), failedOnly = OptBool(d, "failed_only"); int top = OptInt(d, "top", 100, 1, MaxTasks);
        if (!folder.StartsWith("\\") || folder.Contains("..")) throw new InvalidDataException("folder must be a Task Scheduler path such as \\ or \\MyJobs");
        int unreadable; var all = source.Tasks(folder, out unreadable)
            .Where(t => ms || !t.Path.StartsWith("\\Microsoft\\", StringComparison.OrdinalIgnoreCase))
            .Where(t => like == null || t.Path.IndexOf(like, StringComparison.OrdinalIgnoreCase) >= 0)
            .Where(t => !failedOnly || (t.LastRun != null && t.LastResult != 0 && (uint)t.LastResult != 0x41301))
            .OrderBy(t => t.Path, StringComparer.OrdinalIgnoreCase).ToList();
        var items = all.Take(top).Select(t => new Dictionary<string, object> {
            { "path", t.Path }, { "state", t.State >= 0 && t.State < StateNames.Length ? StateNames[t.State] : t.State.ToString(CultureInfo.InvariantCulture) }, { "enabled", t.Enabled },
            { "last_run", t.LastRun == null ? null : Iso(t.LastRun.Value) }, { "last_result", t.LastRun == null ? "never run" : ResultText(t.LastResult) }, { "last_result_code", t.LastResult },
            { "next_run", t.NextRun == null ? null : Iso(t.NextRun.Value) }, { "missed_runs", t.MissedRuns }, { "run_as", t.RunAs }, { "programs", t.Programs } }).ToList();
        var result = new Dictionary<string, object> { { "kind", "task_list" }, { "host_time", Iso(DateTime.Now) }, { "folder", folder }, { "total", all.Count }, { "unreadable_folders", unreadable }, { "note", "times are host local time; action arguments are never returned" } };
        return Fit(result, "items", items.Cast<object>().ToList(), false);
    }
    // Program field only: a task created with the whole command line in it would otherwise expose its arguments.
    public static string ProgramOnly(string p) {
        p = (p ?? "").Trim();
        if (p.StartsWith("\"")) { int end = p.IndexOf('"', 1); return end > 0 ? p.Substring(0, end + 1) : p; }
        int sp = p.IndexOf(' '); if (sp < 0 || File.Exists(Environment.ExpandEnvironmentVariables(p))) return p;
        return p.Substring(0, sp) + " [text after the first space hidden]";
    }
    // Add list items one at a time: encoding everything first can exceed the serializer's own limit before any trimming.
    static string Fit(Dictionary<string, object> result, string key, List<object> items, bool keepLast) {
        result[key] = new List<object>(); result["truncated"] = false;
        int budget = Common.MaxResult - Common.Encode(result).Length, kept = 0;
        var picked = new List<object>();
        foreach (var it in keepLast ? Enumerable.Reverse(items) : items) { int len = Common.Encode(it).Length + (kept == 0 ? 0 : 1); if (len > budget) break; budget -= len; kept++; picked.Add(it); }
        if (keepLast) picked.Reverse();
        result[key] = picked; result["truncated"] = picked.Count < items.Count;
        return Common.Encode(result);
    }

    // ---- file-tail ----
    public static string FileTail(string prompt) {
        var d = Spec(prompt, "path,lines,contains");
        string raw = OptStr(d, "path", 260); if (raw == null) throw new InvalidDataException("Missing field: path");
        int want = OptInt(d, "lines", 100, 1, MaxTailLines); string contains = OptStr(d, "contains", 128);
        var roots = ReadOnlyFiles.RootsFromLines(DocQa.ReadProtectedLines(TextRootsFile, "text-roots.txt (file-tail)"), "text-roots.txt");
        string path = ReadOnlyFiles.ResolveWithin(raw, roots, "text roots");
        if (!File.Exists(path)) throw new FileNotFoundException("File not found");
        var fi = new FileInfo(path); byte[] bytes, head = new byte[3]; bool partial; int headLen;
        using (var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            headLen = s.Read(head, 0, 3);
            long start = Math.Max(0, s.Length - TailWindowBytes); partial = start > 0; s.Seek(start, SeekOrigin.Begin);
            bytes = new byte[s.Length - start]; int off = 0, n; while (off < bytes.Length && (n = s.Read(bytes, off, bytes.Length - off)) > 0) off += n;
            if (off < bytes.Length) Array.Resize(ref bytes, off);
        }
        string encoding; string text = DecodeText(bytes, head.Take(headLen).ToArray(), partial, out encoding);
        var lines = text.Split('\n').Select(l => l.TrimEnd('\r')).ToList();
        if (partial && lines.Count > 0) lines.RemoveAt(0);   // first line of a window that starts mid-file is cut
        if (lines.Count > 0 && lines[lines.Count - 1].Length == 0) lines.RemoveAt(lines.Count - 1);
        int scanned = lines.Count;
        if (contains != null) lines = lines.Where(l => l.IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
        bool cut = false;
        var tail = lines.Skip(Math.Max(0, lines.Count - want)).Select(l => { if (l.Length <= MaxLineChars) return (object)l; cut = true; return l.Substring(0, MaxLineChars) + "...[" + l.Length + " chars]"; }).ToList();
        var result = new Dictionary<string, object> { { "kind", "file_tail" }, { "path", path }, { "size_bytes", fi.Length }, { "modified", Iso(fi.LastWriteTime) }, { "encoding", encoding },
            { "window", partial ? "last " + TailWindowBytes + " bytes" : "whole file" }, { "lines_scanned", scanned }, { "filter", contains }, { "lines_matched", lines.Count }, { "long_lines_cut", cut } };
        return Fit(result, "lines", tail, true);
    }
    public const int MaxLineChars = 2000;
    // head = the file's first bytes (byte-order mark); b = the tail window, which equals the whole file when !partial.
    public static string DecodeText(byte[] b, byte[] head, bool partial, out string encoding) {
        bool le = head.Length >= 2 && head[0] == 0xFF && head[1] == 0xFE, be = head.Length >= 2 && head[0] == 0xFE && head[1] == 0xFF;
        if (le || be) {
            int skip = partial ? 0 : 2;   // the window size is even, so it stays 2-byte aligned with a well-formed UTF-16 file
            encoding = le ? "utf-16" : "utf-16be";
            return (le ? Encoding.Unicode : Encoding.BigEndianUnicode).GetString(b, skip, b.Length - skip);
        }
        if (!partial && b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) { encoding = "utf-8"; return new UTF8Encoding(false).GetString(b, 3, b.Length - 3); }
        int sample = Math.Min(b.Length, 8192);
        for (int i = 0; i < sample; i++) if (b[i] == 0) throw new InvalidDataException("File looks binary (NUL bytes); file-tail reads text files only");
        int lead = 0; if (partial) while (lead < b.Length && lead < 3 && (b[lead] & 0xC0) == 0x80) lead++;   // drop a split UTF-8 sequence at the window start
        try { encoding = "utf-8"; return new UTF8Encoding(false, true).GetString(b, lead, b.Length - lead); }
        catch (DecoderFallbackException) { encoding = "big5"; return Encoding.GetEncoding(950).GetString(b); }
    }
}
}
