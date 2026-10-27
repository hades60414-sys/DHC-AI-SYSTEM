using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace DbAgent {
// srv-db remote update (v3.4, 2026-10-02, user asked to bring RAG1's self-update to srv-db): a signed "self-update" job names a kit
// zip on the channel's own asset base URL and its SHA-256. The agent downloads it, checks the hash, stages its flat file list
// under a fresh <root>\update\staging-<time> folder, reports, exits, and then starts the kit's apply-update.cmd, which
// installs, restarts the agent and restores the previous agent if the new one does not come up. Same design as rag1\srcD.
public static class Updater {
    public const long MaxKitBytes = 64L * 1024 * 1024;
    public const int MaxKitEntries = 64;
    static readonly Regex FileRe = new Regex(@"^[A-Za-z0-9._-]{1,120}\.zip$"), ShaRe = new Regex(@"^[0-9A-Fa-f]{64}$"), EntryRe = new Regex(@"^[A-Za-z0-9._-]{1,120}$");
    public static readonly string[] Required = { "apply-update.cmd" };
    // A fresh folder per job: processes started by an earlier apply can still hold an older staging folder open.
    static string NewStagingDir(string root) { return Path.Combine(root, "update", "staging-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff")); }
    static string PointerFile(string root) { return Path.Combine(root, "update", "staged.txt"); }
    public static string StagingDir(string root) { string p = PointerFile(root); return File.Exists(p) ? File.ReadAllText(p).Trim() : ""; }
    static void CleanOldStaging(string root, string keep) {
        foreach (var d in Directory.GetDirectories(Path.Combine(root, "update"), "staging*"))
            if (!string.Equals(d, keep, StringComparison.OrdinalIgnoreCase)) { try { Directory.Delete(d, true); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }

    public static void ParseJob(string prompt, out string file, out string sha) {
        var d = Common.Decode(prompt);
        foreach (var k in d.Keys) if (k != "file" && k != "sha256") throw new InvalidDataException("Unexpected self-update field: " + k);
        file = Common.S(d, "file"); sha = Common.S(d, "sha256").ToUpperInvariant();
        if (!FileRe.IsMatch(file)) throw new InvalidDataException("file must be a plain .zip asset name");
        if (!ShaRe.IsMatch(sha)) throw new InvalidDataException("sha256 must be 64 hex characters");
    }

    public static string Execute(string root, string prompt, string baseUrl) {
        string file, sha; ParseJob(prompt, out file, out sha);
        string dir = Path.Combine(root, "update"); Directory.CreateDirectory(dir);
        string zip = Path.Combine(dir, "download.zip");
        if (File.Exists(zip)) File.Delete(zip);
        Download(baseUrl.TrimEnd('/') + "/" + file, zip);
        string actual; using (var s = File.OpenRead(zip)) using (var h = SHA256.Create()) actual = BitConverter.ToString(h.ComputeHash(s)).Replace("-", "");
        if (actual != sha) throw new InvalidDataException("Kit hash mismatch: expected " + sha + ", got " + actual);
        string staging = NewStagingDir(root);
        int n = Stage(zip, staging);
        File.WriteAllText(PointerFile(root), staging);
        CleanOldStaging(root, staging);
        return "Staged " + n + " files from " + file + " (sha256 " + sha + "). The agent exits after this report; apply-update.cmd installs the kit, restarts the agent, and restores the previous agent if the new one does not come up. Log: update\\apply-*.log.";
    }

    static void Download(string url, string target) {
        var psi = new ProcessStartInfo("curl.exe", string.Join(" ", new[] { "--ssl-revoke-best-effort", "-fsSL", "--connect-timeout", "20", "--max-time", "600", "--max-filesize", MaxKitBytes.ToString(), "-o", target, url }.Select(Common.Q))) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true };
        foreach (var k in Common.CredentialKeys) psi.EnvironmentVariables.Remove(k);
        using (var p = Process.Start(psi)) {
            string err = p.StandardError.ReadToEnd();
            if (!p.WaitForExit(620000)) { try { p.Kill(); } catch { } throw new IOException("Kit download timed out"); }
            if (p.ExitCode != 0) throw new IOException("Kit download failed (curl " + p.ExitCode + "): " + Common.Safe(err));
        }
        var f = new FileInfo(target);
        if (!f.Exists || f.Length == 0 || f.Length > MaxKitBytes) throw new InvalidDataException("Kit download missing or out of bounds");
    }

    // Flat kits only: every entry is a plain file name, so nothing can be written outside the staging folder.
    public static int Stage(string zipPath, string staging) {
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);
        using (var z = ZipFile.OpenRead(zipPath)) {
            if (z.Entries.Count == 0 || z.Entries.Count > MaxKitEntries) throw new InvalidDataException("Kit must contain 1-" + MaxKitEntries + " files");
            long total = 0;
            foreach (var e in z.Entries) {
                if (!EntryRe.IsMatch(e.FullName) || e.FullName.StartsWith(".")) throw new InvalidDataException("Kit entry must be a plain file name: " + e.FullName);
                total += e.Length; if (total > MaxKitBytes) throw new InvalidDataException("Kit expands beyond bound");
            }
            foreach (var r in Required) if (!z.Entries.Any(e => string.Equals(e.FullName, r, StringComparison.OrdinalIgnoreCase))) throw new InvalidDataException("Kit lacks " + r);
            foreach (var e in z.Entries) e.ExtractToFile(Path.Combine(staging, e.FullName), true);
            return z.Entries.Count;
        }
    }

    // Started only after the final report is uploaded; apply-update.cmd waits for this process to exit before installing.
    public static void LaunchApply(string root) {
        string staged = StagingDir(root), script = Path.Combine(staged, "apply-update.cmd");
        if (!File.Exists(script)) throw new FileNotFoundException("apply-update.cmd is not staged");
        var psi = new ProcessStartInfo("cmd.exe", "/c start \"RAGENT update\" /min cmd /c " + Common.Q(script)) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root };
        foreach (var k in Common.CredentialKeys) psi.EnvironmentVariables.Remove(k);
        Process.Start(psi).Dispose();
    }
}
}
