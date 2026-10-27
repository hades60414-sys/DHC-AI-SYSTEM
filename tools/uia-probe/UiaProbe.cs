// UIA probe (2026-10-02, Agent S follow-up step 2): can a program be driven through its UI Automation tree instead of the screen?
// Read-only. It never clicks, types, or screenshots, and its output carries no on-screen text: only process names, counts by
// control type / framework / pattern, and a verdict. Safe to paste back into chat.
//   uia-probe.exe list               process names that own a visible top-level window (names only, no window titles)
//   uia-probe.exe probe <name>       statistics for every top-level window of that process (name without .exe)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Windows.Automation;

static class UiaProbe
{
    const int MaxElements = 5000, MaxSeconds = 60;
    static readonly bool Trace = Environment.GetEnvironmentVariable("UIAPROBE_TRACE") == "1";
    // Controls a person clicks or fills in; if these carry a name or AutomationId, a decision layer can address them by text.
    static readonly HashSet<string> Actionable = new HashSet<string> { "Button", "Edit", "ComboBox", "CheckBox", "RadioButton", "MenuItem", "Hyperlink", "ListItem", "TabItem", "DataItem", "TreeItem", "SplitButton", "Spinner", "Slider" };
    // Remote-session clients draw a picture of another machine: the tree is empty by design.
    static readonly string[] RemoteClients = { "mstsc", "wfica32", "cdviewer", "vmware-view", "msrdc" };

    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 1 && args[0] == "list") { Console.WriteLine(ListProcesses()); return 0; }
            if (args.Length == 2 && args[0] == "probe") { Console.WriteLine(Probe(args[1])); return 0; }
            Console.WriteLine("usage: uia-probe.exe list | uia-probe.exe probe <process-name>");
            return 1;
        }
        catch (Exception e) { Console.WriteLine("{\"ok\":false,\"error\":" + Json(e.GetType().Name) + "}"); return 5; }
    }

    static List<AutomationElement> TopWindows()
    {
        return AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition).Cast<AutomationElement>().ToList();
    }

    static string ProcessName(int pid)
    {
        try { return Process.GetProcessById(pid).ProcessName; } catch { return "?"; }
    }

    static string ListProcesses()
    {
        var names = new SortedDictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var w in TopWindows())
        {
            string n = ProcessName(w.Current.ProcessId);
            names[n] = (names.ContainsKey(n) ? names[n] : 0) + 1;
        }
        return "{\"ok\":true,\"processes\":{" + string.Join(",", names.Select(kv => Json(kv.Key) + ":" + kv.Value)) + "}}";
    }

    internal sealed class Stats
    {
        public int Windows, Elements, Actionable, ActionableAddressable, Named, WithId, Offscreen;
        public bool Truncated;
        public readonly Dictionary<string, int> ByType = new Dictionary<string, int>(), ByFramework = new Dictionary<string, int>(), Patterns = new Dictionary<string, int>();
    }

    static void Bump(Dictionary<string, int> d, string k) { d[k] = (d.ContainsKey(k) ? d[k] : 0) + 1; }

    static string Probe(string name)
    {
        name = name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name.Substring(0, name.Length - 4) : name;
        var sw = Stopwatch.StartNew();
        var s = new Stats();
        foreach (var w in TopWindows())
        {
            if (!string.Equals(ProcessName(w.Current.ProcessId), name, StringComparison.OrdinalIgnoreCase)) continue;
            s.Windows++;
            Walk(w, s, sw);
        }
        string verdict = Verdict(name, s);
        var sb = new StringBuilder("{\"ok\":true,\"process\":" + Json(name) + ",\"windows\":" + s.Windows + ",\"elements\":" + s.Elements
            + ",\"truncated\":" + (s.Truncated ? "true" : "false") + ",\"named\":" + s.Named + ",\"with_automation_id\":" + s.WithId
            + ",\"offscreen\":" + s.Offscreen + ",\"actionable\":" + s.Actionable + ",\"actionable_addressable\":" + s.ActionableAddressable
            + ",\"by_type\":" + Map(s.ByType) + ",\"by_framework\":" + Map(s.ByFramework) + ",\"patterns\":" + Map(s.Patterns)
            + ",\"ms\":" + sw.ElapsedMilliseconds + ",\"verdict\":" + Json(verdict) + "}");
        return sb.ToString();
    }

    static void Walk(AutomationElement e, Stats s, Stopwatch sw)
    {
        if (s.Elements >= MaxElements || sw.Elapsed.TotalSeconds > MaxSeconds) { s.Truncated = true; return; }
        AutomationElement.AutomationElementInformation c;
        try { c = e.Current; } catch (ElementNotAvailableException) { return; }
        s.Elements++;
        if (Trace && (s.Elements <= 20 || s.Elements % 100 == 0)) Console.Error.WriteLine("elements " + s.Elements + " " + sw.ElapsedMilliseconds + "ms");
        string type = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
        Bump(s.ByType, type);
        Bump(s.ByFramework, string.IsNullOrEmpty(c.FrameworkId) ? "(none)" : c.FrameworkId);
        bool named = !string.IsNullOrWhiteSpace(c.Name), hasId = !string.IsNullOrWhiteSpace(c.AutomationId);
        if (named) s.Named++;
        if (hasId) s.WithId++;
        if (c.IsOffscreen) s.Offscreen++;
        if (Actionable.Contains(type)) { s.Actionable++; if (named || hasId) s.ActionableAddressable++; }
        foreach (var p in e.GetSupportedPatterns()) Bump(s.Patterns, p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "").Replace("Identifiers.Pattern", ""));
        AutomationElement child;
        try { child = TreeWalker.ControlViewWalker.GetFirstChild(e); } catch (ElementNotAvailableException) { return; }
        while (child != null)
        {
            Walk(child, s, sw);
            try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch (ElementNotAvailableException) { return; }
        }
    }

    internal static string Verdict(string name, Stats s)
    {
        if (s.Windows == 0) return "找不到這個程序的視窗：先開好程式，再用 list 看正確的程序名稱。";
        if (RemoteClients.Contains(name.ToLowerInvariant())) return "這是遠端連線程式，畫面是另一台電腦的圖，讀不到樹：要在遠端那台電腦上探測。";
        if (s.Elements <= 5 || s.Actionable == 0) return "讀不到樹：若程式剛開啟，等畫面完全載入後再測一次；仍然如此就是自繪介面或遠端應用程式，方案 B 不適用。";
        double ratio = (double)s.ActionableAddressable / s.Actionable;
        if (s.Actionable >= 5 && ratio >= 0.8) return "樹完整：可操作元件 " + s.Actionable + " 個、" + Math.Round(ratio * 100) + "% 有名稱或代號，方案 B（讀樹＋結構化操作）可行。";
        return "部分可讀：可操作元件 " + s.Actionable + " 個、只有 " + Math.Round(ratio * 100) + "% 有名稱或代號，要逐畫面確認目標元件。";
    }

    static string Map(Dictionary<string, int> d)
    {
        return "{" + string.Join(",", d.OrderByDescending(kv => kv.Value).Select(kv => Json(kv.Key) + ":" + kv.Value)) + "}";
    }

    static string Json(string v)
    {
        var sb = new StringBuilder("\"");
        foreach (char ch in v ?? "")
        {
            if (ch == '"') sb.Append("\\\""); else if (ch == '\\') sb.Append("\\\\");
            else if (ch < 0x20) sb.Append("\\u" + ((int)ch).ToString("x4")); else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }
}
