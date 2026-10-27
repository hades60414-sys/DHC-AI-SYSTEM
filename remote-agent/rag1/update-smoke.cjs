// Drive ragent_self_update through the MCP server for a RAG1 deployment, then poll health until the version changes.
// Usage: node update-smoke.cjs <rag1|rag1r> <kit-file.zip> <sha256> [expected-version-substring]
const { spawn } = require("child_process"), path = require("path");
const [cfg, file, sha, expect] = process.argv.slice(2);
if (!sha) throw new Error("usage: node update-smoke.cjs <rag1|rag1r> <kit-file.zip> <sha256> [expected-version]");
const env = { ...process.env, RAGENT_AGENT: cfg, RAGENT_LABEL: "RAG1", RAGENT_MINOR: "1", RAGENT_UPDATE: "1", RAGENT_RETRIEVE: "1",
  RAGENT_CONTROLLER: path.join(__dirname, "Controller-RAG1.ps1"), RAGENT_CTL_ARGS: `-Config ${cfg} -ReleaseDir release-rag1d-${cfg}`, RAGENT_STATE_DIR: path.join(__dirname, "controller-state-" + cfg) };
const srv = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "ragent-mcp.cjs")], { stdio: ["pipe", "pipe", "pipe"], env });
let buf = "", id = 0; const waiting = new Map();
srv.stdout.setEncoding("utf8");
srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
srv.stderr.on("data", d => process.stderr.write(d));
const rpc = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const call = async (name, args = {}) => { const t = Date.now(); const m = await rpc("tools/call", { name, arguments: args }); const text = m.result ? m.result.content[0].text : JSON.stringify(m.error); console.log(`\n=== ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)\n${text}`); return text; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await rpc("initialize", {});
  await call("ragent_health", { wait_seconds: 60 });
  await call("ragent_self_update", { file, sha256: sha, wait_seconds: 180 });
  for (let i = 0; i < 12; i++) {
    await sleep(i === 0 ? Number(process.env.FIRST_WAIT_MS || 15000) : 15000);
    const t = await call("ragent_health", { wait_seconds: 45 });
    if (expect && t.includes(expect)) { console.log("\nVERSION CHANGED: " + expect); break; }
  }
  srv.stdin.end();
})().catch(e => { console.error(e); process.exit(1); });
