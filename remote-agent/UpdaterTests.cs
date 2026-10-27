using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using DbAgent;

// v3.4 self-update tests (ported from rag1\TestsD.cs): job parsing and flat-kit staging. The job flow is in Tests.cs.
public static class UpdaterTests {
    static void Check(bool b, string why) { if (!b) throw new Exception(why); }
    static void Throws<T>(Action run) where T : Exception { try { run(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
    static string Job(string file, string sha) { return Common.Encode(new Dictionary<string, object> { { "file", file }, { "sha256", sha } }); }

    public static void Run(string work, Action<string, Action> test) {
        test("self-update accepts only a plain .zip asset name and a 64-hex hash", () => {
            string f, h; string good = new string('a', 64);
            Updater.ParseJob(Job("ragent-update.zip", good), out f, out h);
            Check(f == "ragent-update.zip" && h == good.ToUpperInvariant(), "valid job rejected or hash not normalized");
            foreach (var bad in new[] { "../ragent-update.zip", "https://x/y.zip", "kit.exe", "a b.zip", "" }) Throws<InvalidDataException>(() => { string a, b; Updater.ParseJob(Job(bad, good), out a, out b); });
            Throws<InvalidDataException>(() => { string a, b; Updater.ParseJob(Job("k.zip", "abc"), out a, out b); });
            Throws<InvalidDataException>(() => { string a, b; Updater.ParseJob(Common.Encode(new Dictionary<string, object> { { "file", "k.zip" }, { "sha256", good }, { "url", "http://evil" } }), out a, out b); });
            Check(AgentCore.ActionAllowed("self-update") && AgentCore.UsesPrompt("self-update"), "self-update must be an allowed prompt action");
        });
        test("self-update stages flat kits only and refuses nested paths or kits without the apply script", () => {
            string dir = Path.Combine(work, "upd-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
            Func<string[], string> mk = names => { string z = Path.Combine(dir, Guid.NewGuid().ToString("N") + ".zip"); using (var a = ZipFile.Open(z, ZipArchiveMode.Create)) foreach (var n in names) { var e = a.CreateEntry(n); using (var w = new StreamWriter(e.Open())) w.Write("rem " + n); } return z; };
            string staging = Path.Combine(dir, "staging");
            Check(Updater.StagingDir(dir) == "", "no pointer means nothing staged");
            Check(Updater.Stage(mk(new[] { "apply-update.cmd", "dbclone-agent-v1.exe" }), staging) == 2 && File.Exists(Path.Combine(staging, "dbclone-agent-v1.exe")), "flat kit not staged");
            Throws<InvalidDataException>(() => Updater.Stage(mk(new[] { "apply-update.cmd", "sub/evil.cmd" }), staging));
            Throws<InvalidDataException>(() => Updater.Stage(mk(new[] { "apply-update.cmd", "../evil.cmd" }), staging));
            Throws<InvalidDataException>(() => Updater.Stage(mk(new[] { "dbclone-agent-v1.exe" }), staging));
            Check(!File.Exists(Path.Combine(dir, "evil.cmd")) && !Directory.Exists(Path.Combine(staging, "sub")), "a rejected kit wrote outside or below staging");
        });
    }
}
