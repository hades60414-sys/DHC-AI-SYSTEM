using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

// v3.3 (2026-10-02): sandbox writes for migration practice. The only databases this code creates, loads, backs up,
// restores or drops are named aiw_* AND recorded in <state>\sandbox-registry.json by this agent (with the database's
// create_date, re-checked before every write); every other database stays read-only. Off unless <state>\sandbox.txt
// (console-restricted, set-sandbox.cmd) says enabled=1. File paths are always derived from validated names, never read
// back from the registry. Data arrives as a package: a zip split into chunks, each encrypted to this device's certificate,
// listed in a manifest signed by the controller; the signed job carries the manifest hash.
namespace DbAgent {
public static class Canon {
    public static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\t", "\\t").Replace("\n", "\\n").Replace("\r", "\\r"); }
    public static string Unesc(string s) {
        if (s.IndexOf('\\') < 0) return s;
        var b = new StringBuilder(s.Length);
        for (int i = 0; i < s.Length; i++) {
            char c = s[i]; if (c != '\\') { b.Append(c); continue; }
            if (i + 1 == s.Length) throw new InvalidDataException("Dangling escape");
            char n = s[++i];
            if (n == 't') b.Append('\t'); else if (n == 'n') b.Append('\n'); else if (n == 'r') b.Append('\r'); else if (n == '\\') b.Append('\\');
            else throw new InvalidDataException("Unknown escape \\" + n);
        }
        return b.ToString();
    }
    static string TrimFrac(string s) { if (s.IndexOf('.') < 0) return s; s = s.TrimEnd('0'); return s.EndsWith(".") ? s.Substring(0, s.Length - 1) : s; }
    // One canonical text per value so the source export and the loaded copy hash the same regardless of engine.
    // Instants are compared in UTC (a datetimeoffset's original offset is not part of the value).
    public static string Value(object v, string sqlType) {
        if (v == null || v is DBNull) return "\\N";
        string t = (sqlType ?? "").ToLowerInvariant();
        if (v is decimal) { string s = TrimFrac(((decimal)v).ToString(CultureInfo.InvariantCulture)); return s == "-0" ? "0" : s; }
        if (v is bool) return (bool)v ? "1" : "0";
        if (v is DateTimeOffset) return TrimFrac(((DateTimeOffset)v).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss.fffffff", CultureInfo.InvariantCulture));
        if (v is DateTime) { var d = (DateTime)v; return t == "date" ? d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : TrimFrac(d.ToString("yyyy-MM-dd HH:mm:ss.fffffff", CultureInfo.InvariantCulture)); }
        if (v is TimeSpan) return TrimFrac(((TimeSpan)v).ToString("hh\\:mm\\:ss\\.fffffff", CultureInfo.InvariantCulture));
        if (v is double) return ((double)v).ToString("R", CultureInfo.InvariantCulture);
        if (v is float) return ((float)v).ToString("R", CultureInfo.InvariantCulture);
        if (v is byte[]) return "0x" + BitConverter.ToString((byte[])v).Replace("-", "");
        if (v is Guid) return ((Guid)v).ToString("D");
        if (v is IFormattable) return Esc(((IFormattable)v).ToString(null, CultureInfo.InvariantCulture));
        return Esc(v.ToString());
    }
    // Type family per column, so a copy with swapped same-valued columns or everything turned into text does not "match".
    public static string Family(string sqlType) {
        string t = (sqlType ?? "").ToLowerInvariant(); int p = t.IndexOf('('); if (p > 0) t = t.Substring(0, p);
        switch (t) {
            case "bigint": case "int": case "smallint": case "tinyint": return "int";
            case "decimal": case "numeric": case "money": case "smallmoney": return "dec";
            case "float": case "real": return "float";
            case "bit": return "bool";
            case "date": return "date";
            case "datetime": case "datetime2": case "smalldatetime": case "datetimeoffset": return "ts";
            case "time": return "time";
            case "binary": case "varbinary": case "image": case "timestamp": case "rowversion": return "bin";
            case "char": case "varchar": case "nchar": case "nvarchar": case "text": case "ntext": case "xml": case "uniqueidentifier": case "sysname": return "text";
        }
        return "other:" + t;
    }
    public static string SchemaFingerprint(IEnumerable<string[]> nameAndType) {
        string sig = string.Join(",", nameAndType.Select(c => c[0] + ":" + Family(c[1])));
        using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(sig))).Replace("-", "").Substring(0, 16).ToLowerInvariant();
    }
    // Order-independent: row count, plus sum and xor (mod 2^64) of the first 8 bytes of SHA-256 of each canonical line.
    public sealed class Fingerprint {
        readonly SHA256 h = SHA256.Create(); public long Rows; ulong sum, xor;
        public void Add(string line) {
            var d = h.ComputeHash(Encoding.UTF8.GetBytes(line)); ulong v = 0; for (int i = 0; i < 8; i++) v = (v << 8) | d[i];
            Rows++; unchecked { sum += v; } xor ^= v;
        }
        public string Text { get { return Rows.ToString(CultureInfo.InvariantCulture) + ":" + sum.ToString("x16") + ":" + xor.ToString("x16"); } }
    }
}

