using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

// v3.2 (2026-10-01): read-only SQL actions. The brain sends a structured JSON spec, never SQL text. The agent builds every
// SELECT itself: the database must be listed in <state>\sql-config.txt (console-edited), table/column names must exist in
// the sys catalog before they are bracket-quoted, and every value is a typed parameter. Each query runs inside a transaction
// that is always rolled back, with LOCK_TIMEOUT 5 s, DEADLOCK_PRIORITY LOW and a 15 s command timeout. Windows integrated auth; no password stored.
namespace DbAgent {
public sealed class SqlConfig { public string Server; public string[] Databases; }
public sealed class SqlResult { public string[] Columns = new string[0]; public List<object[]> Rows = new List<object[]>(); public bool More; }
public interface ISqlRunner { SqlResult Query(string database, string sql, IList<SqlParameter> parameters, int maxRows); }

public sealed class SqlServerRunner : ISqlRunner {
    readonly SqlConfig cfg;
    public SqlServerRunner(SqlConfig c) { cfg = c; }
    public SqlResult Query(string database, string sql, IList<SqlParameter> parameters, int maxRows) {
        var b = new SqlConnectionStringBuilder { DataSource = cfg.Server, InitialCatalog = database, IntegratedSecurity = true, ApplicationName = "dbclone-agent-sql", ConnectTimeout = 10, Pooling = false, ApplicationIntent = ApplicationIntent.ReadOnly };
        try {
            using (var conn = new SqlConnection(b.ConnectionString)) {
                conn.Open();
                using (var tx = conn.BeginTransaction(IsolationLevel.ReadCommitted)) {
                    try {
                        using (var cmd = conn.CreateCommand()) {
                            // Production server: lose deadlocks to real work and keep any schema-stability lock short.
                            cmd.Transaction = tx; cmd.CommandTimeout = 15; cmd.CommandText = "SET LOCK_TIMEOUT 5000; SET DEADLOCK_PRIORITY LOW;\n" + sql;
                            foreach (var p in parameters) cmd.Parameters.Add(p);
                            using (var r = cmd.ExecuteReader()) {
                                var res = new SqlResult { Columns = Enumerable.Range(0, r.FieldCount).Select(r.GetName).ToArray() };
                                while (r.Read()) {
                                    if (res.Rows.Count >= maxRows) { res.More = true; cmd.Cancel(); break; }
                                    var row = new object[r.FieldCount];
                                    for (int i = 0; i < row.Length; i++) { try { row[i] = r.GetValue(i); } catch (OverflowException) { row[i] = r.GetSqlValue(i).ToString(); } }
                                    res.Rows.Add(row);
                                }
                                return res;
                            }
                        }
                    } finally { try { tx.Rollback(); } catch (InvalidOperationException) { } catch (SqlException) { } }
                }
            }
        } catch (SqlException e) {
            string hint = e.Number == 1222 ? " (rows are locked by another transaction, often a running batch job; nothing was waited on longer than 5 s. Retry later or narrow the where)"
                : e.Number == -2 ? " (query exceeded 15 s; add a where on an indexed/key column or narrow the date range)"
                : e.Number == 1205 ? " (chosen as deadlock victim on purpose so production work wins; retry later)" : "";
            throw new InvalidOperationException("SQL error " + e.Number + ": " + e.Message + hint);
        }
    }
}

public static class SqlActions {
    public static string ConfigFile = null;
    public static Func<SqlConfig, ISqlRunner> Runner = c => new SqlServerRunner(c);
    public const int MaxOut = Common.MaxResult, MaxTop = 200, MaxCell = 200, MaxConds = 10, MaxInValues = 100, MaxGapDays = 3700;
    static readonly string[] Actions = { "sql-ping", "sql-tables", "sql-columns", "sql-select", "sql-agg", "sql-date-gaps", "sql-fingerprint" };
    static readonly string[] Unselectable = { "geography", "geometry", "hierarchyid", "sql_variant", "timestamp", "image", "varbinary", "binary" };
    public static bool Handles(string action) { return Actions.Contains(action); }
    public static string Names { get { return string.Join(",", Actions); } }

    // ---- config ----
    public static SqlConfig LoadConfig() {
        if (ConfigFile == null || !File.Exists(ConfigFile)) throw new InvalidOperationException("SQL actions disabled: sql-config.txt is not configured on the VM");
        return ParseConfig(DocQa.ReadProtectedLines(ConfigFile, "sql-config.txt"));
    }
    public static SqlConfig ParseConfig(IEnumerable<string> lines) {
        string server = null; var dbs = new List<string>();
        foreach (var raw in lines) {
            string l = raw.Trim(); if (l.Length == 0 || l.StartsWith("#")) continue;
            int eq = l.IndexOf('='); if (eq <= 0) throw new InvalidDataException("sql-config.txt: expected key=value lines");
            string k = l.Substring(0, eq).Trim().ToLowerInvariant(), v = l.Substring(eq + 1).Trim();
            if (k == "server") {
                if (server != null) throw new InvalidDataException("sql-config.txt: server listed twice");
                if (!Regex.IsMatch(v, @"^[A-Za-z0-9._\-\\,()]{1,128}$")) throw new InvalidDataException("sql-config.txt: invalid server value");
                server = v;
            } else if (k == "database") {
                if (!Regex.IsMatch(v, @"^[\p{L}\p{Nd}_\-. $#@]{1,128}$")) throw new InvalidDataException("sql-config.txt: invalid database name");
                if (!dbs.Contains(v, StringComparer.OrdinalIgnoreCase)) dbs.Add(v);
            } else throw new InvalidDataException("sql-config.txt: unknown key " + k);
        }
        if (server == null || dbs.Count == 0 || dbs.Count > 50) throw new InvalidDataException("sql-config.txt must contain one server= line and 1-50 database= lines");
        return new SqlConfig { Server = server, Databases = dbs.ToArray() };
    }

