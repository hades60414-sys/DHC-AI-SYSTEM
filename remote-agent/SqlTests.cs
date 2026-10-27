using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.IO;
using System.Linq;
using System.Text;
using DbAgent;

// v3.2 SQL action tests. No SQL Server here: a fake runner answers the sys-catalog lookups and records every other query,
// so these tests pin the generated SQL text, parameter types and validation. Real connectivity is verified on srv-db (sql-ping).
public static class SqlTests {
    static void Check(bool b, string why) { if (!b) throw new Exception(why); }
    static void Throws<T>(Action run, string contains) where T : Exception {
        try { run(); } catch (T e) { if (contains != null && !e.Message.Contains(contains)) throw new Exception("Wrong message: " + e.Message); return; }
        throw new Exception("Expected " + typeof(T).Name);
    }

    public sealed class Fake : ISqlRunner {
        public sealed class T { public int Id; public string Schema, Name, Kind = "USER_TABLE"; public object[][] Cols; public string[] Pk = new string[0]; }
        public List<T> Tables = new List<T>();
        public List<string> Sql = new List<string>(); public List<List<SqlParameter>> Params = new List<List<SqlParameter>>(); public List<string> Dbs = new List<string>();
        public Func<string, List<SqlParameter>, SqlResult> Data = (s, p) => new SqlResult { Columns = new[] { "x" } };
        public SqlResult Query(string database, string sql, IList<SqlParameter> parameters, int maxRows) {
            var ps = parameters.ToList(); Sql.Add(sql); Params.Add(ps); Dbs.Add(database);
            if (sql.Contains("FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U','V') AND o.name = @n")) {
                string n = (string)ps.First(p => p.ParameterName == "@n").Value;
                return new SqlResult { Rows = Tables.Where(t => string.Equals(t.Name, n, StringComparison.OrdinalIgnoreCase)).Select(t => new object[] { t.Id, t.Schema, t.Name, t.Kind }).ToList() };
            }
            if (sql.Contains("FROM sys.columns c WHERE c.object_id = @oid")) { int id = (int)ps[0].Value; return new SqlResult { Rows = Tables.First(t => t.Id == id).Cols.ToList() }; }
            if (sql.Contains("is_primary_key = 1")) { int id = (int)ps[0].Value; return new SqlResult { Rows = Tables.First(t => t.Id == id).Pk.Select(x => new object[] { x }).ToList() }; }
            var r = Data(sql, ps); if (r.Rows.Count > maxRows) { r.Rows = r.Rows.Take(maxRows).ToList(); r.More = true; } return r;
        }
        public string LastData { get { return Sql.Last(s => !s.Contains("o.type IN ('U','V') AND o.name = @n") && !s.Contains("sys.columns c WHERE") && !s.Contains("is_primary_key")); } }
        public List<SqlParameter> LastParams { get { return Params[Sql.LastIndexOf(LastData)]; } }
    }
    // name, system type, max_length, precision, scale, nullable, identity
    static object[] C(string n, string t, int len = 0, byte p = 0, byte s = 0) { return new object[] { n, t, len, p, s, true, false }; }
    static Fake NewFake() {
        var f = new Fake();
        f.Tables.Add(new Fake.T { Id = 101, Schema = "dbo", Name = "DailyQuote", Pk = new[] { "TradeDate", "StockID" }, Cols = new[] { C("TradeDate", "date"), C("StockID", "varchar", 10), C("StockName", "nvarchar", 40), C("ClosePrice", "decimal", 9, 18, 4), C("Volume", "bigint"), C("Note", "varchar", -1), C("Blob", "varbinary", -1), C("Flag", "bit") } });
        f.Tables.Add(new Fake.T { Id = 102, Schema = "dbo", Name = "TradeCal", Cols = new[] { C("CalDate", "datetime"), C("IsOpen", "bit") } });
        f.Tables.Add(new Fake.T { Id = 103, Schema = "dbo", Name = "TxtDates", Cols = new[] { C("D8", "char", 8), C("Val", "int") } });
        f.Tables.Add(new Fake.T { Id = 104, Schema = "dbo", Name = "IntDates", Cols = new[] { C("YMD", "int"), C("Val", "int") } });
        f.Tables.Add(new Fake.T { Id = 105, Schema = "rpt", Name = "Dup", Cols = new[] { C("A", "int") } });
        f.Tables.Add(new Fake.T { Id = 106, Schema = "stg", Name = "Dup", Cols = new[] { C("A", "int") } });
        return f;
    }
    static string P(object spec) { return Common.Encode(spec); }
    static Dictionary<string, object> D(params object[] kv) { var d = new Dictionary<string, object>(); for (int i = 0; i < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1]; return d; }
    static Dictionary<string, object> Run(Fake f, string action, object spec) { SqlActions.Runner = c => f; var s = SqlActions.Execute(action, P(spec)); Check(s.Length <= SqlActions.MaxOut, "output over bound: " + s.Length); return Common.Decode(s); }

