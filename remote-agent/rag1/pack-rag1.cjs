// Stage the RAG1 install kit: package\*.cmd + Setup-RAG1.ps1 + agent exe (base64), placeholders filled, CRLF.
// Usage: node pack-rag1.cjs [rag1|rag1r]   -> out-<config>\kit\ and out-<config>\rag1-rag-kit-<config>.zip
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
const cfgName = process.argv[2] || "rag1";
const relDir = process.argv[3] || `release-${cfgName}`;   // e.g. release-rag1d-rag1 for the D build
if (!["rag1", "rag1r", "pcmgr", "pcmain", "userD", "userF", "userB", "userC", "userE", "userA"].includes(cfgName)) throw new Error("config must be rag1, rag1r, pcmgr or pcmain");
const here = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(here, `config-${cfgName}`, "release.json"), "utf8"));
const exe = fs.readFileSync(path.join(here, relDir, "dbclone-agent-v1.exe"));
const exeSha = crypto.createHash("sha256").update(exe).digest("hex").toUpperCase();
const manifest = JSON.parse(fs.readFileSync(path.join(here, relDir, "manifest.json"), "utf8"));
if (manifest.exe_sha256 !== exeSha) throw new Error("release manifest does not match the exe; rebuild first");
const out = path.join(here, `out-${cfgName}`), kit = path.join(out, "kit");
fs.mkdirSync(kit, { recursive: true });
const crlf = s => s.replace(/\r?\n/g, "\r\n");
const fill = s => s.split("@@EXE_SHA@@").join(exeSha).split("@@TARGET@@").join(cfg.target);
const files = [];
for (const f of fs.readdirSync(path.join(here, "package"))) {
  const text = fill(fs.readFileSync(path.join(here, "package", f), "utf8"));
  if (/[^\x00-\x7F]/.test(text) && f.endsWith(".cmd")) throw new Error(f + " has non-ASCII characters");
  fs.writeFileSync(path.join(kit, f), crlf(text)); files.push(f);
}
fs.writeFileSync(path.join(kit, "Setup-RAG1.ps1"), crlf(fill(fs.readFileSync(path.join(here, "Setup-RAG1.ps1"), "utf8")))); files.push("Setup-RAG1.ps1");
for (const f of files) if (fs.readFileSync(path.join(kit, f), "utf8").includes("@@")) throw new Error("unfilled placeholder in " + f);
// The exe ships inside the zip (decoding a PE with certutil inside a batch file is killed by endpoint protection).
fs.writeFileSync(path.join(kit, "dbclone-agent-rag1.exe"), exe); files.push("dbclone-agent-rag1.exe");
const zip = path.join(out, `rag1-rag-kit-${cfgName}.zip`);
execFileSync(path.join(process.env.SystemRoot, "System32", "tar.exe"), ["-a", "-c", "-f", zip, "-C", kit, ...files]);
console.log(JSON.stringify({ config: cfgName, target: cfg.target, agent: cfg.agentId, exe_sha256: exeSha, files: files.length, zip, zip_sha256: crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex") }, null, 1));