    // ---- spec helpers ----
    static Dictionary<string, object> Spec(string prompt, string keys) {
        var d = Common.Decode(prompt); var allowed = keys.Split(',');
        var bad = d.Keys.Where(k => !allowed.Contains(k)).ToList();
        if (bad.Count > 0) throw new InvalidDataException("Unknown field(s): " + string.Join(",", bad) + "; allowed: " + keys);
        return d;
    }
    static object Get(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v : null; }
    static string Str(Dictionary<string, object> d, string k, bool required) {
        object v = Get(d, k);
        if (v == null) { if (required) throw new InvalidDataException("Missing field: " + k); return null; }
        var s = v as string; if (s == null || s.Trim().Length == 0 || s.Length > 260) throw new InvalidDataException("Field must be a nonempty string: " + k);
        return s.Trim();
    }
    static int Int(Dictionary<string, object> d, string k, int def, int min, int max) {
        object v = Get(d, k); if (v == null) return def;
        long n; if (!(v is int || v is long) || !long.TryParse(v.ToString(), out n) || n < min || n > max) throw new InvalidDataException(k + " must be an integer " + min + "-" + max);
        return (int)n;
    }
    static object[] Arr(Dictionary<string, object> d, string k, int max) {
        object v = Get(d, k); if (v == null) return new object[0];
        var a = v as object[]; if (a == null) { var al = v as System.Collections.ArrayList; if (al != null) a = al.ToArray(); }
        if (a == null || a.Length > max) throw new InvalidDataException(k + " must be an array of at most " + max + " items");
        return a;
    }
    static Dictionary<string, object> Obj(object o, string what, string keys) {
        var d = o as Dictionary<string, object>; if (d == null) throw new InvalidDataException(what + " items must be objects");
        var allowed = keys.Split(','); var bad = d.Keys.Where(k => !allowed.Contains(k)).ToList();
        if (bad.Count > 0) throw new InvalidDataException(what + ": unknown field(s) " + string.Join(",", bad) + "; allowed: " + keys);
        return d;
    }
    static string Database(SqlConfig cfg, Dictionary<string, object> d, string key) {
        string db = Str(d, key, true); string hit = cfg.Databases.FirstOrDefault(x => string.Equals(x, db, StringComparison.OrdinalIgnoreCase));
        if (hit == null && Sandbox.IsSandboxDatabase(db)) return db;   // v3.3: sandbox databases this agent created are readable too
        if (hit == null) throw new UnauthorizedAccessException("Database not in sql-config.txt allow-list: " + db + "; allowed: " + string.Join(",", cfg.Databases));
        return hit;
    }
    public static string Q(string ident) { return "[" + ident.Replace("]", "]]") + "]"; }

    // ---- catalog ----
    public sealed class Col { public string Name, Type; public int MaxLength; public byte Precision, Scale; public bool Nullable, Identity; }
    public sealed class Table { public string Schema, Name, Kind; public int ObjectId; public List<Col> Cols = new List<Col>(); public string Quoted { get { return Q(Schema) + "." + Q(Name); } } }
    static SqlParameter NVar(string name, string value) { return new SqlParameter(name, SqlDbType.NVarChar, 128) { Value = value }; }
    public static Table ResolveTable(ISqlRunner run, string db, string raw) {
        string t = raw.Trim(), schema = null, name;
        var two = Regex.Match(t, @"^\[?([^\[\].]+)\]?\.\[?([^\[\]]+)\]?$"); var one = Regex.Match(t, @"^\[?([^\[\]]+)\]?$");
        if (two.Success) { schema = two.Groups[1].Value; name = two.Groups[2].Value; }
        else if (one.Success) name = one.Groups[1].Value;
        else name = t;   // names containing brackets: looked up verbatim in the catalog, then always re-quoted with Q()
        if (name.Length > 128 || (schema != null && schema.Length > 128)) throw new InvalidDataException("Identifier too long");
        var found = run.Query(db, "SELECT o.object_id, s.name, o.name, o.type_desc FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U','V') AND o.name = @n", new List<SqlParameter> { NVar("@n", name) }, 50);
        var rows = found.Rows.Where(r => schema == null || string.Equals((string)r[1], schema, StringComparison.OrdinalIgnoreCase)).ToList();
        if (rows.Count > 1) { var exact = rows.Where(r => (string)r[2] == name && (schema == null || (string)r[1] == schema)).ToList(); if (exact.Count == 1) rows = exact; }
        if (rows.Count > 1 && schema == null) { var dbo = rows.Where(r => string.Equals((string)r[1], "dbo", StringComparison.OrdinalIgnoreCase)).ToList(); if (dbo.Count == 1) rows = dbo; }
        if (rows.Count == 0) throw new InvalidDataException("Table/view not found in " + db + ": " + t + " (use sql-tables to list)");
        if (rows.Count > 1) throw new InvalidDataException("Ambiguous table " + t + "; specify schema: " + string.Join(",", rows.Select(r => (string)r[1])));
        var tb = new Table { ObjectId = Convert.ToInt32(rows[0][0], CultureInfo.InvariantCulture), Schema = (string)rows[0][1], Name = (string)rows[0][2], Kind = (string)rows[0][3] };
        var cols = run.Query(db, "SELECT c.name, TYPE_NAME(c.system_type_id), c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity FROM sys.columns c WHERE c.object_id = @oid ORDER BY c.column_id", new List<SqlParameter> { new SqlParameter("@oid", SqlDbType.Int) { Value = tb.ObjectId } }, 2000);
        foreach (var r in cols.Rows) tb.Cols.Add(new Col { Name = (string)r[0], Type = ((r[1] as string) ?? "unknown").ToLowerInvariant(), MaxLength = Convert.ToInt32(r[2], CultureInfo.InvariantCulture), Precision = Convert.ToByte(r[3], CultureInfo.InvariantCulture), Scale = Convert.ToByte(r[4], CultureInfo.InvariantCulture), Nullable = Convert.ToBoolean(r[5], CultureInfo.InvariantCulture), Identity = Convert.ToBoolean(r[6], CultureInfo.InvariantCulture) });
        return tb;
    }
    static Col Column(Table t, string raw) {
        string n = raw.Trim(); if (n.StartsWith("[") && n.EndsWith("]") && n.Length > 2) n = n.Substring(1, n.Length - 2);
        var c = t.Cols.FirstOrDefault(x => x.Name == n) ?? (t.Cols.Count(x => string.Equals(x.Name, n, StringComparison.OrdinalIgnoreCase)) == 1 ? t.Cols.First(x => string.Equals(x.Name, n, StringComparison.OrdinalIgnoreCase)) : null);
        if (c == null) throw new InvalidDataException("Column not found in " + t.Schema + "." + t.Name + ": " + raw + "; columns: " + string.Join(",", t.Cols.Take(40).Select(x => x.Name)) + (t.Cols.Count > 40 ? ",..." : ""));
        return c;
    }
    static bool IsString(Col c) { return new[] { "char", "varchar", "text", "nchar", "nvarchar", "ntext" }.Contains(c.Type); }
    static bool IsNumeric(Col c) { return new[] { "tinyint", "smallint", "int", "bigint", "decimal", "numeric", "money", "smallmoney", "float", "real" }.Contains(c.Type); }
    static bool IsDateType(Col c) { return new[] { "date", "datetime", "smalldatetime", "datetime2", "datetimeoffset" }.Contains(c.Type); }
    static string TypeLabel(Col c) {
        if (new[] { "char", "varchar", "binary", "varbinary" }.Contains(c.Type)) return c.Type + "(" + (c.MaxLength < 0 ? "max" : c.MaxLength.ToString(CultureInfo.InvariantCulture)) + ")";
        if (c.Type == "nchar" || c.Type == "nvarchar") return c.Type + "(" + (c.MaxLength < 0 ? "max" : (c.MaxLength / 2).ToString(CultureInfo.InvariantCulture)) + ")";
        if (c.Type == "decimal" || c.Type == "numeric") return c.Type + "(" + c.Precision + "," + c.Scale + ")";
        return c.Type;
    }

