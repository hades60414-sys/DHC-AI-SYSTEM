import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyMissing } from '@/modules/dhc/workspace-init.js';

test('the template fills in missing files and never overwrites the user\'s own', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dhc-ws-'));
  try {
    const template = path.join(base, 'template');
    const workspace = path.join(base, 'workspace');
    await mkdir(path.join(template, '例行工作'), { recursive: true });
    await writeFile(path.join(template, '例行工作', 'CLAUDE.md'), 'template rules');
    await writeFile(path.join(template, 'README.md'), 'template readme');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'README.md'), 'my own readme');

    assert.equal(await copyMissing(template, workspace), 1);
    assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), 'my own readme');
    assert.equal(await readFile(path.join(workspace, '例行工作', 'CLAUDE.md'), 'utf8'), 'template rules');
    assert.equal(await copyMissing(template, workspace), 0, 'running it again changes nothing');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