    public static void Run(string work, Action<string, Action> test) {
        string cfgFile = Path.Combine(work, "sql-config-" + Guid.NewGuid().ToString("N") + ".txt");
        File.WriteAllText(cfgFile, "# test\r\nserver=localhost\r\ndatabase=MktData\r\ndatabase=MarketData\r\n", new UTF8Encoding(true)); HostTests.Protect(cfgFile);
        var savedRunner = SqlActions.Runner;
        try {
            test("sql: config parser accepts server + databases, rejects bad lines", () => {
                var c = SqlActions.ParseConfig(new[] { "# c", "server=.\\SQLEXPRESS", "database=MktData", "database=mktdata", "database=市場資料" });
                Check(c.Server == ".\\SQLEXPRESS" && c.Databases.Length == 2, "parse");
                Throws<InvalidDataException>(() => SqlActions.ParseConfig(new[] { "database=X" }), "one server");
                Throws<InvalidDataException>(() => SqlActions.ParseConfig(new[] { "server=a", "server=b", "database=X" }), "twice");
                Throws<InvalidDataException>(() => SqlActions.ParseConfig(new[] { "server=a", "database=X];DROP" }), "invalid database");
                Throws<InvalidDataException>(() => SqlActions.ParseConfig(new[] { "server=a;Integrated Security=false", "database=X" }), "invalid server");
                Throws<InvalidDataException>(() => SqlActions.ParseConfig(new[] { "server=a", "database=X", "password=1" }), "unknown key");
            });
            test("sql: actions disabled without sql-config.txt", () => {
                SqlActions.ConfigFile = Path.Combine(work, "missing-sql-config.txt");
                Throws<InvalidOperationException>(() => SqlActions.Execute("sql-ping", "{}"), "not configured");
                SqlActions.ConfigFile = cfgFile;
            });
            SqlActions.ConfigFile = cfgFile;
            test("sql: whitelist, protocol and controller accept sql actions with a JSON prompt", () => {
                foreach (var a in new[] { "sql-ping", "sql-tables", "sql-columns", "sql-select", "sql-agg", "sql-date-gaps" }) Check(AgentCore.ActionAllowed(a) && AgentCore.UsesPrompt(a), a);
                Check(!AgentCore.ActionAllowed("sql-exec") && !AgentCore.ActionAllowed("sql"), "unexpected action allowed");
            });
            test("sql: database outside allow-list and free-form SQL fields are rejected before any query", () => {
                var f = NewFake();
                Throws<UnauthorizedAccessException>(() => Run(f, "sql-select", D("database", "master", "table", "DailyQuote")), "allow-list");
                Throws<InvalidDataException>(() => Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote", "sql", "DELETE FROM DailyQuote")), "Unknown field");
                Throws<InvalidDataException>(() => Run(f, "sql-ping", D("query", "SELECT 1")), "Unknown field");
                Check(f.Sql.Count == 0, "query ran before validation");
            });
            test("sql: injected table/column names never reach SQL text", () => {
                var f = NewFake();
                Throws<InvalidDataException>(() => Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote; DROP TABLE x--")), "not found");
                Throws<InvalidDataException>(() => Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote", "columns", new[] { "ClosePrice]; DROP TABLE x--" })), "Column not found");
                Throws<InvalidDataException>(() => Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote", "order_by", new[] { D("column", "1; DROP") })), "Column not found");
                Check(f.Sql.All(s => !s.Contains("DROP")), "injection reached SQL");
            });
            test("sql: values are typed parameters, never concatenated", () => {
                var f = NewFake();
                Run(f, "sql-select", D("database", "mktdata", "table", "DailyQuote", "columns", new[] { "TradeDate", "StockID", "ClosePrice" }, "where", new object[] { D("column", "StockID", "op", "=", "value", "2330'; DROP TABLE x;--"), D("column", "TradeDate", "op", "between", "values", new object[] { "2026-09-01", "2026-09-30" }), D("column", "ClosePrice", "op", ">", "value", 100.5m), D("column", "Volume", "op", "in", "values", new object[] { 1, 2, 3 }) }, "order_by", new[] { D("column", "TradeDate", "desc", true) }, "top", 20));
                string sql = f.LastData; var ps = f.LastParams;
                Check(sql == "SELECT TOP (@top) [TradeDate], [StockID], [ClosePrice] FROM [dbo].[DailyQuote] WHERE [StockID] = @p1 AND [TradeDate] BETWEEN @p2 AND @p3 AND [ClosePrice] > @p4 AND [Volume] IN (@p5,@p6,@p7) ORDER BY [TradeDate] DESC", "sql text: " + sql);
                Check(!sql.Contains("2330") && !sql.Contains("DROP"), "value concatenated");
                Check(f.Dbs.Last() == "MktData", "database not canonicalized");
                Check(ps[0].SqlDbType == SqlDbType.Int && (int)ps[0].Value == 20, "top");
                Check(ps[1].SqlDbType == SqlDbType.VarChar && (string)ps[1].Value == "2330'; DROP TABLE x;--", "varchar param");
                Check(ps[2].SqlDbType == SqlDbType.Date && (DateTime)ps[2].Value == new DateTime(2026, 9, 1), "date param");
                Check(ps[4].SqlDbType == SqlDbType.Decimal && ps[4].Precision == 18 && ps[4].Scale == 4 && (decimal)ps[4].Value == 100.5m, "decimal param");
                Check(ps[5].SqlDbType == SqlDbType.BigInt, "bigint param");
            });
            test("sql: every executed statement is a single SELECT built by the agent", () => {
                var f = NewFake();
                Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote"));
                Run(f, "sql-agg", D("database", "MktData", "table", "DailyQuote", "aggregates", new[] { D("fn", "count") }));
                Run(f, "sql-tables", D("database", "MktData"));
                Check(f.Sql.All(s => s.StartsWith("SELECT ") && !s.Contains(";")), "non-SELECT or batch: " + string.Join(" | ", f.Sql));
            });
            test("sql: bad ops, sizes and types are rejected", () => {
                var f = NewFake(); Func<object, Dictionary<string, object>> w = cond => D("database", "MktData", "table", "DailyQuote", "where", new[] { cond });
                Throws<InvalidDataException>(() => Run(f, "sql-select", w(D("column", "StockID", "op", "= 1 OR 1=1 --", "value", "x"))), "Unsupported op");
                Throws<InvalidDataException>(() => Run(f, "sql-select", w(D("column", "Volume", "op", "like", "value", "1%"))), "text column");
                Throws<InvalidDataException>(() => Run(f, "sql-select", w(D("column", "Volume", "op", "in", "values", Enumerable.Range(0, 101).Cast<object>().ToArray()))), "at most 100");
                Throws<InvalidDataException>(() => Run(f, "sql-select", w(D("column", "TradeDate", "op", "between", "values", new object[] { "2026-01-01" }))), "between");
                Throws<InvalidDataException>(() => Run(f, "sql-select", w(D("column", "TradeDate", "op", "=", "value", "next tuesday"))), "Invalid date");
                Throws<InvalidDataException>(() => Run(f, "sql-select", w(D("column", "Volume", "op", "=", "value", "12a"))), "Integer value");
                Throws<InvalidDataException>(() => Run(f, "sql-select", w(D("column", "StockID", "op", "=", "value", null))), "is null");
                Throws<InvalidDataException>(() => Run(f, "sql-select", w(D("column", "StockID", "op", "=", "value", "x", "extra", 1))), "unknown field");
                Throws<InvalidDataException>(() => Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote", "top", 201)), "top");
                Throws<InvalidDataException>(() => Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote", "columns", new[] { "Blob" })), "cannot be returned");
                Throws<InvalidDataException>(() => Run(f, "sql-agg", D("database", "MktData", "table", "DailyQuote", "aggregates", new[] { D("fn", "sum", "column", "StockID") })), "numeric");
                Throws<InvalidDataException>(() => Run(f, "sql-select", D("database", "MktData", "table", "Dup")), "Ambiguous");
                Check(f.Sql.All(s => !s.StartsWith("SELECT TOP (@top) [")), "data query ran for an invalid spec");
            });
            test("sql: is null / not like / schema.table / default columns skip binary", () => {
                var f = NewFake();
                var r = Run(f, "sql-select", D("database", "MktData", "table", "[rpt].[Dup]"));
                Check(f.LastData == "SELECT TOP (@top) [A] FROM [rpt].[Dup]", f.LastData);
                r = Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote", "where", new[] { D("column", "Note", "op", "is null"), D("column", "StockName", "op", "NOT  LIKE", "value", "台%") }));
                Check(f.LastData.EndsWith("FROM [dbo].[DailyQuote] WHERE [Note] IS NULL AND [StockName] NOT LIKE @p1") && !f.LastData.Contains("[Blob]"), f.LastData);
                Check(f.LastParams[1].SqlDbType == SqlDbType.NVarChar, "nvarchar param");
                Check(((object[])r["skipped_columns"]).Contains("Blob") && (string)r["note"] != null, "skipped/note missing");
            });
            test("sql: agg builds grouped SELECT with ordering by aggregate", () => {
                var f = NewFake();
                f.Data = (s, p) => new SqlResult { Columns = new[] { "StockID", "a0", "a1" }, Rows = new List<object[]> { new object[] { "2330", 250L, new DateTime(2026, 9, 30) } } };
                var r = Run(f, "sql-agg", D("database", "MktData", "table", "DailyQuote", "group_by", new[] { "StockID" }, "aggregates", new[] { D("fn", "count"), D("fn", "max", "column", "TradeDate"), D("fn", "sum", "column", "Volume") }, "where", new[] { D("column", "TradeDate", "op", ">=", "value", "2026-01-01") }, "order_by", new[] { D("aggregate", 0, "desc", true) }, "top", 10));
                Check(f.LastData == "SELECT TOP (@top) [StockID], COUNT_BIG(*) AS [a0], MAX([TradeDate]) AS [a1], SUM(CAST([Volume] AS decimal(38,6))) AS [a2] FROM [dbo].[DailyQuote] WHERE [TradeDate] >= @p1 GROUP BY [StockID] ORDER BY [a0] DESC", f.LastData);
                var cols = ((object[])r["columns"]).Cast<string>().ToArray();
                Check(cols.SequenceEqual(new[] { "StockID", "count(*)", "max(TradeDate)", "sum(Volume)" }), string.Join(",", cols));
                var row = (object[])((object[])r["rows"])[0]; Check((string)row[2] == "2026-09-30", "date cell");
                Throws<InvalidDataException>(() => Run(f, "sql-agg", D("database", "MktData", "table", "DailyQuote", "group_by", new[] { "StockID" }, "aggregates", new[] { D("fn", "count") }, "order_by", new[] { D("column", "Volume") })), "group_by");
            });
            test("sql: results are cut to the 3900-char report bound with flags", () => {
                var f = NewFake();
                f.Data = (s, p) => new SqlResult { Columns = new[] { "StockID", "Note" }, Rows = Enumerable.Range(0, 200).Select(i => new object[] { "S" + i, new string('n', 500) }).ToList() };
                var r = Run(f, "sql-select", D("database", "MktData", "table", "DailyQuote", "columns", new[] { "StockID", "Note" }, "top", 200));
                int n = Convert.ToInt32(r["returned_rows"]);
                Check((bool)r["truncated_to_fit"] && n > 0 && n < 200 && ((object[])r["rows"]).Length == n, "not truncated: " + n);
                var cell = (string)((object[])((object[])r["rows"])[0])[1]; Check(cell.Length < 240 && cell.Contains("[500 chars]"), "cell not capped");
            });
            test("sql: cell formatting is invariant and bounded", () => {
                Check((string)SqlActions.Cell(new DateTime(2026, 9, 30)) == "2026-09-30", "date");
                Check((string)SqlActions.Cell(new DateTime(2026, 9, 30, 13, 5, 7)) == "2026-09-30 13:05:07", "datetime");
                Check((string)SqlActions.Cell(1234.5000m) == "1234.5000", "decimal");
                Check(SqlActions.Cell(DBNull.Value) == null && (long)SqlActions.Cell(5L) == 5L, "null/long");
                Check(((string)SqlActions.Cell(new byte[40])).EndsWith("...(40 bytes)"), "binary");
            });
            test("sql: tables and columns metadata", () => {
                var f = NewFake();
                f.Data = (s, p) => new SqlResult { Columns = new[] { "s", "n", "t", "r", "mb", "m" }, Rows = new List<object[]> { new object[] { "dbo", "DailyQuote", "USER_TABLE", 123456L, 12.5m, new DateTime(2026, 9, 1) } } };
                var r = Run(f, "sql-tables", D("database", "MktData", "like", "Daily%", "top", 5));
                Check(f.LastData.Contains("AND o.name LIKE @like") && f.LastParams.Any(x => x.ParameterName == "@like" && (string)x.Value == "Daily%"), "like param");
                Check(Convert.ToInt64(((object[])((object[])r["rows"])[0])[3]) == 123456L, "rows");
                var c = Run(f, "sql-columns", D("database", "MktData", "table", "dailyquote"));
                Check((string)c["table"] == "dbo.DailyQuote" && ((object[])c["primary_key"]).Length == 2, "pk");
                var types = ((object[])c["rows"]).Select(x => (string)((object[])x)[1]).ToList();
                Check(types.Contains("decimal(18,4)") && types.Contains("varchar(10)") && types.Contains("nvarchar(20)") && types.Contains("varchar(max)"), string.Join(",", types));
            });
            test("sql: date gaps vs weekdays, vs a reference table, text and int date columns", () => {
                var f = NewFake();
                // target has 9/1,9/2,9/4 (Tue,Wed,Fri); weekdays 9/1-9/4 → missing 9/3
                f.Data = (s, p) => {
                    if (s.StartsWith("SELECT TOP (1) [D8]")) return new SqlResult { Rows = new List<object[]> { new object[] { "20260930" } } };
                    if (s.Contains("[dbo].[TradeCal]")) return new SqlResult { Rows = new[] { 1, 2, 3, 4, 5 }.Select(d => new object[] { new DateTime(2026, 9, d) }).ToList() };
                    if (s.Contains("[dbo].[TxtDates]")) return new SqlResult { Rows = new List<object[]> { new object[] { "20260901" }, new object[] { "20260904" } } };
                    if (s.Contains("[dbo].[IntDates]")) return new SqlResult { Rows = new List<object[]> { new object[] { 20260902 } } };
                    return new SqlResult { Rows = new[] { 1, 2, 4 }.Select(d => new object[] { new DateTime(2026, 9, d) }).ToList() };
                };
                var r = Run(f, "sql-date-gaps", D("database", "MktData", "table", "DailyQuote", "date_column", "TradeDate", "from", "2026-09-01", "to", "2026-09-04", "where", new[] { D("column", "StockID", "op", "=", "value", "2330") }));
                Check(f.LastData == "SELECT DISTINCT CAST([TradeDate] AS date) FROM [dbo].[DailyQuote] WHERE [TradeDate] >= @f AND [TradeDate] < @t AND [StockID] = @w2", f.LastData);
                Check((DateTime)f.LastParams[1].Value == new DateTime(2026, 9, 5), "exclusive upper bound");
                Check(Convert.ToInt32(r["missing_count"]) == 1 && (string)((object[])r["missing"])[0] == "2026-09-03" && Convert.ToInt32(r["days_present"]) == 3, Common.Encode(r));
                r = Run(f, "sql-date-gaps", D("database", "MktData", "table", "DailyQuote", "date_column", "TradeDate", "from", "2026-09-01", "to", "2026-09-05", "reference", D("database", "MarketData", "table", "TradeCal", "date_column", "CalDate", "where", new[] { D("column", "IsOpen", "op", "=", "value", true) })));
                Check(Convert.ToInt32(r["missing_count"]) == 2 && ((object[])r["missing"]).Cast<string>().SequenceEqual(new[] { "2026-09-03", "2026-09-05" }), Common.Encode(r));
                r = Run(f, "sql-date-gaps", D("database", "MktData", "table", "TxtDates", "date_column", "D8", "from", "2026-09-01", "to", "2026-09-04"));
                Check(f.LastData.StartsWith("SELECT DISTINCT LEFT([D8], 8) FROM [dbo].[TxtDates] WHERE [D8] >= @f AND [D8] < @t") && (string)f.LastParams[1].Value == "20260905" && (string)r["format"] == "char yyyyMMdd", f.LastData);
                Check(((object[])r["missing"]).Cast<string>().SequenceEqual(new[] { "2026-09-02", "2026-09-03" }), Common.Encode(r));
                r = Run(f, "sql-date-gaps", D("database", "MktData", "table", "IntDates", "date_column", "YMD", "from", "2026-09-01", "to", "2026-09-02"));
                Check(f.LastData.Contains("[YMD] BETWEEN @f AND @t") && (int)f.LastParams[0].Value == 20260901 && Convert.ToInt32(r["missing_count"]) == 1, f.LastData + Common.Encode(r));
                Throws<InvalidDataException>(() => Run(f, "sql-date-gaps", D("database", "MktData", "table", "DailyQuote", "date_column", "TradeDate", "from", "2010-01-01", "to", "2026-01-01")), "days apart");
                Throws<InvalidDataException>(() => Run(f, "sql-date-gaps", D("database", "MktData", "table", "DailyQuote", "date_column", "ClosePrice", "from", "2026-09-01", "to", "2026-09-02")), "date_column must be");
            });
            test("sql: ping reports login, per-database write capability and enforcement mode", () => {
                var f = NewFake();
                f.Data = (s, p) => s.Contains("SERVERPROPERTY")
                    ? new SqlResult { Rows = new List<object[]> { new object[] { "RAGENT", "16.0.1000.6", "Developer Edition", "RAGENT\\agent", 0 } } }
                    : new SqlResult { Rows = new List<object[]> { new object[] { "dbo", 1, 0, 0, 1, 1, 1, 1, "READ_WRITE" } } };
                var r = Run(f, "sql-ping", new Dictionary<string, object>());
                Check((string)r["read_only_enforced_by"] == "agent_templates_only" && ((object[])r["databases"]).Length == 2, Common.Encode(r));
                f.Data = (s, p) => s.Contains("SERVERPROPERTY")
                    ? new SqlResult { Rows = new List<object[]> { new object[] { "RAGENT", "16", "Dev", "RAGENT\\ro", 0 } } }
                    : new SqlResult { Rows = new List<object[]> { new object[] { "ro", 0, 0, 0, 0, 0, 0, 0, "READ_WRITE" } } };
                r = Run(f, "sql-ping", new Dictionary<string, object>());
                Check((string)r["read_only_enforced_by"] == "account_permissions_and_agent_templates", Common.Encode(r));
            });
            test("sql: dispatch through LocalActions and AgentCore.Handle reaches SqlActions", () => {
                var f = NewFake(); SqlActions.Runner = c => f;
                string res = LocalActions.ExecuteAt("sql-tables", P(D("database", "MktData")), "http://127.0.0.1:9", 1000);
                Check((string)Common.Decode(res)["kind"] == "sql_tables", res);
            });
            test("sql: real SqlServerRunner wraps connection failure as a bounded error", () => {
                var runner = new SqlServerRunner(new SqlConfig { Server = "tcp:127.0.0.1,1", Databases = new[] { "x" } });
                var sw = System.Diagnostics.Stopwatch.StartNew();
                Throws<InvalidOperationException>(() => runner.Query("x", "SELECT 1", new List<SqlParameter>(), 1), "SQL error");
                Check(sw.Elapsed.TotalSeconds < 30, "connect did not time out promptly");
            });
        } finally { SqlActions.Runner = savedRunner; SqlActions.ConfigFile = null; try { File.Delete(cfgFile); } catch (IOException) { } }
    }
}
