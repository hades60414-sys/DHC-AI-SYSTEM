import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_DHC_CONFIG, parseDhcConfig, resolveWorkspaceRoot } from '@/modules/dhc/dhc-config.js';

test('a missing config gives the defaults: personal, Claude + Codex, no remote', () => {
  assert.deepEqual(parseDhcConfig(undefined), DEFAULT_DHC_CONFIG);
});

test('valid fields are taken as written', () => {
  const config = parseDhcConfig({ workspaceRoot: 'Work', mode: 'team', remote: { enabled: true }, agents: ['Claude', 'cursor', 'claude'], domain: 'finance' });
  assert.deepEqual(config, { workspaceRoot: 'Work', mode: 'team', remote: { enabled: true }, agents: ['claude', 'cursor'], domain: 'finance' });
});

test('a bad field falls back to its default and says why; the rest still apply', () => {
  const warnings: string[] = [];
  const config = parseDhcConfig({ mode: 'everyone', agents: [], remote: true, domain: 'Finance!', workspaceRoot: '  ' }, (m) => warnings.push(m));
  assert.deepEqual(config, DEFAULT_DHC_CONFIG);
  assert.equal(warnings.length, 5);
});

test('a relative workspace root sits in the home directory; an absolute one is kept', () => {
  assert.equal(resolveWorkspaceRoot({ ...DEFAULT_DHC_CONFIG }), path.join(os.homedir(), 'DHC Workspace'));
  const absolute = path.resolve('/srv/work');
  assert.equal(resolveWorkspaceRoot({ ...DEFAULT_DHC_CONFIG, workspaceRoot: absolute }), absolute);
});
