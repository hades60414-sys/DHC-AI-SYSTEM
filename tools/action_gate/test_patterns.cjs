'use strict';
// 設定檔裡兩條正規表示式的小測試（避免命令列跳脫字元出錯）。node test_patterns.cjs
const c = require('./config.json'), assert = require('assert');
const prod = new RegExp(c.production_path_pattern, 'i'), secret = new RegExp(c.secret_pattern, 'i');
const cases = [
  [prod, String.raw`\\WEB01\wwwroot\trader\DeskPL.php`, true],
  [prod, String.raw`C:\inetpub\wwwroot\DeskPL.php`, true],
  [prod, String.raw`D:\DHC\intranet-kb\inbox\dhc-probe-web01.zip`, false],
  [prod, String.raw`D:\DHC\out\a.csv`, false],
  [secret, String.raw`D:\DHC\.env`, true],
  [secret, String.raw`whoami & type D:\DHC\.env`, true],
  [secret, String.raw`D:\DHC\environment.txt`, false],
  [secret, String.raw`D:\DHC\out\factset_20260928.csv`, false],
];
for (const [re, s, want] of cases) assert.strictEqual(re.test(s), want, `${re} on ${s}`);
console.log('patterns ok', cases.length);
