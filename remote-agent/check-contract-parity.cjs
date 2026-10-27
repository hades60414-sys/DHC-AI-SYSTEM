'use strict';
// C# DocQa.Contract 與 Node tools\local_qa\lib\prompts.cjs CONTRACT 逐字比對（C# 字串常把中文寫成 \uXXXX）。
//   node check-contract-parity.cjs
const fs = require('fs'), path = require('path');
const cs = fs.readFileSync(path.join(__dirname, 'DocQa.cs'), 'utf8');
const node = require(path.join(__dirname, '..', '..', 'tools', 'local_qa', 'lib', 'prompts.cjs')).CONTRACT;
const start = cs.indexOf('const string Contract ='), end = cs.indexOf(';', start);
const literals = [...cs.slice(start, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
const decoded = literals.join('').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
if (decoded === node) { console.log('CONTRACT IDENTICAL (' + node.length + ' chars)'); process.exit(0); }
const lines = [decoded.split('\n'), node.split('\n')];
for (let i = 0; i < Math.max(lines[0].length, lines[1].length); i++) if (lines[0][i] !== lines[1][i]) console.log(`line ${i + 1}\n  C#  : ${lines[0][i]}\n  Node: ${lines[1][i]}`);
process.exit(1);
