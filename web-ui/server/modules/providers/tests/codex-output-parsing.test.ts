import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanCodexShellOutput,
  parseCodexPatch,
  readCodexProposedPlan,
  unifiedDiffToTexts,
} from '@/modules/providers/list/codex/codex-sessions.provider.js';

// ---------------------------------------------------------------------------
// cleanCodexShellOutput
// ---------------------------------------------------------------------------

test('cleanCodexShellOutput strips both report layers and lifts the exit code', () => {
  const raw = [
    'Script completed in 0.4s',
    'Wall time: 0.4 seconds',
    'Output:',
    'Exit code: 2',
    'Wall time: 0.3 seconds',
    'Total output lines: 2',
    'Output:',
    'line one',
    'line two',
  ].join('\n');

  assert.deepEqual(cleanCodexShellOutput(raw), {
    output: 'line one\nline two',
    exitCode: 2,
    runningCellId: undefined,
    truncated: false,
  });
});

test('cleanCodexShellOutput reports a still-running cell without an exit code', () => {
  const result = cleanCodexShellOutput('Script running with cell ID abc123 (background)\npartial output');
  assert.deepEqual(result, {
    output: 'partial output',
    exitCode: undefined,
    runningCellId: 'abc123',
    truncated: false,
  });
});

test('cleanCodexShellOutput flags truncated output and still finds the exit code', () => {
  const raw = [
    'Script failed after 1s',
    'Output:',
    'Warning: truncated output (original 9000 lines)',
    'Total output lines: 9000',
    '',
    'Script error:',
    'Exit code: -1',
    'tail of output',
  ].join('\n');

  assert.deepEqual(cleanCodexShellOutput(raw), {
    output: 'tail of output',
    exitCode: -1,
    runningCellId: undefined,
    truncated: true,
  });
});

test('cleanCodexShellOutput passes plain text through unchanged', () => {
  assert.deepEqual(cleanCodexShellOutput('hello\nworld'), {
    output: 'hello\nworld',
    exitCode: undefined,
    runningCellId: undefined,
    truncated: false,
  });
});

// ---------------------------------------------------------------------------
// unifiedDiffToTexts
// ---------------------------------------------------------------------------

test('unifiedDiffToTexts rebuilds old and new sides from hunks', () => {
  const diff = [
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old line',
    '+new line',
    ' tail',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  assert.deepEqual(unifiedDiffToTexts(diff), {
    oldText: 'keep\nold line\ntail',
    newText: 'keep\nnew line\ntail',
  });
});

test('unifiedDiffToTexts treats unprefixed lines as context', () => {
  assert.deepEqual(unifiedDiffToTexts('context\n+added'), {
    oldText: 'context',
    newText: 'context\nadded',
  });
});

test('unifiedDiffToTexts returns empty sides for an empty diff', () => {
  assert.deepEqual(unifiedDiffToTexts(''), { oldText: '', newText: '' });
});

// ---------------------------------------------------------------------------
// parseCodexPatch
// ---------------------------------------------------------------------------

test('parseCodexPatch splits a patch into one change per file', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: src/new.ts',
    '+export const a = 1;',
    '*** Update File: src/existing.ts',
    '@@',
    ' import x from "x";',
    '-const old = 1;',
    '+const updated = 2;',
    '*** Move to: src/renamed.ts',
    '*** Delete File: src/gone.ts',
    '-whatever was here',
    '*** End Patch',
  ].join('\n');

  assert.deepEqual(parseCodexPatch(patch), [
    { filePath: 'src/new.ts', changeType: 'add', oldText: '', newText: 'export const a = 1;' },
    {
      filePath: 'src/existing.ts',
      changeType: 'update',
      oldText: 'import x from "x";\nconst old = 1;',
      newText: 'import x from "x";\nconst updated = 2;',
    },
    { filePath: 'src/gone.ts', changeType: 'delete', oldText: 'whatever was here', newText: '' },
  ]);
});

test('parseCodexPatch returns no changes when there is no file header', () => {
  assert.deepEqual(parseCodexPatch('*** Begin Patch\n*** End Patch'), []);
  assert.deepEqual(parseCodexPatch(''), []);
});

// ---------------------------------------------------------------------------
// readCodexProposedPlan
// ---------------------------------------------------------------------------

test('readCodexProposedPlan extracts the plan body from the envelope', () => {
  assert.equal(
    readCodexProposedPlan('<proposed_plan>\n1. Do this\n2. Then that\n</proposed_plan>\n'),
    '1. Do this\n2. Then that',
  );
});

test('readCodexProposedPlan accepts a streamed plan without its closing tag', () => {
  assert.equal(readCodexProposedPlan('  <PROPOSED_PLAN>\nStep one'), 'Step one');
});

test('readCodexProposedPlan returns null for ordinary text or an empty plan', () => {
  assert.equal(readCodexProposedPlan('Here is my plan: <proposed_plan>x</proposed_plan>'), null);
  assert.equal(readCodexProposedPlan('no plan at all'), null);
  assert.equal(readCodexProposedPlan('<proposed_plan>\n   \n</proposed_plan>'), null);
});
