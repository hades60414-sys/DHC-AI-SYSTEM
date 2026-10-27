// D rehearsal: ragent_doc_retrieve through the real encrypted channel against the rehearsal agent (rag1r + D release).
// Usage: node d-smoke.cjs <index> <question> [query]
const { spawn } = require("child_process"), path = require("path");
const [index, question, query] = process.argv.slice(2);
const env = { ...process.env, RAGENT_AGENT: "rag1r", RAGENT_LABEL: "RAG1", RAGENT_MINOR: "1", RAGENT_RETRIEVE: "1", RAGENT_CONTROLLER: path.join(__dirname, "Controller-RAG1.ps1"),
  RAGENT_CTL_ARGS: "-Config rag1r -ReleaseDir release-rag1d-rag1r", RAGENT_STATE_DIR: path.join(__dirname, "controller-state-rag1r") };
const srv = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "ragent-mcp.cjs")], { stdio: ["pipe", "pipe", "pipe"], env });
let buf = "", id = 0; const waiting = new Map();
srv.stdout.setEncoding("utf8");
srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
srv.stderr.on("data", d => process.stderr.write(d));
const rpc = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
(async () => {
  await rpc("initialize", {});
  const tools = (await rpc("tools/list", {})).result.tools.map(t => t.name);
  console.log("has ragent_doc_retrieve:", tools.includes("ragent_doc_retrieve"));
  const t = Date.now();
  const m = await rpc("tools/call", { name: "ragent_doc_retrieve", arguments: { question, index, ...(query ? { queries: [query] } : {}), wait_seconds: 300 } });
  console.log(`=== ${((Date.now() - t) / 1000).toFixed(1)}s${m.result.isError ? " ERROR" : ""}\n` + m.result.content[0].text);
  srv.stdin.end();
})().catch(e => { console.error(e); process.exit(1); });
