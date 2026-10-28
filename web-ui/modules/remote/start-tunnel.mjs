#!/usr/bin/env node
// Starts a Cloudflare quick tunnel to the local DHC CLI server and prints its public URL.
// Needs `cloudflared` on PATH (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
//
// Usage: node modules/remote/start-tunnel.mjs [port]      (default port: SERVER_PORT or 3001)
//
// A quick tunnel gets a new random URL every time it starts and has no login of its own:
// put the Worker gate (worker/gate.mjs) in front of it and point TUNNEL_ORIGIN at the URL printed here.

import { spawn } from 'node:child_process';

const port = Number(process.argv[2] || process.env.SERVER_PORT || 3001);
if (!Number.isInteger(port) || port <= 0) {
  console.error('Usage: node modules/remote/start-tunnel.mjs [port]');
  process.exit(2);
}

const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });

child.on('error', (error) => {
  console.error(`Could not start cloudflared (${error.message}). Install it first; see modules/remote/README.md.`);
  process.exit(1);
});

let announced = false;
const watch = (chunk) => {
  // The quick-tunnel URL cloudflared prints: https://<random-words>.<quick-tunnel domain>.com
  const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.[a-z]*cloudflare\.com/);
  if (match && !announced) {
    announced = true;
    console.log(`\nTunnel URL: ${match[0]}`);
    console.log('Point the gate at it:  npx wrangler secret put TUNNEL_ORIGIN   (paste the URL above)');
    console.log('Do not share this URL directly — it has no login. Share the Worker gate URL instead.\n');
  }
};
child.stdout.on('data', watch);
child.stderr.on('data', watch);

const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