    // ---- typed parameters ----
    static readonly string[] DateFormats = { "yyyy-MM-dd", "yyyy/MM/dd", "yyyyMMdd", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-ddTHH:mm:ss", "yyyy-MM-dd HH:mm:ss.fff", "yyyy-MM-ddTHH:mm:ss.fff", "yyyy/MM/dd HH:mm:ss" };
    public static DateTime ParseDate(object v) {
        var s = v as string; DateTime d;
        if (s == null && (v is int || v is long)) s = v.ToString();
        if (s == null || !DateTime.TryParseExact(s.Trim(), DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) throw new InvalidDataException("Invalid date (use yyyy-MM-dd): " + v);
        return d;
    }
    static string ScalarString(object v) {
        if (v is string) return (string)v;
        if (v is int || v is long || v is decimal) return Convert.ToString(v, CultureInfo.InvariantCulture);
        if (v is double) return ((double)v).ToString("R", CultureInfo.InvariantCulture);
        throw new InvalidDataException("Value must be a string or number");
    }
    static long ParseLong(object v, long min, long max) {
        long n; if (!long.TryParse(ScalarString(v), NumberStyles.Integer, CultureInfo.InvariantCulture, out n) || n < min || n > max) throw new InvalidDataException("Integer value out of range: " + v);
        return n;
    }
    static decimal ParseDecimal(object v) { decimal n; if (!decimal.TryParse(ScalarString(v), NumberStyles.Float, CultureInfo.InvariantCulture, out n)) throw new InvalidDataException("Numeric value expected: " + v); return n; }
    public static SqlParameter Param(string name, Col c, object v) {
        if (v == null) throw new InvalidDataException("null is not a value; use op \"is null\"");
        if (v is Dictionary<string, object> || v is object[] || v is System.Collections.ArrayList) throw new InvalidDataException("Value must be a scalar");
        switch (c.Type) {
            case "char": case "varchar": case "text": { string s = ScalarString(v); if (s.Length > 4000) throw new InvalidDataException("Value too long"); return new SqlParameter(name, SqlDbType.VarChar, c.Type == "text" || c.MaxLength < 0 ? 8000 : Math.Max(c.MaxLength, s.Length)) { Value = s }; }
            case "nchar": case "nvarchar": case "ntext": { string s = ScalarString(v); if (s.Length > 4000) throw new InvalidDataException("Value too long"); return new SqlParameter(name, SqlDbType.NVarChar, c.Type == "ntext" || c.MaxLength < 0 ? 4000 : Math.Max(c.MaxLength / 2, s.Length)) { Value = s }; }
            case "date": return new SqlParameter(name, SqlDbType.Date) { Value = ParseDate(v).Date };
            case "datetime": return new SqlParameter(name, SqlDbType.DateTime) { Value = ParseDate(v) };
            case "smalldatetime": return new SqlParameter(name, SqlDbType.SmallDateTime) { Value = ParseDate(v) };
            case "datetime2": return new SqlParameter(name, SqlDbType.DateTime2) { Value = ParseDate(v) };
            case "datetimeoffset": return new SqlParameter(name, SqlDbType.DateTimeOffset) { Value = new DateTimeOffset(DateTime.SpecifyKind(ParseDate(v), DateTimeKind.Unspecified), TimeSpan.Zero) };
            case "tinyint": return new SqlParameter(name, SqlDbType.TinyInt) { Value = (byte)ParseLong(v, 0, 255) };
            case "smallint": return new SqlParameter(name, SqlDbType.SmallInt) { Value = (short)ParseLong(v, short.MinValue, short.MaxValue) };
            case "int": return new SqlParameter(name, SqlDbType.Int) { Value = (int)ParseLong(v, int.MinValue, int.MaxValue) };
            case "bigint": return new SqlParameter(name, SqlDbType.BigInt) { Value = ParseLong(v, long.MinValue, long.MaxValue) };
            case "bit": { if (v is bool) return new SqlParameter(name, SqlDbType.Bit) { Value = (bool)v }; return new SqlParameter(name, SqlDbType.Bit) { Value = ParseLong(v, 0, 1) == 1 }; }
            case "decimal": case "numeric": return new SqlParameter(name, SqlDbType.Decimal) { Value = ParseDecimal(v), Precision = c.Precision, Scale = c.Scale };
            case "money": return new SqlParameter(name, SqlDbType.Money) { Value = ParseDecimal(v) };
            case "smallmoney": return new SqlParameter(name, SqlDbType.SmallMoney) { Value = ParseDecimal(v) };
            case "float": return new SqlParameter(name, SqlDbType.Float) { Value = (double)ParseDecimal(v) };
            case "real": return new SqlParameter(name, SqlDbType.Real) { Value = (float)ParseDecimal(v) };
            case "uniqueidentifier": { Guid g; if (!Guid.TryParse(ScalarString(v), out g)) throw new InvalidDataException("GUID expected"); return new SqlParameter(name, SqlDbType.UniqueIdentifier) { Value = g }; }
        }
        throw new InvalidDataException("Filtering on column type " + c.Type + " is not supported: " + c.Name);
    }

    // ---- WHERE / ORDER BY ----
    static string Where(Table t, object[] conds, List<SqlParameter> ps, string prefix) {
        if (conds.Length > MaxConds) throw new InvalidDataException("At most " + MaxConds + " where conditions");
        var parts = new List<string>();
        foreach (var o in conds) {
            var d = Obj(o, "where", "column,op,value,values"); var c = Column(t, Str(d, "column", true)); string q = Q(c.Name);
            string op = (Str(d, "op", true) ?? "").ToLowerInvariant(); op = Regex.Replace(op, @"\s+", " ");
            Func<object, string> add = v => { string n = "@" + prefix + ps.Count; ps.Add(Param(n, c, v)); return n; };
            switch (op) {
                case "=": case "<>": case "!=": case "<": case "<=": case ">": case ">=":
                    if (d.ContainsKey("values")) throw new InvalidDataException(op + " takes value, not values");
                    parts.Add(q + " " + (op == "!=" ? "<>" : op) + " " + add(Get(d, "value"))); break;
                case "like": case "not like":
                    if (!IsString(c)) throw new InvalidDataException("like needs a text column: " + c.Name);
                    parts.Add(q + (op == "like" ? " LIKE " : " NOT LIKE ") + add(Get(d, "value"))); break;
                case "in": case "not in": {
                    var vals = Arr(d, "values", MaxInValues); if (vals.Length == 0 || d.ContainsKey("value")) throw new InvalidDataException(op + " needs values: [1-" + MaxInValues + " items]");
                    parts.Add(q + (op == "in" ? " IN (" : " NOT IN (") + string.Join(",", vals.Select(add)) + ")"); break; }
                case "between": {
                    var vals = Arr(d, "values", 2); if (vals.Length != 2 || d.ContainsKey("value")) throw new InvalidDataException("between needs values: [low, high]");
                    parts.Add(q + " BETWEEN " + add(vals[0]) + " AND " + add(vals[1])); break; }
                case "is null": case "is not null":
                    if (d.ContainsKey("value") || d.ContainsKey("values")) throw new InvalidDataException(op + " takes no value");
                    parts.Add(q + (op == "is null" ? " IS NULL" : " IS NOT NULL")); break;
                default: throw new InvalidDataException("Unsupported op: " + op + " (=,<>,<,<=,>,>=,like,not like,in,not in,between,is null,is not null)");
            }
        }
        return parts.Count == 0 ? "" : " WHERE " + string.Join(" AND ", parts);
    }
    static bool Desc(Dictionary<string, object> d) { object v = Get(d, "desc"); if (v == null) return false; if (!(v is bool)) throw new InvalidDataException("desc must be true/false"); return (bool)v; }

    // ---- output ----
    public static object Cell(object v) {
        if (v == null || v is DBNull) return null;
        if (v is DateTime) { var d = (DateTime)v; return d.TimeOfDay == TimeSpan.Zero ? d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : d.ToString(d.Millisecond == 0 ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture); }
        if (v is DateTimeOffset) return ((DateTimeOffset)v).ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture);
        if (v is TimeSpan) return ((TimeSpan)v).ToString("c", CultureInfo.InvariantCulture);
        if (v is decimal) return ((decimal)v).ToString(CultureInfo.InvariantCulture);
        if (v is double) return ((double)v).ToString("R", CultureInfo.InvariantCulture);
        if (v is float) return ((float)v).ToString("R", CultureInfo.InvariantCulture);
        if (v is long || v is int || v is short || v is byte || v is bool) return v;
        if (v is byte[]) { var b = (byte[])v; return "0x" + BitConverter.ToString(b.Take(16).ToArray()).Replace("-", "") + (b.Length > 16 ? "...(" + b.Length + " bytes)" : ""); }
        string s = Convert.ToString(v, CultureInfo.InvariantCulture) ?? "";
        return s.Length <= MaxCell ? s : s.Substring(0, MaxCell) + "...[" + s.Length + " chars]";
    }
    static string Fit(Dictionary<string, object> result, List<object[]> rows, bool more, Stopwatch sw) {
        result["more_rows"] = more; result["truncated_to_fit"] = false; result["elapsed_ms"] = sw.ElapsedMilliseconds;
        result["rows"] = new List<object[]>(); result["returned_rows"] = rows.Count;
        // Size rows one at a time: serializing every row at once can exceed the serializer's own limit before any trimming.
        int budget = MaxOut - Common.Encode(result).Length, kept = 0;
        if (budget < 0) throw new InvalidDataException("Result envelope exceeds " + MaxOut + " chars even with zero rows; request fewer columns");
        foreach (var row in rows) { int len = Common.Encode(row).Length + (kept == 0 ? 0 : 1); if (len > budget) break; budget -= len; kept++; }
        result["rows"] = rows.Take(kept).ToList(); result["returned_rows"] = kept; result["truncated_to_fit"] = kept < rows.Count;
        return Common.Encode(result);
    }

    // ---- dispatch ----
    public static string Execute(string action, string prompt) {
        var cfg = LoadConfig(); var run = Runner(cfg); var sw = Stopwatch.StartNew();
        switch (action) {
            case "sql-ping": return Ping(cfg, run, prompt, sw);
            case "sql-tables": return Tables(cfg, run, prompt, sw);
            case "sql-columns": return Columns(cfg, run, prompt, sw);
            case "sql-select": return Select(cfg, run, prompt, sw);
            case "sql-agg": return Agg(cfg, run, prompt, sw);
            case "sql-date-gaps": return DateGaps(cfg, run, prompt, sw);
            case "sql-fingerprint": return Fingerprint(cfg, prompt, sw);
        }
        throw new InvalidOperationException("Action not allowed");
    }

    static string Ping(SqlConfig cfg, ISqlRunner run, string prompt, Stopwatch sw) {
        Spec(prompt, "");
        var dbs = new List<object>(); Dictionary<string, object> server = null;
        foreach (var db in cfg.Databases) {
            try {
                if (server == null) {
                    var s = run.Query(db, "SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(128)), CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)), CAST(SERVERPROPERTY('Edition') AS nvarchar(128)), SUSER_SNAME(), IS_SRVROLEMEMBER('sysadmin')", new List<SqlParameter>(), 1);
                    var r0 = s.Rows[0]; server = new Dictionary<string, object> { { "server", Cell(r0[0]) }, { "version", Cell(r0[1]) }, { "edition", Cell(r0[2]) }, { "login", Cell(r0[3]) }, { "sysadmin", Cell(r0[4]) } };
                }
                var p = run.Query(db, "SELECT USER_NAME(), IS_ROLEMEMBER('db_owner'), IS_ROLEMEMBER('db_datawriter'), IS_ROLEMEMBER('db_ddladmin'), HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','INSERT'), HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','UPDATE'), HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','DELETE'), HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','ALTER'), CAST(DATABASEPROPERTYEX(DB_NAME(),'Updateability') AS nvarchar(32))", new List<SqlParameter>(), 1).Rows[0];
                Func<int, bool> on = i => p[i] != null && !(p[i] is DBNull) && Convert.ToInt32(p[i], CultureInfo.InvariantCulture) == 1;
                bool write = on(1) || on(2) || on(3) || on(4) || on(5) || on(6) || on(7);
                dbs.Add(new Dictionary<string, object> { { "database", db }, { "user", Cell(p[0]) }, { "write_capable", write }, { "updateability", Cell(p[8]) } });
            } catch (InvalidOperationException e) { dbs.Add(new Dictionary<string, object> { { "database", db }, { "error", Common.Safe(e.Message).Length > 300 ? Common.Safe(e.Message).Substring(0, 300) : Common.Safe(e.Message) } }); }
        }
        bool sys = server != null && server["sysadmin"] != null && Convert.ToInt32(server["sysadmin"], CultureInfo.InvariantCulture) == 1;
        bool anyWrite = sys || dbs.OfType<Dictionary<string, object>>().Any(x => x.ContainsKey("write_capable") && (bool)x["write_capable"]);
        var result = new Dictionary<string, object> { { "kind", "sql_ping" }, { "server_config", cfg.Server }, { "server", server }, { "databases", dbs }, { "read_only_enforced_by", anyWrite ? "agent_templates_only" : "account_permissions_and_agent_templates" }, { "elapsed_ms", sw.ElapsedMilliseconds } };
        string enc = Common.Encode(result); if (enc.Length > MaxOut) { result["databases"] = dbs.Take(10).ToList(); result["databases_truncated"] = true; enc = Common.Encode(result); }
        return enc;
    }

    static string Tables(SqlConfig cfg, ISqlRunner run, string prompt, Stopwatch sw) {
        var d = Spec(prompt, "database,schema,like,top"); string db = Database(cfg, d, "database"); string schema = Str(d, "schema", false), like = Str(d, "like", false); int top = Int(d, "top", 100, 1, MaxTop);
        var ps = new List<SqlParameter> { new SqlParameter("@top", SqlDbType.Int) { Value = top } };
        string sql = "SELECT TOP (@top) s.name, o.name, o.type_desc, (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0,1)), (SELECT CAST(SUM(a.total_pages) * 8 / 1024.0 AS decimal(18,1)) FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = p.partition_id WHERE p.object_id = o.object_id), o.modify_date FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U','V')";
        if (schema != null) { sql += " AND s.name = @schema"; ps.Add(NVar("@schema", schema)); }
        if (like != null) { sql += " AND o.name LIKE @like"; ps.Add(NVar("@like", like)); }
        sql += " ORDER BY s.name, o.name";
        var r = run.Query(db, sql, ps, top);
        var result = new Dictionary<string, object> { { "kind", "sql_tables" }, { "database", db }, { "columns", new[] { "schema", "name", "type", "rows", "size_mb", "modified" } } };
        return Fit(result, r.Rows.Select(x => x.Select(Cell).ToArray()).ToList(), r.Rows.Count >= top, sw);
    }

    static string Columns(SqlConfig cfg, ISqlRunner run, string prompt, Stopwatch sw) {
        var d = Spec(prompt, "database,table"); string db = Database(cfg, d, "database"); var t = ResolveTable(run, db, Str(d, "table", true));
        var pk = run.Query(db, "SELECT c.name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.is_primary_key = 1 AND i.object_id = @oid ORDER BY ic.key_ordinal", new List<SqlParameter> { new SqlParameter("@oid", SqlDbType.Int) { Value = t.ObjectId } }, 64);
        var result = new Dictionary<string, object> { { "kind", "sql_columns" }, { "database", db }, { "table", t.Schema + "." + t.Name }, { "object_type", t.Kind }, { "primary_key", pk.Rows.Select(x => (string)x[0]).ToList() }, { "columns", new[] { "name", "type", "nullable", "identity" } } };
        return Fit(result, t.Cols.Select(c => new object[] { c.Name, TypeLabel(c), c.Nullable, c.Identity }).ToList(), false, sw);
    }

    static string Select(SqlConfig cfg, ISqlRunner run, string prompt, Stopwatch sw) {
        var d = Spec(prompt, "database,table,columns,where,order_by,top"); string db = Database(cfg, d, "database"); var t = ResolveTable(run, db, Str(d, "table", true)); int top = Int(d, "top", 50, 1, MaxTop);
        var wanted = Arr(d, "columns", 50); List<Col> cols; var skipped = new List<string>();
        if (wanted.Length == 0) { cols = t.Cols.Where(c => !Unselectable.Contains(c.Type)).Take(40).ToList(); skipped = t.Cols.Where(c => Unselectable.Contains(c.Type)).Select(c => c.Name).ToList(); }
        else cols = wanted.Select(w => { var s = w as string; if (s == null) throw new InvalidDataException("columns must be strings"); var c = Column(t, s); if (Unselectable.Contains(c.Type)) throw new InvalidDataException("Column type " + c.Type + " cannot be returned: " + c.Name); return c; }).ToList();
        if (cols.Count == 0) throw new InvalidDataException("No returnable columns");
        var ps = new List<SqlParameter> { new SqlParameter("@top", SqlDbType.Int) { Value = top } };
        string sql = "SELECT TOP (@top) " + string.Join(", ", cols.Select(c => Q(c.Name))) + " FROM " + t.Quoted + Where(t, Arr(d, "where", MaxConds), ps, "p");
        var order = Arr(d, "order_by", 5).Select(o => { var od = Obj(o, "order_by", "column,desc"); return Q(Column(t, Str(od, "column", true)).Name) + (Desc(od) ? " DESC" : " ASC"); }).ToList();
        if (order.Count > 0) sql += " ORDER BY " + string.Join(", ", order);
        var r = run.Query(db, sql, ps, top);
        var result = new Dictionary<string, object> { { "kind", "sql_rows" }, { "database", db }, { "table", t.Schema + "." + t.Name }, { "columns", cols.Select(c => c.Name).ToList() } };
        if (skipped.Count > 0) result["skipped_columns"] = skipped;
        if (wanted.Length == 0 && t.Cols.Count(c => !Unselectable.Contains(c.Type)) > 40) result["columns_capped_at"] = 40;
        if (order.Count == 0) result["note"] = "no order_by: row order is not guaranteed";
        return Fit(result, r.Rows.Select(x => x.Select(Cell).ToArray()).ToList(), r.Rows.Count >= top, sw);
    }

    static string Agg(SqlConfig cfg, ISqlRunner run, string prompt, Stopwatch sw) {
        var d = Spec(prompt, "database,table,group_by,aggregates,where,order_by,top"); string db = Database(cfg, d, "database"); var t = ResolveTable(run, db, Str(d, "table", true)); int top = Int(d, "top", 100, 1, MaxTop);
        var groups = Arr(d, "group_by", 5).Select(g => { var s = g as string; if (s == null) throw new InvalidDataException("group_by must be strings"); var c = Column(t, s); if (Unselectable.Contains(c.Type) || c.Type == "text" || c.Type == "ntext" || c.Type == "xml") throw new InvalidDataException("Cannot group by " + c.Type + ": " + c.Name); return c; }).ToList();
        var aggs = Arr(d, "aggregates", 8); if (aggs.Length == 0) throw new InvalidDataException("aggregates needs 1-8 items, e.g. [{\"fn\":\"count\"}]");
        var exprs = new List<string>(); var names = new List<string>();
        foreach (var o in aggs) {
            var ad = Obj(o, "aggregates", "fn,column"); string fn = Str(ad, "fn", true).ToLowerInvariant(); string colRaw = Str(ad, "column", false); Col c = colRaw == null ? null : Column(t, colRaw);
            if (c != null && (Unselectable.Contains(c.Type) || c.Type == "text" || c.Type == "ntext" || c.Type == "xml")) throw new InvalidDataException("Cannot aggregate " + c.Type + ": " + c.Name);
            string e;
            switch (fn) {
                case "count": e = c == null ? "COUNT_BIG(*)" : "COUNT_BIG(" + Q(c.Name) + ")"; break;
                case "count_distinct": if (c == null) throw new InvalidDataException("count_distinct needs column"); e = "COUNT_BIG(DISTINCT " + Q(c.Name) + ")"; break;
                case "min": case "max": if (c == null || c.Type == "bit") throw new InvalidDataException(fn + " needs a non-bit column"); e = fn.ToUpperInvariant() + "(" + Q(c.Name) + ")"; break;
                case "sum": case "avg":
                    if (c == null || !IsNumeric(c)) throw new InvalidDataException(fn + " needs a numeric column");
                    e = fn.ToUpperInvariant() + "(" + (c.Type == "float" || c.Type == "real" ? "CAST(" + Q(c.Name) + " AS float)" : "CAST(" + Q(c.Name) + " AS decimal(38,6))") + ")"; break;
                default: throw new InvalidDataException("Unsupported fn: " + fn + " (count,count_distinct,min,max,sum,avg)");
            }
            exprs.Add(e + " AS " + Q("a" + exprs.Count)); names.Add(fn + "(" + (c == null ? "*" : c.Name) + ")");
        }
        var ps = new List<SqlParameter> { new SqlParameter("@top", SqlDbType.Int) { Value = top } };
        string sql = "SELECT TOP (@top) " + string.Join(", ", groups.Select(g => Q(g.Name)).Concat(exprs)) + " FROM " + t.Quoted + Where(t, Arr(d, "where", MaxConds), ps, "p");
        if (groups.Count > 0) sql += " GROUP BY " + string.Join(", ", groups.Select(g => Q(g.Name)));
        var order = Arr(d, "order_by", 5).Select(o => {
            var od = Obj(o, "order_by", "column,aggregate,desc"); string dir = Desc(od) ? " DESC" : " ASC";
            if (od.ContainsKey("aggregate")) { if (od.ContainsKey("column")) throw new InvalidDataException("order_by item: column or aggregate, not both"); int i = Int(od, "aggregate", 0, 0, exprs.Count - 1); return Q("a" + i) + dir; }
            var c = Column(t, Str(od, "column", true)); if (!groups.Contains(c)) throw new InvalidDataException("order_by column must be in group_by: " + c.Name); return Q(c.Name) + dir;
        }).ToList();
        if (order.Count == 0 && groups.Count > 0) order = groups.Select(g => Q(g.Name) + " ASC").ToList();
        if (order.Count > 0) sql += " ORDER BY " + string.Join(", ", order);
        var r = run.Query(db, sql, ps, top);
        var result = new Dictionary<string, object> { { "kind", "sql_agg" }, { "database", db }, { "table", t.Schema + "." + t.Name }, { "columns", groups.Select(g => g.Name).Concat(names).ToList() } };
        return Fit(result, r.Rows.Select(x => x.Select(Cell).ToArray()).ToList(), r.Rows.Count >= top, sw);
    }

    // Distinct calendar days of a date-like column (date/datetime types, int yyyyMMdd, or text yyyyMMdd / yyyy-MM-dd / yyyy/MM/dd).
    static SortedSet<DateTime> Days(ISqlRunner run, string db, Table t, Col c, DateTime from, DateTime to, object[] where, out string format) {
        var ps = new List<SqlParameter>(); string q = Q(c.Name), select, range;
        format = c.Type;
        if (IsDateType(c)) {
            select = "CAST(" + q + " AS date)"; ps.Add(Param("@f", c, from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))); ps.Add(Param("@t", c, to.AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))); range = q + " >= @f AND " + q + " < @t";
        } else if (c.Type == "int" || c.Type == "bigint") {
            format = "int yyyyMMdd"; select = q; ps.Add(Param("@f", c, long.Parse(from.ToString("yyyyMMdd", CultureInfo.InvariantCulture), CultureInfo.InvariantCulture))); ps.Add(Param("@t", c, long.Parse(to.ToString("yyyyMMdd", CultureInfo.InvariantCulture), CultureInfo.InvariantCulture))); range = q + " BETWEEN @f AND @t";
        } else if (IsString(c) && c.Type != "text" && c.Type != "ntext") {
            var sample = run.Query(db, "SELECT TOP (1) " + q + " FROM " + t.Quoted + " WHERE " + q + " IS NOT NULL ORDER BY " + q + " DESC", new List<SqlParameter>(), 1);
            string s = sample.Rows.Count == 0 ? null : Convert.ToString(sample.Rows[0][0], CultureInfo.InvariantCulture).Trim();
            string fmt = s == null ? null : Regex.IsMatch(s, @"^\d{8}$") ? "yyyyMMdd" : Regex.IsMatch(s, @"^\d{4}-\d{2}-\d{2}") ? "yyyy-MM-dd" : Regex.IsMatch(s, @"^\d{4}/\d{2}/\d{2}") ? "yyyy/MM/dd" : null;
            if (fmt == null) throw new InvalidDataException("Cannot detect the date format of text column " + c.Name + " (supported: yyyyMMdd, yyyy-MM-dd, yyyy/MM/dd)");
            format = c.Type + " " + fmt; select = "LEFT(" + q + ", " + fmt.Length + ")";
            ps.Add(Param("@f", c, from.ToString(fmt, CultureInfo.InvariantCulture))); ps.Add(Param("@t", c, to.AddDays(1).ToString(fmt, CultureInfo.InvariantCulture))); range = q + " >= @f AND " + q + " < @t";
        } else throw new InvalidDataException("date_column must be a date/datetime, int yyyyMMdd or text date column: " + c.Name + " is " + c.Type);
        string sql = "SELECT DISTINCT " + select + " FROM " + t.Quoted + " WHERE " + range;
        string extra = Where(t, where, ps, "w"); if (extra.Length > 0) sql += " AND " + extra.Substring(" WHERE ".Length);
        var r = run.Query(db, sql, ps, MaxGapDays + 10);
        if (r.More) throw new InvalidDataException("Too many distinct values; narrow the date range");
        var set = new SortedSet<DateTime>();
        foreach (var row in r.Rows) {
            var v = row[0]; if (v == null || v is DBNull) continue;
            if (v is DateTime) set.Add(((DateTime)v).Date);
            else { DateTime dt; string sv = Convert.ToString(v, CultureInfo.InvariantCulture).Trim(); if (DateTime.TryParseExact(sv, new[] { "yyyyMMdd", "yyyy-MM-dd", "yyyy/MM/dd" }, CultureInfo.InvariantCulture, DateTimeStyles.None, out dt)) set.Add(dt); }
        }
        return set;
    }
    static string DateGaps(SqlConfig cfg, ISqlRunner run, string prompt, Stopwatch sw) {
        var d = Spec(prompt, "database,table,date_column,from,to,where,reference"); string db = Database(cfg, d, "database"); var t = ResolveTable(run, db, Str(d, "table", true)); var c = Column(t, Str(d, "date_column", true));
        DateTime from = ParseDate(Str(d, "from", true)).Date, to = ParseDate(Str(d, "to", true)).Date;
        if (to < from || (to - from).TotalDays > MaxGapDays) throw new InvalidDataException("from/to must be ordered and at most " + MaxGapDays + " days apart");
        string fmt, refFmt = null; var have = Days(run, db, t, c, from, to, Arr(d, "where", MaxConds), out fmt);
        SortedSet<DateTime> expect; object refDesc;
        var refObj = Get(d, "reference");
        if (refObj == null) {
            expect = new SortedSet<DateTime>(); for (var x = from; x <= to; x = x.AddDays(1)) if (x.DayOfWeek != DayOfWeek.Saturday && x.DayOfWeek != DayOfWeek.Sunday) expect.Add(x);
            refDesc = "weekdays (Mon-Fri, holidays not excluded)";
        } else {
            var rd = Obj(refObj, "reference", "database,table,date_column,where"); string rdb = Database(cfg, rd, "database"); var rt = ResolveTable(run, rdb, Str(rd, "table", true)); var rc = Column(rt, Str(rd, "date_column", true));
            expect = Days(run, rdb, rt, rc, from, to, Arr(rd, "where", MaxConds), out refFmt);
            refDesc = new Dictionary<string, object> { { "database", rdb }, { "table", rt.Schema + "." + rt.Name }, { "date_column", rc.Name }, { "format", refFmt }, { "days", expect.Count } };
        }
        Func<DateTime, string> f = x => x.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var missing = expect.Where(x => !have.Contains(x)).Select(f).ToList(); var extra = have.Where(x => !expect.Contains(x)).Select(f).ToList();
        var result = new Dictionary<string, object> { { "kind", "sql_date_gaps" }, { "database", db }, { "table", t.Schema + "." + t.Name }, { "date_column", c.Name }, { "format", fmt }, { "from", f(from) }, { "to", f(to) }, { "days_present", have.Count }, { "first_day", have.Count == 0 ? null : f(have.Min) }, { "last_day", have.Count == 0 ? null : f(have.Max) }, { "reference", refDesc }, { "missing_count", missing.Count }, { "extra_count", extra.Count }, { "elapsed_ms", sw.ElapsedMilliseconds } };
        int mk = Math.Min(missing.Count, 150), ek = Math.Min(extra.Count, 50); string enc;
        while (true) { result["missing"] = missing.Take(mk).ToList(); result["extra"] = extra.Take(ek).ToList(); result["lists_truncated"] = mk < missing.Count || ek < extra.Count; enc = Common.Encode(result); if (enc.Length <= MaxOut || (mk == 0 && ek == 0)) break; if (mk >= ek && mk > 0) mk = mk * 3 / 4; else ek = ek * 3 / 4; }
        return enc;
    }

