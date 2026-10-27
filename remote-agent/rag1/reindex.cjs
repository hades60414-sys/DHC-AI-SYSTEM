// Rebuild (replace) a RAG1 index through the controller: the MCP tool deliberately cannot replace an index.
// Usage: node reindex.cjs <index> <folder-on-RAG1> [歷史紀錄]   (third arg marks the whole index as past records, rag1j+)   e.g. node reindex.cjs rules "C:\Users\E0000000\Desktop\GPT\rag_docx"
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const [index, folder, status] = process.argv.slice(2);
if (!folder) throw new Error("usage: node reindex.cjs <index> <folder>");
const HERE = __dirname, ASSETS = path.join(os.homedir(), ".cloudcli", "assets");
const STATE = path.join(HERE, "controller-state-rag1", "controller-state.json");
const ctl = (...a) => execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "Controller-RAG1.ps1"), "-Config", "rag1", "-ReleaseDir", "release-rag1d-rag1", ...a], { encoding: "utf8" }).trim();
const state = () => JSON.parse(fs.readFileSync(STATE, "utf8").replace(/^\uFEFF/, ""));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  if (state().PendingJob) throw new Error("a job is still pending; collect it first");
  const prompt = path.join(HERE, "controller-state-rag1", "reindex-prompt.json");
  fs.writeFileSync(prompt, JSON.stringify({ index, folder, replace: true, ...(status ? { status } : {}) }));
  console.log(ctl("-Command", "submit", "-Action", "doc-index", "-PromptFile", prompt));
  const t0 = Date.now(); ctl("-Command", "publish-inbox");
  const seen = new Set();
  for (;;) {
    const reports = fs.readdirSync(ASSETS).filter(f => f.endsWith("-rag1-agent-report.cms.b64.txt")).map(f => ({ f, t: fs.statSync(path.join(ASSETS, f)).mtimeMs })).filter(x => x.t >= t0 - 60000 && !seen.has(x.f)).sort((a, b) => a.t - b.t);
    for (const r of reports) { seen.add(r.f); try { ctl("-Command", "receive", "-File", path.join(ASSETS, r.f)); } catch (e) {} }
    const s = state();
    if (!s.PendingJob) { console.log(`done after ${((Date.now() - t0) / 60000).toFixed(1)} min`); console.log(s.LastResult); break; }
    if (Date.now() - t0 > 50 * 60000) { console.log("still pending after 50 min"); break; }
    await sleep(15000);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