public static class Sandbox {
    public static string Root = null, BaseUrl = null; public static X509Certificate2 Device = null, Signer = null;
    public static Action<string, string, long> Download = (url, dest, max) => Transport.Fetch(url, dest, max);
    public const int ChunkBytes = 1024 * 1024, MaxBackups = 5, MaxPackageMb = 2000;
    static readonly string[] Actions = { "sb-list", "sb-fetch", "sb-load", "sb-backup", "sb-restore", "sb-drop" };
    public static bool Handles(string action) { return Actions.Contains(action); }
    public static string Names { get { return string.Join(",", Actions); } }
    static readonly Regex DbName = new Regex(@"^aiw_[a-z0-9_]{1,40}\z"), PkgName = new Regex(@"^[a-z0-9][a-z0-9_-]{0,40}\z"), Ident = new Regex(@"^[A-Za-z_][A-Za-z0-9_]{0,63}\z");
    static readonly Regex BakName = new Regex(@"^aiw_[a-z0-9_]{1,40}_[0-9]{8}_[0-9]{6}\.bak\z"), Hex64 = new Regex(@"^[0-9A-Fa-f]{64}\z");
    static readonly Regex SqlType = new Regex(@"^(bigint|int|smallint|tinyint|bit|date|time\([0-7]\)|datetime2\([0-7]\)|float|decimal\(([1-9]|[1-3][0-9]),([0-9]|[1-3][0-9])\)|nvarchar\(([1-9][0-9]{0,3}|max)\))\z");

