using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace DbAgent {
// 逐字核對（2026-09-30）：規則與 tools\local_qa\lib\grounding.cjs 相同，另有逐題一致性測試（grounding-parity.json）。
// 答案裡的日期、時間、帶單位的數字、代碼／表名／檔名／路徑、條號，要在引用段落（加上問題、查詢日期、對話紀錄、系統提示）找得到。
//   red：所有檢索段落都找不到（推算、常識或模型自己加的）；yellow：引用的段落沒有，但其他檢索段落有（出處可能引錯）。
// 只看寫法有沒有出處，不判斷意思對不對。注意：.NET 的 \w、\d 含中文與其他文字，這裡一律寫成明確的 ASCII 範圍。
public static class Grounding {
    const string D = "[0-9]", W = "[A-Za-z0-9_]";
    static readonly string[] Units = { "個營業日", "營業日", "個月", "小時", "分鐘", "工作天", "日曆日", "天", "日", "年", "月", "週", "周", "%", "萬元", "億元", "萬", "億", "元", "筆", "次", "倍", "張", "檔", "人", "家", "檔股票", "頁", "條", "點", "bp", "bps" };
    static readonly string UnitRe = string.Join("|", Units.OrderByDescending(u => u.Length).Select(Regex.Escape));
    static readonly HashSet<string> Stop = new HashSet<string> { "as_of_date", "user_context", "doc_id", "chunk_id", "status", "answer", "no_info", "conflict", "denied" };
    static readonly Dictionary<string,int> Zh = new Dictionary<string,int> { {"零",0},{"〇",0},{"一",1},{"二",2},{"兩",2},{"三",3},{"四",4},{"五",5},{"六",6},{"七",7},{"八",8},{"九",9},{"十",10} };
    static readonly string[] Dig = { "", "一", "二", "三", "四", "五", "六", "七", "八", "九" };
    static string ZhNum(int n) { if (n >= 1 && n <= 10) return n == 10 ? "十" : Dig[n]; if (n >= 11 && n < 20) return "十" + Dig[n - 10]; if (n >= 20 && n < 100) return Dig[n / 10] + "十" + Dig[n % 10]; return ""; }
    static string N(string s) { return (s ?? "").Normalize(NormalizationForm.FormKC); }
    static string Pad(string n) { return n.PadLeft(2, '0'); }
    // 和 JS Number() 一樣：超長的數字串當成無限大，不讓舊版 .NET 的 double.Parse 丟例外
    static double Num(string s) { double v; return double.TryParse(s.Replace(",", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : double.PositiveInfinity; }

    static readonly Regex CiteRe = new Regex(@"`?\[[^\[\]]*#" + D + @"+(?:-" + D + @"+)?\]`?");
    static readonly Regex FieldCiteRe = new Regex(@"`?\[(?:doc_id|chunk_id|MAP:[^\]]*)\]`?", RegexOptions.IgnoreCase);
    static readonly Regex StatusLineRe = new Regex(@"^\s*STATUS:.*$", RegexOptions.IgnoreCase | RegexOptions.Multiline);
    static readonly Regex DateRe = new Regex("(" + D + @"{4})\s*[-/.年]\s*(" + D + @"{1,2})\s*[-/.月]\s*(" + D + @"{1,2})\s*日?");
    // 民國日期（115年3月23日、115/03/23）換成西元再比
    static readonly Regex RocYmdRe = new Regex(@"(?<![0-9])([0-9]{2,3})\s*年\s*([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日");
    static readonly Regex RocSlashRe = new Regex(@"(?<![0-9/])(1[0-9]{2})/([0-9]{1,2})/([0-9]{1,2})(?![0-9/])");
    static readonly Regex MonthDayRe = new Regex(@"(?<!" + D + @"[\s\-/.年]*)(?<!" + D + ")(" + D + @"{1,2})\s*月\s*(" + D + @"{1,2})\s*日");
    static readonly Regex ClockRe = new Regex(@"(?<![0-9:])(" + D + "{1,2}):(" + D + "{2})(?![0-9:])");
    static readonly Regex HourRe = new Regex(@"(?<!第\s*)(?<!" + D + ")(" + D + @"{1,2})\s*點(\s*半)?(?!\s*" + D + ")");
    static readonly Regex PmRe = new Regex(@"(下午|晚上|傍晚)\s*$");
    static readonly Regex QtyRe = new Regex(@"(?<![A-Za-z0-9_.\-])(" + D + "[0-9,]*(?:\\." + D + @"+)?)\s*(" + UnitRe + ")");
    static readonly Regex ArticleRe = new Regex(@"第\s*(" + D + @"{1,3})\s*(條|點|項|章|款)");
    static readonly Regex BacktickRe = new Regex("`([^`\\n]{2,80})`");
    // 路徑：全形標點正規化後變半形（，→, ：→: （→(），也當成結尾；尾端緊接的中文字不算路徑
    static readonly Regex PathRe = new Regex(@"[A-Za-z]:\\[^\s，。、；;）)」』*`,:!?(]+|\\\\[^\s，。、；;）)」』*`,:!?(]+");
    static readonly Regex WordRe = new Regex(@"(?<![A-Za-z0-9_\\])[A-Za-z_\[][A-Za-z0-9_.\-\[\]$]*[A-Za-z0-9_\]]");
    static readonly Regex AnyNumRe = new Regex(D + "[0-9,]*(?:\\." + D + "+)?");

    static string ClaimText(string answer) { return StatusLineRe.Replace(FieldCiteRe.Replace(CiteRe.Replace(N(answer), " "), " "), " "); }
    static HashSet<string> Dates(string t) {
        var o = new HashSet<string>(); foreach (Match m in DateRe.Matches(t)) o.Add(m.Groups[1].Value + "-" + Pad(m.Groups[2].Value) + "-" + Pad(m.Groups[3].Value));
        foreach (var re in new[] { RocYmdRe, RocSlashRe }) foreach (Match m in re.Matches(t)) {
            int y = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), mo = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture), d = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
            if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) o.Add((y + 1911).ToString(CultureInfo.InvariantCulture) + "-" + Pad(m.Groups[2].Value) + "-" + Pad(m.Groups[3].Value));
        }
        return o;
    }
    static HashSet<string> MonthDays(string t) { var o = new HashSet<string>(); foreach (Match m in MonthDayRe.Matches(t)) o.Add(Pad(m.Groups[1].Value) + "-" + Pad(m.Groups[2].Value)); return o; }
    // 12 小時制：前面有「下午／晚上／傍晚」的 1–11 點換成 24 小時制；「3 點半」＝3:30。原文（both）兩種寫法都收，答案只收換算後的寫法。
    static HashSet<string> Times(string t, bool both = false) {
        var o = new HashSet<string>();
        Action<string,string,int> add = (h, mm, at) => {
            int hour = int.Parse(h, CultureInfo.InvariantCulture), from = Math.Max(0, at - 4);
            bool pm = hour >= 1 && hour <= 11 && PmRe.IsMatch(t.Substring(from, at - from));
            if (pm) o.Add((hour + 12).ToString(CultureInfo.InvariantCulture).PadLeft(2, '0') + ":" + mm);
            if (!pm || both) o.Add(Pad(h) + ":" + mm);
        };
        foreach (Match m in ClockRe.Matches(t)) add(m.Groups[1].Value, m.Groups[2].Value, m.Index);
        foreach (Match m in HourRe.Matches(t)) add(m.Groups[1].Value, m.Groups[2].Success ? "30" : "00", m.Index);   // 「第 4 點」是條號不是時間
        if (t.Contains("中午")) o.Add("12:00");
        return o;
    }
    sealed class Qty { public string Raw; public double Num; public string Unit; }
    static List<Qty> Quantities(string t) {
        var o = new List<Qty>();
        foreach (Match m in QtyRe.Matches(t)) o.Add(new Qty { Raw = Regex.Replace(m.Value, @"\s+", ""), Num = Num(m.Groups[1].Value), Unit = m.Groups[2].Value });
        return o;
    }
    static double Scaled(Qty q) { return q.Unit.StartsWith("萬", StringComparison.Ordinal) ? q.Num * 1e4 : q.Unit.StartsWith("億", StringComparison.Ordinal) ? q.Num * 1e8 : q.Num; }
    static List<string> Identifiers(string t) {
        var o = new List<string>();
        Action<string> add = s => { if (!o.Contains(s)) o.Add(s); };
        foreach (Match m in BacktickRe.Matches(t)) if (!Regex.IsMatch(m.Groups[1].Value, "[，。、；：「」（）！？]")) add(m.Groups[1].Value.Trim());
        foreach (Match m in PathRe.Matches(t)) add(Regex.Replace(m.Value, @"[㐀-鿿]+$", ""));
        foreach (Match m in WordRe.Matches(t)) { string w = m.Value; if (Regex.IsMatch(w, @"[_.\\]") || (Regex.IsMatch(w, "[A-Za-z]") && Regex.IsMatch(w, D))) add(w); }
        var result = new List<string>();
        foreach (var x in o.Select(x => Regex.Replace(Regex.Replace(x, @"^[\[(]+", ""), @"[\])，。.,:;]+$", "")))
            if (x.Length >= 3 && !Regex.IsMatch(x, @"^v?" + D + @"+(\." + D + @"+)*$", RegexOptions.IgnoreCase) && !Stop.Contains(x.ToLowerInvariant()) && !result.Contains(x)) result.Add(x);
        return result;
    }
    static HashSet<string> Articles(string t) { var o = new HashSet<string>(); foreach (Match m in ArticleRe.Matches(t)) o.Add("第" + m.Groups[1].Value + m.Groups[2].Value); return o; }

    sealed class Source { public string T, Lower, Compact, CompactNoBr; public HashSet<string> Dates, MonthDays, Times, Articles; public HashSet<double> Nums; }
    static Source Index(string text) {
        string t = N(text), lower = t.ToLowerInvariant(), compact = Regex.Replace(lower, @"\s+", "").Replace('/', '\\');
        var s = new Source { T = t, Lower = lower, Compact = compact, CompactNoBr = compact.Replace("[", "").Replace("]", ""), Dates = Dates(t), Times = Times(t, true), Articles = Articles(t), Nums = new HashSet<double>() };
        s.MonthDays = new HashSet<string>(MonthDays(t)); foreach (var d in s.Dates) s.MonthDays.Add(d.Substring(5));
        foreach (Match m in AnyNumRe.Matches(t)) s.Nums.Add(Num(m.Value));
        foreach (var q in Quantities(t)) s.Nums.Add(Scaled(q));
        return s;
    }
    sealed class Claim { public string Kind, Key, Text; public Qty Q; }
    static bool Found(Claim c, Source s) {
        switch (c.Kind) {
            case "date": return s.Dates.Contains(c.Key);
            case "monthday": return s.MonthDays.Contains(c.Key);
            case "time": return s.Times.Contains(c.Key);
            case "article": {
                if (s.Articles.Contains(c.Key)) return true;
                int n = int.Parse(Regex.Match(c.Key, D + "+").Value, CultureInfo.InvariantCulture); string zh = ZhNum(n), alt = n.ToString(CultureInfo.InvariantCulture) + (zh.Length > 0 ? "|" + zh : "");
                return Regex.IsMatch(s.T, @"第\s*(?:" + alt + @")\s*[條點項章款]|(?:^|[\n#\s/])(?:" + alt + @")\s*[.、．]");
            }
            case "id": {
                string k = Regex.Replace(c.Key.ToLowerInvariant().Replace('/', '\\'), @"^\[|\]$", ""), kc = Regex.Replace(k, @"\s+", "").Replace("[", "").Replace("]", "");
                return s.Lower.Contains(k) || s.Compact.Contains(kc) || s.CompactNoBr.Contains(kc);
            }
            case "qty": {
                var q = c.Q; if (s.Nums.Contains(q.Num) || s.Nums.Contains(Scaled(q))) return true;
                if (q.Num == Math.Floor(q.Num) && q.Num <= 10) {
                    string unit = q.Unit.StartsWith("個", StringComparison.Ordinal) ? q.Unit.Substring(1) : q.Unit;
                    foreach (var z in Zh.Where(kv => kv.Value == (int)q.Num).Select(kv => kv.Key))
                        if (Regex.IsMatch(s.T, Regex.Escape(z) + @"\s*(?:個)?\s*" + Regex.Escape(unit))) return true;
                }
                return false;
            }
        }
        return true;
    }
    static List<Claim> ClaimsOf(string answer) {
        string t = ClaimText(answer); var claims = new List<Claim>(); var seen = new HashSet<string>();
        Action<string,string,string,Qty> add = (kind, key, shown, q) => { if (seen.Add(kind + "|" + key)) claims.Add(new Claim { Kind = kind, Key = key, Text = shown, Q = q }); };
        var ds = Dates(t); foreach (var d in ds) add("date", d, d, null);
        foreach (var md in MonthDays(t)) if (!ds.Any(d => d.EndsWith(md, StringComparison.Ordinal))) add("monthday", md, md.Replace("-", "/"), null);
        foreach (var x in Times(t)) add("time", x, x, null);
        foreach (var a in Articles(t)) add("article", a, a, null);
        // 其他數量：先拿掉日期、月日、時間、條號，免得「3 月 20 日」的 3 月、20 日被當成數量
        string rest = RocYmdRe.Replace(DateRe.Replace(t, " "), " ");
        rest = Regex.Replace(rest, "(" + D + @"{1,2})\s*月\s*(" + D + @"{1,2})\s*日", " ");
        rest = ClockRe.Replace(rest, " ");
        rest = Regex.Replace(rest, "(" + D + @"{1,2})\s*點", " ");
        rest = Regex.Replace(rest, @"第\s*" + D + @"{1,3}\s*(條|點|項|章|款)", " ");
        foreach (var q in Quantities(rest)) if (!(q.Unit == "年" && q.Num >= 1900)) add("qty", q.Raw, q.Raw, q);
        foreach (var id in Identifiers(t)) add("id", id, id, null);
        return claims;
    }
    // cited、visible：段落文字（每段含標題、版本、日期等欄位與內文）；extra：問題、查詢日期、對話紀錄、系統提示
    public static void Check(string answer, IEnumerable<string> cited, IEnumerable<string> visible, string extra, out List<string> red, out List<string> yellow) {
        var citedSrc = Index(string.Join("\n", cited.Concat(new[] { extra ?? "" })));
        var allSrc = Index(string.Join("\n", visible.Concat(new[] { extra ?? "" })));
        red = new List<string>(); yellow = new List<string>();
        foreach (var c in ClaimsOf(answer)) {
            if (Found(c, citedSrc)) continue;
            (Found(c, allSrc) ? yellow : red).Add(c.Text);
        }
    }
}
}