    // v3.3: per-table row count + order-independent fingerprint of every row (Canon), to prove a copy equals its source
    // (MarketDB export, or another SQL Server). Full scans: read-only, rolled back, 120 s per table (600 s on sandbox databases).
    static string Fingerprint(SqlConfig cfg, string prompt, Stopwatch sw) {
        var d = Spec(prompt, "database,tables"); string db = Database(cfg, d, "database"); bool sandbox = Sandbox.IsSandboxDatabase(db);
        var b = new SqlConnectionStringBuilder { DataSource = cfg.Server, InitialCatalog = db, IntegratedSecurity = true, ApplicationName = "dbclone-agent-sql", ConnectTimeout = 10, Pooling = false, ApplicationIntent = ApplicationIntent.ReadOnly };
        var results = new List<object>();
        try {
            using (var conn = new SqlConnection(b.ConnectionString)) {
                conn.Open(); var run = new ConnRunner(conn);
                var wanted = Arr(d, "tables", 50).Select(x => { var s = x as string; if (s == null) throw new InvalidDataException("tables must be strings"); return ResolveTable(run, db, s); }).ToList();
                if (wanted.Count == 0) wanted = run.Query(db, "SELECT s.name + '.' + o.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type = 'U' ORDER BY 1", new List<SqlParameter>(), 51).Rows.Select(r => ResolveTable(run, db, (string)r[0])).ToList();
                if (wanted.Count > 50) throw new InvalidDataException("More than 50 tables; list the ones to fingerprint");
                // Wall-clock budget for the whole call (CommandTimeout does not count client-side hashing time).
                var deadline = TimeSpan.FromSeconds(sandbox ? 1200 : 300);
                foreach (var t in wanted) {
                    var fp = new Canon.Fingerprint(); var tsw = Stopwatch.StartNew(); string schemaFp;
                    using (var tx = conn.BeginTransaction(IsolationLevel.ReadCommitted)) {
                        try {
                            using (var cmd = conn.CreateCommand()) {
                                cmd.Transaction = tx; cmd.CommandTimeout = sandbox ? 600 : 120;
                                cmd.CommandText = "SET LOCK_TIMEOUT 5000; SET DEADLOCK_PRIORITY LOW;\nSELECT " + string.Join(", ", t.Cols.Select(c => Q(c.Name))) + " FROM " + t.Quoted;
                                using (var r = cmd.ExecuteReader()) {
                                    var types = Enumerable.Range(0, r.FieldCount).Select(r.GetDataTypeName).ToArray(); var parts = new string[r.FieldCount];
                                    schemaFp = Canon.SchemaFingerprint(Enumerable.Range(0, r.FieldCount).Select(i => new[] { r.GetName(i), types[i] }));
                                    while (r.Read()) {
                                        for (int i = 0; i < parts.Length; i++) { object v; try { v = r.GetValue(i); } catch (OverflowException) { v = r.GetSqlValue(i).ToString(); } parts[i] = Canon.Value(v, types[i]); }
                                        fp.Add(string.Join("\t", parts));
                                        if ((fp.Rows & 8191) == 0 && sw.Elapsed > deadline) { cmd.Cancel(); throw new TimeoutException("sql-fingerprint stopped after " + (int)deadline.TotalSeconds + " s at " + t.Schema + "." + t.Name + " row " + fp.Rows + "; fingerprint fewer tables per call"); }
                                    }
                                }
                            }
                        } finally { try { tx.Rollback(); } catch (InvalidOperationException) { } catch (SqlException) { } }
                    }
                    results.Add(new Dictionary<string, object> { { "table", t.Schema + "." + t.Name }, { "rows", fp.Rows }, { "fingerprint", fp.Text }, { "schema_fingerprint", schemaFp }, { "seconds", Math.Round(tsw.Elapsed.TotalSeconds, 1) } });
                }
            }
        } catch (SqlException e) { throw new InvalidOperationException("SQL error " + e.Number + ": " + e.Message); }
        // at most 50 tables of ~150 chars each, well under MaxOut
        return Common.Encode(new Dictionary<string, object> { { "kind", "sql_fingerprint" }, { "database", db }, { "method", "rows:sum64:xor64 of SHA-256 over canonical rows (order-independent)" }, { "tables", results }, { "elapsed_ms", sw.ElapsedMilliseconds } });
    }
    sealed class ConnRunner : ISqlRunner {
        readonly SqlConnection c; public ConnRunner(SqlConnection conn) { c = conn; }
        public SqlResult Query(string database, string sql, IList<SqlParameter> parameters, int maxRows) {
            using (var cmd = c.CreateCommand()) {
                cmd.CommandText = sql; cmd.CommandTimeout = 30; foreach (var p in parameters) cmd.Parameters.Add(p);
                using (var r = cmd.ExecuteReader()) { var res = new SqlResult(); while (r.Read()) { if (res.Rows.Count >= maxRows) { res.More = true; break; } var row = new object[r.FieldCount]; r.GetValues(row); res.Rows.Add(row); } return res; }
            }
        }
    }
}
}