    // ---- config / registry (both console/agent-only files: refused when anyone else owns or can write them) ----
    public sealed class Settings { public long MaxPackageBytes = 300L << 20; }
    public static Settings Config() {
        var lines = DocQa.ReadProtectedLines(Root == null ? null : Path.Combine(Root, "sandbox.txt"), "sandbox.txt (sandbox writes)");
        var s = new Settings(); bool enabled = false;
        foreach (var raw in lines) {
            string l = raw.Trim(); if (l.Length == 0 || l.StartsWith("#")) continue; int eq = l.IndexOf('=');
            string k = eq > 0 ? l.Substring(0, eq).Trim().ToLowerInvariant() : l, v = eq > 0 ? l.Substring(eq + 1).Trim() : "";
            if (k == "enabled") enabled = v == "1";
            else if (k == "max_package_mb") { int mb; if (!int.TryParse(v, out mb) || mb < 1 || mb > MaxPackageMb) throw new InvalidDataException("sandbox.txt: max_package_mb must be 1-" + MaxPackageMb); s.MaxPackageBytes = (long)mb << 20; }
            else throw new InvalidDataException("sandbox.txt: unknown key " + k);
        }
        if (!enabled) throw new InvalidOperationException("Sandbox writes are disabled (sandbox.txt does not say enabled=1)");
        return s;
    }
    public sealed class Entry { public string Name = "", Kind = "", Detail = "", Identity = "", Created = ""; public long Bytes; }
    public sealed class Registry { public int Version = 1; public List<Entry> Items = new List<Entry>(); }
    static string RegistryPath { get { return Path.Combine(Root, "sandbox-registry.json"); } }
    public static Registry LoadRegistry() {
        if (Root == null || !File.Exists(RegistryPath)) return new Registry();
        var r = Common.Json().Deserialize<Registry>(string.Join("\n", DocQa.ReadProtectedLines(RegistryPath, "sandbox-registry.json")));
        if (r == null || r.Items == null) throw new InvalidDataException("STOP: invalid sandbox registry"); return r;
    }
    static void Save(Registry r) {
        Common.Atomic(RegistryPath, Common.Encode(r));
        var acl = new FileSecurity(); acl.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { WindowsIdentity.GetCurrent().User.Value, "S-1-5-32-544", "S-1-5-18" })
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
        File.SetAccessControl(RegistryPath, acl);
    }
    static Entry Find(Registry r, string kind, string name) { return r.Items.FirstOrDefault(e => e.Kind == kind && e.Name == name); }
    public static bool IsSandboxDatabase(string name) { return Root != null && name != null && DbName.IsMatch(name) && Find(LoadRegistry(), "database", name) != null; }

    // ---- derived paths (never taken from the registry) ----
    static string PackageDir() {
        string dir = Path.Combine(Root, "sandbox"); Directory.CreateDirectory(dir);
        if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("sandbox folder is a link/junction; refusing");
        return dir;
    }
    static string PackagePath(string pkg) { return Path.Combine(PackageDir(), pkg + ".zip"); }
    static string BackupPath(SqlConnection master, string file) { return ServerPath(master, "InstanceDefaultBackupPath") + "\\" + file; }
    static string HashFile(string path) { using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(f)).Replace("-", ""); }

    // ---- spec helpers ----
    static Dictionary<string, object> Spec(string prompt, string keys) {
        var d = Common.Decode(prompt); var allowed = keys.Split(',');
        var bad = d.Keys.Where(k => !allowed.Contains(k)).ToList();
        if (bad.Count > 0) throw new InvalidDataException("Unknown field(s): " + string.Join(",", bad) + "; allowed: " + keys);
        return d;
    }
    static string Field(Dictionary<string, object> d, string k, Regex re, string what) {
        object v; if (!d.TryGetValue(k, out v) || !(v is string) || !re.IsMatch((string)v)) throw new InvalidDataException(k + " must be " + what);
        return (string)v;
    }
    static string Now() { return DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture); }

    // ---- SQL plumbing (no transactions: DDL, BACKUP and RESTORE cannot run inside one) ----
    static string Server() { return SqlActions.LoadConfig().Server; }
    static SqlConnection Open(string db) {
        var b = new SqlConnectionStringBuilder { DataSource = Server(), InitialCatalog = db, IntegratedSecurity = true, ApplicationName = "dbclone-agent-sandbox", ConnectTimeout = 10, Pooling = false };
        var c = new SqlConnection(b.ConnectionString); c.Open(); return c;
    }
    static List<object[]> Rows(SqlConnection c, string sql, int timeout, params SqlParameter[] ps) {
        var res = new List<object[]>();
        using (var cmd = c.CreateCommand()) { cmd.CommandText = sql; cmd.CommandTimeout = timeout; cmd.Parameters.AddRange(ps); using (var r = cmd.ExecuteReader()) while (r.Read()) { var row = new object[r.FieldCount]; r.GetValues(row); res.Add(row); } }
        return res;
    }
    static void Exec(SqlConnection c, string sql, int timeout, params SqlParameter[] ps) { using (var cmd = c.CreateCommand()) { cmd.CommandText = sql; cmd.CommandTimeout = timeout; cmd.Parameters.AddRange(ps); cmd.ExecuteNonQuery(); } }
    static SqlParameter P(string n, string v) { return new SqlParameter(n, SqlDbType.NVarChar, 4000) { Value = v }; }
    // database_id + create_date: a registered name re-created by someone else no longer matches.
    static string Identity(SqlConnection master, string db) {
        var r = Rows(master, "SELECT CAST(database_id AS varchar(10)) + '@' + CONVERT(varchar(30), create_date, 126) FROM sys.databases WHERE name = @n", 15, P("@n", db));
        return r.Count == 0 ? null : (string)r[0][0];
    }
    static Entry Owned(SqlConnection master, Registry reg, string db) {
        var e = Find(reg, "database", db);
        if (e == null) throw new UnauthorizedAccessException("Only sandbox databases created by this agent can be written: " + db);
        string id = Identity(master, db);
        if (id != null && id != e.Identity) throw new UnauthorizedAccessException("Database " + db + " is no longer the one this agent created (dropped and re-created elsewhere); refusing");
        return e;
    }
    static string ServerPath(SqlConnection master, string prop) {
        var v = Rows(master, "SELECT CAST(SERVERPROPERTY(@p) AS nvarchar(4000))", 15, P("@p", prop))[0][0] as string;
        // LocalDB and some older installs report NULL; the folder holding master's own files is always usable by the service.
        if (string.IsNullOrEmpty(v)) v = Path.GetDirectoryName((string)Rows(master, "SELECT physical_name FROM sys.master_files WHERE database_id = 1 AND type = @t", 15, new SqlParameter("@t", SqlDbType.TinyInt) { Value = (byte)(prop == "InstanceDefaultLogPath" ? 1 : 0) })[0][0]);
        return v.TrimEnd('\\');
    }
    static string BackupGuid(SqlConnection master, string path) {
        using (var cmd = master.CreateCommand()) {
            cmd.CommandText = "RESTORE HEADERONLY FROM DISK = @p"; cmd.CommandTimeout = 300; cmd.Parameters.Add(P("@p", path));
            using (var r = cmd.ExecuteReader()) { if (!r.Read()) throw new InvalidDataException("Backup has no header"); return Convert.ToString(r["BackupSetGUID"], CultureInfo.InvariantCulture) + "|" + Convert.ToString(r["DatabaseName"], CultureInfo.InvariantCulture); }
        }
    }

    public static string Execute(string action, string prompt) {
        if (action == "sb-list") { Spec(prompt, ""); return List(); }
        var cfg = Config();
        try {
            switch (action) {
                case "sb-fetch": return Fetch(cfg, Spec(prompt, "package,manifest_sha256"));
                case "sb-load": return Load(cfg, Spec(prompt, "package,database"));
                case "sb-backup": return Backup(Spec(prompt, "database"));
                case "sb-restore": return Restore(Spec(prompt, "backup,as"));
                case "sb-drop": return Drop(Spec(prompt, "database,backup,package"));
            }
        } catch (SqlException e) { throw new InvalidOperationException("SQL error " + e.Number + ": " + e.Message); }
        throw new InvalidOperationException("Action not allowed");
    }

    // ---- packaging (controller side) ----
    public static string SealChunk(byte[] data, X509Certificate2 device) {
        var env = new EnvelopedCms(new ContentInfo(data), new AlgorithmIdentifier(new Oid("2.16.840.1.101.3.4.1.42")));
        env.Encrypt(new CmsRecipient(SubjectIdentifierType.IssuerAndSerialNumber, device));
        return Convert.ToBase64String(env.Encode());
    }
    public static string Pack(byte[] zip, string package, X509Certificate2 signer, X509Certificate2 device, Action<string, string> writeAsset) {
        if (!PkgName.IsMatch(package)) throw new InvalidDataException("package name must match " + PkgName);
        var chunks = new List<Dictionary<string, object>>();
        for (int i = 0, off = 0; off < zip.Length; i++, off += ChunkBytes) {
            var part = new byte[Math.Min(ChunkBytes, zip.Length - off)]; Buffer.BlockCopy(zip, off, part, 0, part.Length);
            string asset = package + "." + i.ToString("D4", CultureInfo.InvariantCulture) + ".cms.b64.txt";
            writeAsset(asset, SealChunk(part, device));
            chunks.Add(new Dictionary<string, object> { { "asset", asset }, { "sha256", Common.Hash(part) } });
        }
        var m = new Dictionary<string, object> { { "kind", "sandbox-package-manifest" }, { "package", package }, { "zip_sha256", Common.Hash(zip) }, { "zip_bytes", (long)zip.Length }, { "chunks", chunks } };
        string wire = Common.Seal(Common.Encode(m), signer, device);
        writeAsset(package + ".manifest.cms.b64.txt", wire);
        return Common.Hash(Encoding.UTF8.GetBytes(wire));
    }

    // ---- sb-fetch ----
    static string Fetch(Settings cfg, Dictionary<string, object> d) {
        string pkg = Field(d, "package", PkgName, "a package name (" + PkgName + ")");
        string want = Field(d, "manifest_sha256", Hex64, "64 hex characters").ToUpperInvariant();
        if (Device == null || Signer == null || BaseUrl == null) throw new InvalidOperationException("Sandbox transport is not initialised");
        var sw = Stopwatch.StartNew(); string dir = PackageDir(), tmp = Path.Combine(dir, pkg + ".download"), zipPath = PackagePath(pkg), part = zipPath + ".part";
        try {
            Download(BaseUrl + "/" + pkg + ".manifest.cms.b64.txt", tmp, Common.MaxWire);
            byte[] wireBytes = File.ReadAllBytes(tmp);
            if (Common.Hash(wireBytes) != want) throw new InvalidDataException("Manifest hash does not match the signed job; nothing fetched");
            X509Certificate2 signer; var m = Common.Open(Encoding.UTF8.GetString(wireBytes), Device, Signer, out signer);
            Common.Exact(m, "kind,package,zip_sha256,zip_bytes,chunks");
            if (Common.S(m, "kind") != "sandbox-package-manifest" || Common.S(m, "package") != pkg) throw new InvalidDataException("Manifest is for a different package");
            long total = Common.N(m, "zip_bytes"); string zipSha = Common.S(m, "zip_sha256");
            if (total <= 0 || total > cfg.MaxPackageBytes) throw new InvalidDataException("Package size " + total + " outside 1.." + cfg.MaxPackageBytes + " bytes (sandbox.txt max_package_mb)");
            long free = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(dir))).AvailableFreeSpace;
            if (free < 3 * total) throw new IOException("Not enough free disk for the package: " + (free >> 20) + " MB free, need " + (3 * total >> 20) + " MB");
            var chunks = (m["chunks"] as object[]) ?? new object[0];
            if (chunks.Length != (int)((total + ChunkBytes - 1) / ChunkBytes)) throw new InvalidDataException("Manifest chunk count does not match the package size");
            long written = 0;
            using (var outFile = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None)) {
                for (int i = 0; i < chunks.Length; i++) {
                    var c = chunks[i] as Dictionary<string, object>; if (c == null) throw new InvalidDataException("Bad chunk entry");
                    Common.Exact(c, "asset,sha256"); string asset = Common.S(c, "asset");
                    if (asset != pkg + "." + i.ToString("D4", CultureInfo.InvariantCulture) + ".cms.b64.txt") throw new InvalidDataException("Unexpected chunk asset name: " + asset);
                    Download(BaseUrl + "/" + asset, tmp, 3L * ChunkBytes);
                    var env = new EnvelopedCms(); env.Decode(Convert.FromBase64String(File.ReadAllText(tmp, Encoding.ASCII)));
                    if (env.ContentEncryptionAlgorithm.Oid.Value != "2.16.840.1.101.3.4.1.42") throw new CryptographicException("Unexpected chunk encryption algorithm");
                    env.Decrypt(new X509Certificate2Collection(Device)); var data = env.ContentInfo.Content;
                    if (Common.Hash(data) != Common.S(c, "sha256")) throw new InvalidDataException("Chunk " + i + " hash mismatch; package rejected");
                    outFile.Write(data, 0, data.Length); written += data.Length;
                }
            }
            if (written != total || HashFile(part) != zipSha) throw new InvalidDataException("Assembled package does not match the manifest");
            if (File.Exists(zipPath)) File.Delete(zipPath);
            File.Move(part, zipPath);
            var reg = LoadRegistry(); reg.Items.RemoveAll(e => e.Kind == "package" && e.Name == pkg);
            reg.Items.Add(new Entry { Kind = "package", Name = pkg, Identity = zipSha, Bytes = total, Created = Now(), Detail = zipPath }); Save(reg);
            return Common.Encode(new { kind = "sb_fetch", package = pkg, bytes = total, chunks = chunks.Length, zip_sha256 = zipSha, seconds = Math.Round(sw.Elapsed.TotalSeconds, 1) });
        } finally {
            foreach (var f in new[] { tmp, part }) try { if (File.Exists(f)) File.Delete(f); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    // ---- sb-load ----
    sealed class TableSpec { public string Name, Fingerprint, SchemaFingerprint; public List<string[]> Cols = new List<string[]>(); public List<string> Pk = new List<string>(); public long Rows; }
    static List<TableSpec> ParseSchema(string json) {
        var d = Common.Decode(json); if (Common.S(d, "kind") != "sandbox-package") throw new InvalidDataException("schema.json is not a sandbox package");
        var res = new List<TableSpec>();
        foreach (Dictionary<string, object> t in (object[])d["tables"]) {
            var ts = new TableSpec { Name = Common.S(t, "name"), Rows = Common.N(t, "rows"), Fingerprint = Common.S(t, "fingerprint"), SchemaFingerprint = Common.S(t, "schema_fingerprint") };
            if (!Ident.IsMatch(ts.Name)) throw new InvalidDataException("Bad table name: " + ts.Name);
            foreach (Dictionary<string, object> c in (object[])t["columns"]) {
                string n = Common.S(c, "name"), ty = Common.S(c, "sql_type").ToLowerInvariant(); object nul; c.TryGetValue("nullable", out nul);
                if (!Ident.IsMatch(n) || !SqlType.IsMatch(ty)) throw new InvalidDataException("Bad column " + ts.Name + "." + n + " " + ty);
                ts.Cols.Add(new[] { n, ty, (nul is bool && (bool)nul) ? "NULL" : "NOT NULL" });
            }
            foreach (var p in (object[])t["primary_key"]) { var s = p as string; if (s == null || !ts.Cols.Any(c => c[0] == s)) throw new InvalidDataException("Bad primary key column in " + ts.Name); ts.Pk.Add(s); }
            if (ts.Cols.Count == 0 || ts.Cols.Count > 200) throw new InvalidDataException("Bad column count in " + ts.Name);
            if (Canon.SchemaFingerprint(ts.Cols) != ts.SchemaFingerprint) throw new InvalidDataException(ts.Name + ": column types do not match the exported schema fingerprint");
            res.Add(ts);
        }
        if (res.Count == 0 || res.Count > 100) throw new InvalidDataException("Package must hold 1-100 tables");
        return res;
    }
    static Type ClrType(string ty) {
        if (ty == "bigint") return typeof(long); if (ty == "int") return typeof(int); if (ty == "smallint") return typeof(short); if (ty == "tinyint") return typeof(byte);
        if (ty == "bit") return typeof(bool); if (ty == "float") return typeof(double); if (ty.StartsWith("decimal")) return typeof(decimal);
        if (ty == "date" || ty.StartsWith("datetime2")) return typeof(DateTime); if (ty.StartsWith("time")) return typeof(TimeSpan); return typeof(string);
    }
    static readonly string[] DtFormats = { "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm:ss.FFFFFFF" };
    static object Parse(string raw, string ty) {
        if (raw == "\\N") return DBNull.Value;
        var t = ClrType(ty); var ci = CultureInfo.InvariantCulture;
        if (t == typeof(string)) return Canon.Unesc(raw);
        if (t == typeof(long)) return long.Parse(raw, ci); if (t == typeof(int)) return int.Parse(raw, ci); if (t == typeof(short)) return short.Parse(raw, ci); if (t == typeof(byte)) return byte.Parse(raw, ci);
        if (t == typeof(bool)) { if (raw == "1") return true; if (raw == "0") return false; throw new InvalidDataException("bit value " + raw); }
        if (t == typeof(double)) return double.Parse(raw, NumberStyles.Float, ci);
        if (t == typeof(decimal)) return decimal.Parse(raw, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, ci);
        if (t == typeof(TimeSpan)) return TimeSpan.ParseExact(raw, new[] { "hh\\:mm\\:ss", "hh\\:mm\\:ss\\.FFFFFFF" }, ci);
        if (ty == "date") return DateTime.ParseExact(raw, "yyyy-MM-dd", ci);
        return DateTime.ParseExact(raw, DtFormats, ci, DateTimeStyles.None);
    }
    static string Load(Settings cfg, Dictionary<string, object> d) {
        string pkg = Field(d, "package", PkgName, "a fetched package name"), db = Field(d, "database", DbName, "a sandbox name like aiw_practice (aiw_ + lowercase letters, digits, _)");
        var reg = LoadRegistry(); var pe = Find(reg, "package", pkg); string zipPath = PackagePath(pkg);
        if (pe == null || !File.Exists(zipPath) || HashFile(zipPath) != pe.Identity) throw new InvalidDataException("Package " + pkg + " is not fetched or no longer matches its hash; run sb-fetch");
        var sw = Stopwatch.StartNew(); var loaded = new List<object>();
        using (var zip = ZipFile.OpenRead(zipPath)) {
            var schemaEntry = zip.GetEntry("schema.json"); if (schemaEntry == null || schemaEntry.Length > Common.MaxWire) throw new InvalidDataException("Package has no (or an oversized) schema.json");
            List<TableSpec> tables; using (var r = new StreamReader(schemaEntry.Open(), new UTF8Encoding(false))) tables = ParseSchema(r.ReadToEnd());
            long unzipped = zip.Entries.Sum(e => e.Length);
            if (unzipped > 8 * cfg.MaxPackageBytes) throw new InvalidDataException("Unpacked data " + (unzipped >> 20) + " MB exceeds 8x max_package_mb");
            using (var master = Open("master")) {
                if (Identity(master, db) != null) {
                    if (Find(reg, "database", db) == null) throw new UnauthorizedAccessException("Database " + db + " exists but was not created by this agent; refusing to write to it");
                    Owned(master, reg, db);
                } else {
                    var free = Rows(master, "SELECT TOP (1) vs.available_bytes FROM sys.master_files f CROSS APPLY sys.dm_os_volume_stats(f.database_id, f.file_id) vs WHERE f.database_id = 1 AND f.type = 0", 15);
                    long avail = free.Count == 0 ? long.MaxValue : Convert.ToInt64(free[0][0], CultureInfo.InvariantCulture);
                    if (avail < 3 * unzipped) throw new IOException("Not enough free disk on the SQL data volume: " + (avail >> 20) + " MB free, need about " + (3 * unzipped >> 20) + " MB");
                    if (reg.Items.Count(e => e.Kind == "database") >= 10) throw new InvalidOperationException("Already 10 sandbox databases; drop some first");
                    Exec(master, "CREATE DATABASE " + SqlActions.Q(db), 300);
                    Exec(master, "ALTER DATABASE " + SqlActions.Q(db) + " SET RECOVERY SIMPLE", 60);
                    reg.Items.Add(new Entry { Kind = "database", Name = db, Created = Now(), Identity = Identity(master, db), Detail = "loaded from package " + pkg }); Save(reg);
                }
            }
            using (var conn = Open(db)) {
                foreach (var t in tables) {
                    if (Rows(conn, "SELECT 1 FROM sys.tables WHERE name = @n AND schema_id = 1", 15, P("@n", t.Name)).Count > 0) throw new InvalidOperationException("Table dbo." + t.Name + " already exists in " + db + "; load into a new sandbox database");
                    string ddl = "CREATE TABLE dbo." + SqlActions.Q(t.Name) + " (" + string.Join(", ", t.Cols.Select(c => SqlActions.Q(c[0]) + " " + c[1] + " " + c[2]))
                        + (t.Pk.Count > 0 ? ", CONSTRAINT " + SqlActions.Q("PK_" + t.Name) + " PRIMARY KEY (" + string.Join(", ", t.Pk.Select(SqlActions.Q)) + ")" : "") + ")";
                    Exec(conn, ddl, 60);
                    var entry = zip.GetEntry("tables/" + t.Name + ".tsv"); if (entry == null) throw new InvalidDataException("Package has no data for " + t.Name);
                    var fp = new Canon.Fingerprint(); var dt = new DataTable(); var parsed = new string[t.Cols.Count];
                    foreach (var c in t.Cols) dt.Columns.Add(c[0], ClrType(c[1]));
                    using (var bulk = new SqlBulkCopy(conn, SqlBulkCopyOptions.TableLock | SqlBulkCopyOptions.CheckConstraints, null) { DestinationTableName = "dbo." + SqlActions.Q(t.Name), BulkCopyTimeout = 600 })
                    using (var r = new StreamReader(entry.Open(), new UTF8Encoding(false))) {
                        string line; long n = 0;
                        while ((line = r.ReadLine()) != null) {
                            if (line.Length > 1000000) throw new InvalidDataException(t.Name + " line " + (n + 1) + " is longer than 1,000,000 characters");
                            var f = line.Split('\t'); if (f.Length != t.Cols.Count) throw new InvalidDataException(t.Name + " line " + (n + 1) + ": " + f.Length + " fields, expected " + t.Cols.Count);
                            var row = dt.NewRow();
                            for (int i = 0; i < f.Length; i++) { var v = Parse(f[i], t.Cols[i][1]); row[i] = v; parsed[i] = Canon.Value(v, t.Cols[i][1]); }
                            fp.Add(string.Join("\t", parsed));   // hash what is actually loaded, not the raw text
                            dt.Rows.Add(row); n++;
                            if (dt.Rows.Count == 50000) { bulk.WriteToServer(dt); dt.Clear(); }
                        }
                        if (dt.Rows.Count > 0) bulk.WriteToServer(dt);
                    }
                    if (fp.Text != t.Fingerprint || fp.Rows != t.Rows) throw new InvalidDataException(t.Name + ": parsed values fingerprint " + fp.Text + " does not match the export " + t.Fingerprint);
                    loaded.Add(new Dictionary<string, object> { { "table", "dbo." + t.Name }, { "rows", fp.Rows }, { "source_fingerprint", t.Fingerprint }, { "source_schema_fingerprint", t.SchemaFingerprint } });
                }
            }
        }
        return Common.Encode(new { kind = "sb_load", database = db, package = pkg, tables = loaded, seconds = Math.Round(sw.Elapsed.TotalSeconds, 1), next = "verify with sql-fingerprint {database:\"" + db + "\"} against the source fingerprints" });
    }

    // ---- sb-backup / sb-restore ----
    static string Backup(Dictionary<string, object> d) {
        string db = Field(d, "database", DbName, "a sandbox database name"); var reg = LoadRegistry();
        if (reg.Items.Count(e => e.Kind == "backup") >= MaxBackups) throw new InvalidOperationException("Already " + MaxBackups + " sandbox backups; drop one first (sb-drop {backup})");
        var sw = Stopwatch.StartNew();
        using (var master = Open("master")) {
            if (Identity(master, db) == null) throw new InvalidOperationException("Database not found: " + db);
            Owned(master, reg, db);
            string file = db + "_" + DateTime.Now.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture) + ".bak", path = BackupPath(master, file);
            if (Find(reg, "backup", file) != null || File.Exists(path)) throw new InvalidOperationException("A backup named " + file + " already exists; retry in a second");
            Exec(master, "BACKUP DATABASE " + SqlActions.Q(db) + " TO DISK = @p WITH COPY_ONLY, CHECKSUM, FORMAT, INIT", 1800, P("@p", path));
            Exec(master, "RESTORE VERIFYONLY FROM DISK = @p WITH CHECKSUM", 1800, P("@p", path));
            string guid = BackupGuid(master, path);
            var size = Rows(master, "SELECT TOP (1) backup_size FROM msdb.dbo.backupset b JOIN msdb.dbo.backupmediafamily f ON f.media_set_id = b.media_set_id WHERE f.physical_device_name = @p ORDER BY b.backup_finish_date DESC", 30, P("@p", path));
            long bytes = size.Count == 0 ? -1 : Convert.ToInt64(size[0][0], CultureInfo.InvariantCulture);
            reg.Items.Add(new Entry { Kind = "backup", Name = file, Detail = db, Identity = guid, Bytes = bytes, Created = Now() }); Save(reg);
            return Common.Encode(new { kind = "sb_backup", database = db, backup = file, path, bytes, verified = "RESTORE VERIFYONLY WITH CHECKSUM passed", seconds = Math.Round(sw.Elapsed.TotalSeconds, 1) });
        }
    }
    static string Restore(Dictionary<string, object> d) {
        string file = Field(d, "backup", BakName, "a backup file name from sb-list"), target = Field(d, "as", DbName, "a new sandbox database name");
        var reg = LoadRegistry(); var be = Find(reg, "backup", file);
        if (be == null) throw new UnauthorizedAccessException("Only backups made by sb-backup can be restored here: " + file);
        if (Find(reg, "database", target) != null) throw new InvalidOperationException("Sandbox database " + target + " already exists; drop it first or pick another name");
        if (reg.Items.Count(e => e.Kind == "database") >= 10) throw new InvalidOperationException("Already 10 sandbox databases; drop some first");
        var sw = Stopwatch.StartNew();
        using (var master = Open("master")) {
            if (Identity(master, target) != null) throw new UnauthorizedAccessException("Database " + target + " exists on the server; restore never overwrites");
            string path = BackupPath(master, file);
            if (BackupGuid(master, path) != be.Identity) throw new UnauthorizedAccessException("Backup file " + file + " is not the one sb-backup wrote (header changed); refusing");
            var files = Rows(master, "RESTORE FILELISTONLY FROM DISK = @p", 300, P("@p", path));
            string dataDir = ServerPath(master, "InstanceDefaultDataPath"), logDir = ServerPath(master, "InstanceDefaultLogPath");
            var ps = new List<SqlParameter> { P("@p", path) }; var moves = new List<string>();
            for (int i = 0; i < files.Count; i++) {
                string logical = (string)files[i][0], type = (string)files[i][2];
                string phys = (type == "L" ? logDir : dataDir) + "\\" + target + "_" + i + (type == "L" ? ".ldf" : ".mdf");
                if (File.Exists(phys)) throw new InvalidOperationException("Target file already exists: " + phys);
                ps.Add(P("@l" + i, logical)); ps.Add(P("@m" + i, phys)); moves.Add("MOVE @l" + i + " TO @m" + i);
            }
            Exec(master, "RESTORE DATABASE " + SqlActions.Q(target) + " FROM DISK = @p WITH CHECKSUM, RECOVERY, " + string.Join(", ", moves), 1800, ps.ToArray());
            reg.Items.Add(new Entry { Kind = "database", Name = target, Created = Now(), Identity = Identity(master, target), Detail = "restored from " + file }); Save(reg);
            return Common.Encode(new { kind = "sb_restore", database = target, from_backup = file, files = files.Count, seconds = Math.Round(sw.Elapsed.TotalSeconds, 1), next = "verify with sql-fingerprint {database:\"" + target + "\"} and compare with the original" });
        }
    }

    // ---- sb-drop / sb-list ----
    static string Drop(Dictionary<string, object> d) {
        if (d.Count != 1) throw new InvalidDataException("Give exactly one of database, backup, package");
        var reg = LoadRegistry();
        if (d.ContainsKey("database")) {
            string db = Field(d, "database", DbName, "a sandbox database name");
            using (var master = Open("master")) {
                Owned(master, reg, db);
                if (Identity(master, db) != null) { Exec(master, "ALTER DATABASE " + SqlActions.Q(db) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE", 120); Exec(master, "DROP DATABASE " + SqlActions.Q(db), 300); }
            }
            reg.Items.RemoveAll(e => e.Kind == "database" && e.Name == db); Save(reg);
            return Common.Encode(new { kind = "sb_drop", dropped = "database", name = db });
        }
        if (d.ContainsKey("backup")) {
            string file = Field(d, "backup", BakName, "a backup file name from sb-list"); var be = Find(reg, "backup", file);
            if (be == null) throw new UnauthorizedAccessException("Only backups made by sb-backup can be deleted: " + file);
            using (var master = Open("master")) {
                string path = BackupPath(master, file);
                if (File.Exists(path)) { if (BackupGuid(master, path) != be.Identity) throw new UnauthorizedAccessException("Backup file " + file + " is not the one sb-backup wrote; not deleting"); File.Delete(path); }
            }
            reg.Items.Remove(be); Save(reg); return Common.Encode(new { kind = "sb_drop", dropped = "backup", name = file });
        }
        string pkg = Field(d, "package", PkgName, "a fetched package name"); var pe = Find(reg, "package", pkg);
        if (pe == null) throw new InvalidDataException("Package not fetched: " + pkg);
        string zipPath = PackagePath(pkg); if (File.Exists(zipPath)) File.Delete(zipPath);
        reg.Items.Remove(pe); Save(reg); return Common.Encode(new { kind = "sb_drop", dropped = "package", name = pkg });
    }
    static string List() {
        var reg = LoadRegistry(); string enabled; try { Config(); enabled = "yes"; } catch (Exception e) { enabled = "no: " + e.Message; }
        var live = new Dictionary<string, object>(); object freeMb = null;
        try {
            using (var master = Open("master")) {
                foreach (var r in Rows(master, "SELECT d.name, CAST(SUM(CAST(f.size AS bigint)) * 8 / 1024.0 AS decimal(18,1)) FROM sys.databases d JOIN sys.master_files f ON f.database_id = d.database_id WHERE d.name LIKE 'aiw[_]%' GROUP BY d.name", 30))
                    live[(string)r[0]] = Canon.Value(r[1], "decimal");
                var fr = Rows(master, "SELECT TOP (1) vs.available_bytes / 1048576 FROM sys.master_files f CROSS APPLY sys.dm_os_volume_stats(f.database_id, f.file_id) vs WHERE f.database_id = 1 AND f.type = 0", 15);
                if (fr.Count > 0) freeMb = Convert.ToInt64(fr[0][0], CultureInfo.InvariantCulture);
            }
        } catch (Exception e) { if (e is OutOfMemoryException) throw; live["error"] = e.Message.Length > 200 ? e.Message.Substring(0, 200) : e.Message; }
        return Common.Encode(new { kind = "sb_list", sandbox_enabled = enabled, sql_data_volume_free_mb = freeMb, items = reg.Items.Select(e => new { e.Kind, e.Name, e.Created, e.Bytes, e.Detail, size_mb = e.Kind == "database" && live.ContainsKey(e.Name) ? live[e.Name] : null, on_server = e.Kind != "database" ? (bool?)null : live.ContainsKey(e.Name) }).ToList(),
            unregistered_aiw_databases = live.Keys.Where(k => k != "error" && Find(reg, "database", k) == null).ToList(), note = "only registered items can be written, backed up, restored or dropped" });
    }
}
}
