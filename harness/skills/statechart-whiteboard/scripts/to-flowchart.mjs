#!/usr/bin/env node
// statechart 的 stateDiagram-v2 輸出 → Mermaid flowchart，讓 DHC 規劃白板「匯入」變成可編輯的方框與箭頭（狀態圖只會變一張圖片）。
// 用法：node to-flowchart.mjs <chart.mmd> [--out <file.mmd>] [--lr]
// 保留：標題、狀態標籤（含 <br/>）、步驟標籤與編號、classDef 顏色、圖例。起點畫成小圓。
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
if (!input) {
	console.error("用法：node to-flowchart.mjs <chart.mmd> [--out <file.mmd>] [--lr]");
	process.exit(2);
}
const outAt = args.indexOf("--out");
const output = outAt >= 0 ? args[outAt + 1] : input.replace(/\.mmd$/, "") + ".board.mmd";
const direction = args.includes("--lr") ? "LR" : "TD";

const text = fs.readFileSync(input, "utf8");
const title = /^title:\s*"?(.*?)"?\s*$/m.exec(text)?.[1] ?? path.basename(input, ".mmd");
// The board import shows <br/> as text, so line breaks go (the canvas wraps the box text itself);
// statechart's English step words become Chinese.
const plain = (s) => s
	.replace(/<br\s*\/?>/g, "")
	.replace(/\bafter ([\d.]+) s, /g, "$1 秒後，")
	.replace(/\bwith the fix, /g, "修正後，")
	.replace(/ or /g, " 或 ");
const quote = (s) => `"${plain(s).replace(/"/g, "#quot;")}"`;

const classDefs = [];
const legend = [];
const nodes = [];
const edges = [];
const classes = [];
let inLegend = false;
let starts = 0;

for (const raw of text.split(/\r?\n/)) {
	const line = raw.trim();
	let m;
	if (/^state ".*" as legend \{$/.test(line)) { inLegend = true; continue; }
	if (inLegend && line === "}") { inLegend = false; continue; }
	if (line.startsWith("classDef ")) { classDefs.push(line); continue; }
	if ((m = /^state "(.*)" as (\S+)$/.exec(line))) {
		(inLegend ? legend : nodes).push(`${m[2]}[${quote(inLegend ? `圖例：${m[1]}` : m[1])}]`);
		continue;
	}
	if ((m = /^class (\S+) (\S+)$/.exec(line))) { classes.push(`class ${m[1]} ${m[2]}`); continue; }
	if ((m = /^(\[\*\]|\S+) --> (\S+)(?: : (.*))?$/.exec(line))) {
		let from = m[1];
		if (from === "[*]") {
			from = `start${starts++}`;
			nodes.push(`${from}(("開始"))`);
		}
		edges.push(m[3] ? `${from} -->|${quote(m[3])}| ${m[2]}` : `${from} --> ${m[2]}`);
	}
}

if (nodes.length === 0) {
	console.error(`${input}：找不到 state 行，這不是 statechart 的輸出嗎？`);
	process.exit(1);
}

const out = [
	"---",
	`title: ${quote(title)}`,
	"---",
	`flowchart ${direction}`,
	...classDefs.map((l) => `  ${l}`),
	// The board's Mermaid import (mermaid-to-excalidraw) fails on subgraphs and falls back to a broken image.
	...legend.map((l) => `  ${l}`),
	...nodes.map((l) => `  ${l}`),
	...edges.map((l) => `  ${l}`),
	...classes.map((l) => `  ${l}`),
	"",
].join("\n");
fs.writeFileSync(output, out);
console.log(`${output}：${nodes.length} 個方框、${edges.length} 條箭頭、圖例 ${legend.length} 項`);
