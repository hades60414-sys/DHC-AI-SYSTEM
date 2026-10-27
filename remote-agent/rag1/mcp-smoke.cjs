// Drive ragent-mcp.cjs configured for a RAG1 deployment through status -> health -> doc_index -> doc_list -> doc_qa.
// Usage: node mcp-smoke.cjs <rag1|rag1r> <docs-folder> [index]
const { spawn } = require("child_process"), path = require("path");
const [cfg = "rag1r", folder, index = "smoke", question = "VaR 限額怎麼算？"] = process.argv.slice(2);
if (!folder) throw new Error("usage: node mcp-smoke.cjs <rag1|rag1r> <docs-folder> [index]");
const env = { ...process.env, RAGENT_AGENT: cfg, RAGENT_LABEL: "RAG1", RAGENT_MINOR: "1", RAGENT_CONTROLLER: path.join(__dirname, "Controller-RAG1.ps1"), RAGENT_CTL_ARGS: "-Config " + cfg, RAGENT_STATE_DIR: path.join(__dirname, "controller-state-" + cfg) };
const srv = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "ragent-mcp.cjs")], { stdio: ["pipe", "pipe", "pipe"], env });
let buf = "", id = 0; const waiting = new Map();
srv.stdout.setEncoding("utf8");
srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
srv.stderr.on("data", d => process.stderr.write(d));
const rpc = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const call = async (name, args = {}) => { const t = Date.now(); const m = await rpc("tools/call", { name, arguments: args }); console.log(`\n=== ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)${m.result && m.result.isError ? " ERROR" : ""}\n` + (m.result ? m.result.content[0].text : JSON.stringify(m.error))); return m; };
(async () => {
  await rpc("initialize", {});
  const list = await rpc("tools/list", {});
  console.log("tools:", list.result.tools.map(t => t.name).join(", "));
  console.log("label check:", list.result.tools.find(t => t.name === "ragent_doc_qa").description.slice(0, 40));
  await call("ragent_status");
  await call("ragent_health", { wait_seconds: 120 });
  await call("ragent_doc_index", { index, folder, wait_seconds: 600 });
  await call("ragent_doc_list", { wait_seconds: 120 });
  await call("ragent_doc_qa", { question, index, queries: [question], wait_seconds: 300 });
  srv.stdin.end();
})().catch(e => { console.error(e); process.exit(1); });
