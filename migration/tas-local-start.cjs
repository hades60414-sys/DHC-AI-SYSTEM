// Writes D:\TAS\cc-web\start-cc-web-local.cmd: start-cc-web.cmd without the tunnel watchdog,
// so CloudCLI can be tested on srv-main (127.0.0.1:3001) while the public URL still points at srv-old.
const fs = require('fs');
const src = 'D:\\TAS\\cc-web\\start-cc-web.cmd';
const dst = 'D:\\TAS\\cc-web\\start-cc-web-local.cmd';
const lines = fs.readFileSync(src, 'latin1').split(/\r?\n/);
const out = lines.filter((l) => !/tunnel-watchdog/i.test(l));
if (out.length !== lines.length - 1) throw new Error(`expected to drop 1 watchdog line, dropped ${lines.length - out.length}`);
fs.writeFileSync(dst, out.join('\r\n'), 'latin1');
console.log('wrote ' + dst);
