const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = __dirname;
const original = fs.readFileSync(path.join(root,'install-gemma.cmd'),'ascii');
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const testRoot = path.join(process.env.TEMP,'gemma-installer-test-'+Date.now());
const dest = path.join(testRoot,'local-ai');
const cache = path.join(testRoot,'cache');
fs.mkdirSync(cache,{recursive:true});
fs.copyFileSync(path.join(root,'llama-cpu.zip'),path.join(cache,'llama-cpu.zip'));
fs.copyFileSync(path.join(root,'probe-part001.bin'),path.join(cache,'part001.bin'));
const firstHash = manifest.chunks[0].sha256;
const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(cache,'part001.bin'))).digest('hex');
assert.equal(h,firstHash,'public download must decode to the original first chunk');
const fixture = original.replace('set "DEST=C:\\dbclone\\local-ai"',`set "DEST=${dest}"`)
  .replace('set "CACHE=C:\\dbclone\\gemma-download"',`set "CACHE=${cache}"`)
  .replaceAll(manifest.modelHash,firstHash)
  .replace(/echo \[Model \d+\/103\]\r?\ncall :part "part(?!001)\d+" "[a-f0-9]+" \|\| goto fail\r?\n/g,'')
  .replace(/copy \/b part001\.bin(?:\+part\d+\.bin)+ /,'copy /b part001.bin ');
const file=path.join(testRoot,'fixture.cmd');
fs.writeFileSync(file,fixture,'ascii');
for(let i=0;i<2;i++) {
  const r=cp.spawnSync('cmd.exe',['/d','/c',file],{encoding:'utf8',timeout:120000});
  fs.writeFileSync(path.join(root,`installer-fixture-${i+1}.log`),(r.stdout||'')+(r.stderr||''));
  assert.equal(r.status,0,`fixture run ${i+1}: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout,/INSTALL PASS/);
  assert.ok(fs.existsSync(path.join(dest,'start-gemma.cmd')));
  assert.ok(fs.existsSync(path.join(dest,manifest.modelName)), 'installed filename must match the launcher');
}
// Execute the actual hash routine against a mismatched digest: must return nonzero.
const check=original.slice(original.indexOf(':check\r\n'),original.indexOf(':part\r\n'));
const bad=path.join(testRoot,'bad-hash.cmd');
fs.writeFileSync(bad,`@echo off\r\ncall :check "${path.join(cache,'part001.bin')}" "${'0'.repeat(64)}"\r\nexit /b %errorlevel%\r\n${check}`,'ascii');
const result=cp.spawnSync('cmd.exe',['/d','/c',bad],{encoding:'utf8'});
assert.notEqual(result.status,0,'wrong hash must be rejected');
console.log('PASS: public part decode, one-part install, repeat install, bad hash rejection.');
console.log('Fixture directory: '+testRoot);
