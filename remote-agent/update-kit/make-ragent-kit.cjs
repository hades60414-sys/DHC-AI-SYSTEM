// Build a srv-db self-update kit (v3.4, 2026-10-02): compile the current sources with a given AgentVersion (same compiler
// arguments and embedded srv-db deployment files as Build-V34.ps1; Channel.cs is restored afterwards), then zip
// apply-update.cmd (CRLF) + dbclone-agent-v1.exe flat. --publish copies the zip into the CloudCLI assets folder.
// Usage: node make-ragent-kit.cjs <version, e.g. v3.4b-20261002> <kit-name.zip> [--publish]
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { execFileSync } = require('child_process');
const [version, kitName] = process.argv.slice(2), publish = process.argv.includes('--publish');
if (!/^v3\.\d+[a-z]?-\d{8}$/.test(version || '') || !/^[A-Za-z0-9._-]{1,120}\.zip$/.test(kitName || '')) throw new Error('usage: node make-ragent-kit.cjs <v3.Nx-yyyymmdd> <kit-name.zip> [--publish]');
const AC = path.resolve(__dirname, '..'), REL1 = path.join(AC, 'release'), RECIPIENT = path.join(AC, '..', 'resume-probe', 'recipient.cer');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const out = path.join(__dirname, 'out', version), kit = path.join(out, 'kit');
fs.mkdirSync(kit, { recursive: true });
const exe = path.join(kit, 'dbclone-agent-v1.exe'), channel = path.join(AC, 'Channel.cs'), orig = fs.readFileSync(channel, 'utf8');
const m = /AgentVersion = "([^"]+)"/.exec(orig); if (!m) throw new Error('AgentVersion not found');
try {
  fs.writeFileSync(channel, orig.replace(m[0], `AgentVersion = "${version}"`));
  execFileSync(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', '/target:exe', '/optimize+',
    '/r:System.Security.dll', '/r:System.Web.Extensions.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll', '/r:System.Data.dll', '/r:Microsoft.CSharp.dll',
    '/out:' + exe, `/resource:${path.join(REL1, 'release.json')},release.json`, `/resource:${path.join(REL1, 'outer-signer.cer')},outer-signer.cer`, `/resource:${RECIPIENT},recipient.cer`,
    ...['Channel.cs', 'DocQa.cs', 'Grounding.cs', 'FixtureActions.cs', 'SqlActions.cs', 'HostActions.cs', 'SandboxActions.cs', 'Updater.cs', 'CmdActions.cs'].map(f => path.join(AC, f))], { stdio: 'inherit' });
} finally { fs.writeFileSync(channel, orig); }
const apply = fs.readFileSync(path.join(__dirname, 'apply-update.cmd'), 'utf8');
if (/[^\x00-\x7f]/.test(apply)) throw new Error('apply-update.cmd has non-ASCII characters');
fs.writeFileSync(path.join(kit, 'apply-update.cmd'), apply.replace(/\r?\n/g, '\r\n'));
const zip = path.join(out, kitName);
try { fs.unlinkSync(zip); } catch { }
execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', kit, 'apply-update.cmd', 'dbclone-agent-v1.exe']);
const zipSha = sha(fs.readFileSync(zip));
if (publish) {
  const dest = path.join(os.homedir(), '.cloudcli', 'assets', kitName);
  fs.copyFileSync(zip, dest + '.tmp'); fs.renameSync(dest + '.tmp', dest);
}
console.log(JSON.stringify({ version, kit: kitName, zip, zip_sha256: zipSha, exe_sha256: sha(fs.readFileSync(exe)), published: publish }, null, 1));
