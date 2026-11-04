import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { ProviderSkillSource, SubagentActivity } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  buildDefaultProviderCurrentActiveModel,
  createApiSuccessResponse,
  flattenPromptForWindowsShell,
  normalizeProviderTimestamp,
  normalizeSessionName,
  parseIncomingJsonObject,
  readObjectRecord,
  readOptionalString,
  readProviderSkillMarkdownDefinitionFromContent,
  readStringArray,
  readStringRecord,
  sanitizeLeafDirectoryName,
  truncateSubagentActivity,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

// ---------------------------------------------------------------------------
// createApiSuccessResponse
// ---------------------------------------------------------------------------

test('createApiSuccessResponse wraps data in the success envelope', () => {
  assert.deepEqual(createApiSuccessResponse({ id: 1 }), { success: true, data: { id: 1 } });
  assert.deepEqual(createApiSuccessResponse(null), { success: true, data: null });
});

// ---------------------------------------------------------------------------
// readObjectRecord / readOptionalString / readStringArray / readStringRecord
// ---------------------------------------------------------------------------

test('readObjectRecord accepts plain objects and rejects everything else', () => {
  const record = { a: 1 };
  assert.equal(readObjectRecord(record), record);
  assert.equal(readObjectRecord(null), null);
  assert.equal(readObjectRecord(undefined), null);
  assert.equal(readObjectRecord([1, 2]), null);
  assert.equal(readObjectRecord('text'), null);
  assert.equal(readObjectRecord(42), null);
});

test('readOptionalString trims strings and maps blank or non-string input to undefined', () => {
  assert.equal(readOptionalString('  value  '), 'value');
  assert.equal(readOptionalString('   '), undefined);
  assert.equal(readOptionalString(''), undefined);
  assert.equal(readOptionalString(5), undefined);
  assert.equal(readOptionalString(null), undefined);
});

test('readStringArray keeps only string entries and ignores non-arrays', () => {
  assert.deepEqual(readStringArray(['a', 1, 'b', null, { c: 1 }]), ['a', 'b']);
  assert.deepEqual(readStringArray([]), []);
  assert.equal(readStringArray('a'), undefined);
  assert.equal(readStringArray({ 0: 'a' }), undefined);
});

test('readStringRecord keeps string values and returns undefined when none remain', () => {
  assert.deepEqual(readStringRecord({ a: 'x', b: 2, c: 'y' }), { a: 'x', c: 'y' });
  assert.equal(readStringRecord({ a: 1 }), undefined);
  assert.equal(readStringRecord({}), undefined);
  assert.equal(readStringRecord(['x']), undefined);
  assert.equal(readStringRecord(null), undefined);
});

// ---------------------------------------------------------------------------
// parseIncomingJsonObject
// ---------------------------------------------------------------------------

test('parseIncomingJsonObject parses every supported payload encoding', () => {
  const json = '{"type":"ping","n":1}';
  const expected = { type: 'ping', n: 1 };
  const buffer = Buffer.from(json, 'utf8');
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  assert.deepEqual(parseIncomingJsonObject(json), expected);
  assert.deepEqual(parseIncomingJsonObject(buffer), expected);
  assert.deepEqual(parseIncomingJsonObject(arrayBuffer), expected);
  assert.deepEqual(
    parseIncomingJsonObject([Buffer.from('{"type":'), new Uint8Array(Buffer.from('"ping","n":1}'))]),
    expected,
  );
});

test('parseIncomingJsonObject returns null for blank, invalid, or non-object payloads', () => {
  assert.equal(parseIncomingJsonObject(''), null);
  assert.equal(parseIncomingJsonObject('   '), null);
  assert.equal(parseIncomingJsonObject('{not json'), null);
  assert.equal(parseIncomingJsonObject('[1,2]'), null);
  assert.equal(parseIncomingJsonObject('"text"'), null);
  assert.equal(parseIncomingJsonObject('null'), null);
  assert.equal(parseIncomingJsonObject(42), null);
  assert.equal(parseIncomingJsonObject(['not a buffer']), null);
});

// ---------------------------------------------------------------------------
// buildDefaultProviderCurrentActiveModel
// ---------------------------------------------------------------------------

test('buildDefaultProviderCurrentActiveModel reports the catalog default', () => {
  assert.deepEqual(
    buildDefaultProviderCurrentActiveModel({ OPTIONS: [], DEFAULT: 'model-default' }),
    { model: 'model-default' },
  );
});

// ---------------------------------------------------------------------------
// addUniqueProviderSkillSource
// ---------------------------------------------------------------------------

test('addUniqueProviderSkillSource resolves roots and skips duplicates', () => {
  const sources: ProviderSkillSource[] = [];
  const seen = new Set<string>();
  const root = path.resolve('skills-root');

  addUniqueProviderSkillSource(sources, seen, { scope: 'project', rootDir: 'skills-root', commandPrefix: '/' });
  addUniqueProviderSkillSource(sources, seen, { scope: 'user', rootDir: `${root}${path.sep}.` });
  addUniqueProviderSkillSource(sources, seen, { scope: 'user', rootDir: 'other-root' });

  assert.deepEqual(sources, [
    { scope: 'project', rootDir: root, commandPrefix: '/' },
    { scope: 'user', rootDir: path.resolve('other-root') },
  ]);
  assert.deepEqual([...seen], [root, path.resolve('other-root')]);
});

// ---------------------------------------------------------------------------
// readProviderSkillMarkdownDefinitionFromContent
// ---------------------------------------------------------------------------

test('readProviderSkillMarkdownDefinitionFromContent reads name and description from front matter', () => {
  const content = '---\nname: "  review  "\ndescription: Checks a diff\n---\n# Body\n';
  assert.deepEqual(readProviderSkillMarkdownDefinitionFromContent(content, 'fallback'), {
    name: 'review',
    description: 'Checks a diff',
  });
});

test('readProviderSkillMarkdownDefinitionFromContent falls back when fields are missing or blank', () => {
  assert.deepEqual(readProviderSkillMarkdownDefinitionFromContent('# No front matter', 'folder-name'), {
    name: 'folder-name',
    description: '',
  });
  assert.deepEqual(readProviderSkillMarkdownDefinitionFromContent('---\nname: "   "\n---\n', 'folder-name'), {
    name: 'folder-name',
    description: '',
  });
});

// ---------------------------------------------------------------------------
// normalizeSessionName
// ---------------------------------------------------------------------------

test('normalizeSessionName collapses whitespace and trims', () => {
  assert.equal(normalizeSessionName('  Fix \n\t the   bug  ', 'Untitled'), 'Fix the bug');
});

test('normalizeSessionName returns the fallback for empty input', () => {
  assert.equal(normalizeSessionName(undefined, 'Untitled'), 'Untitled');
  assert.equal(normalizeSessionName('', 'Untitled'), 'Untitled');
  assert.equal(normalizeSessionName(' \n ', 'Untitled'), 'Untitled');
});

test('normalizeSessionName caps the title at 120 characters', () => {
  const result = normalizeSessionName('x'.repeat(500), 'Untitled');
  assert.equal(result.length, 120);
  assert.equal(result, 'x'.repeat(120));
});

// ---------------------------------------------------------------------------
// normalizeProviderTimestamp
// ---------------------------------------------------------------------------

test('normalizeProviderTimestamp treats small numbers as seconds and large ones as milliseconds', () => {
  const expected = '2023-11-14T22:13:20.000Z';
  assert.equal(normalizeProviderTimestamp(1_700_000_000), expected);
  assert.equal(normalizeProviderTimestamp(1_700_000_000_000), expected);
});

test('normalizeProviderTimestamp accepts numeric strings and date strings', () => {
  assert.equal(normalizeProviderTimestamp('1700000000'), '2023-11-14T22:13:20.000Z');
  assert.equal(normalizeProviderTimestamp('2024-01-02T03:04:05Z'), '2024-01-02T03:04:05.000Z');
});

test('normalizeProviderTimestamp falls back to the current time for unusable input', () => {
  for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '', '   ', 'not a date', null, undefined, {}]) {
    const before = Date.now();
    const result = normalizeProviderTimestamp(value);
    const after = Date.now();
    const parsed = Date.parse(result);
    assert.ok(parsed >= before && parsed <= after, `fallback for ${String(value)} should be "now"`);
  }
});

// ---------------------------------------------------------------------------
// sanitizeLeafDirectoryName
// ---------------------------------------------------------------------------

test('sanitizeLeafDirectoryName returns the trimmed name for a safe leaf', () => {
  assert.equal(sanitizeLeafDirectoryName('  session-123  '), 'session-123');
  assert.equal(sanitizeLeafDirectoryName('a.b_c'), 'a.b_c');
});

test('sanitizeLeafDirectoryName requires a non-blank name and uses the label', () => {
  assert.throws(() => sanitizeLeafDirectoryName(''), { message: 'directory name is required.' });
  assert.throws(() => sanitizeLeafDirectoryName('   ', 'session id'), { message: 'session id is required.' });
});

test('sanitizeLeafDirectoryName rejects traversal and nested paths', () => {
  for (const name of ['..', '../etc', 'a..b', 'a/b', 'a\\b', '/abs']) {
    assert.throws(
      () => sanitizeLeafDirectoryName(name, 'session id'),
      { message: `Invalid session id "${name}".` },
      `"${name}" should be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// truncateSubagentActivity
// ---------------------------------------------------------------------------

test('truncateSubagentActivity returns the same object when nothing is too long and there is no tool result', () => {
  const activity: SubagentActivity = { kind: 'text', content: 'short' };
  assert.equal(truncateSubagentActivity(activity), activity);

  const withNullResult: SubagentActivity = { kind: 'tool', toolName: 'Read', toolResult: null };
  assert.equal(truncateSubagentActivity(withNullResult), withNullResult);
});

test('truncateSubagentActivity keeps short tool results unchanged in value', () => {
  const activity: SubagentActivity = { kind: 'tool', content: 'short', toolResult: { content: 'ok', isError: false } };
  assert.deepEqual(truncateSubagentActivity(activity), activity);
});

test('truncateSubagentActivity caps content and tool result output at 4000 characters', () => {
  const activity: SubagentActivity = {
    kind: 'tool',
    toolName: 'Bash',
    content: 'a'.repeat(4005),
    toolResult: { content: 'b'.repeat(4010), isError: true },
  };

  const result = truncateSubagentActivity(activity);

  assert.notEqual(result, activity);
  assert.equal(result.content, `${'a'.repeat(4000)}\n… 5 more characters`);
  assert.deepEqual(result.toolResult, { content: `${'b'.repeat(4000)}\n… 10 more characters`, isError: true });
  assert.equal(result.toolName, 'Bash');
  // The input is not mutated.
  assert.equal(activity.content?.length, 4005);
});

test('truncateSubagentActivity keeps exactly-4000-character content untouched', () => {
  const activity: SubagentActivity = { kind: 'text', content: 'c'.repeat(4000) };
  assert.equal(truncateSubagentActivity(activity), activity);
});

// ---------------------------------------------------------------------------
// unwrapJsonStringLiteral
// ---------------------------------------------------------------------------

test('unwrapJsonStringLiteral decodes fully quoted JSON string literals', () => {
  assert.equal(unwrapJsonStringLiteral('"hello"'), 'hello');
  assert.equal(unwrapJsonStringLiteral('  "line\\nbreak"  '), 'line\nbreak');
  assert.equal(unwrapJsonStringLiteral('"\\u4f60\\u597d"'), '你好');
});

test('unwrapJsonStringLiteral leaves ordinary text untouched', () => {
  for (const value of ['plain', '"unterminated', 'trailing"', '"a" and "b"', '']) {
    assert.equal(unwrapJsonStringLiteral(value), value);
  }
});

// ---------------------------------------------------------------------------
// flattenPromptForWindowsShell
// ---------------------------------------------------------------------------

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  }
}

test('flattenPromptForWindowsShell is a no-op off Windows', () => {
  const prompt = 'line one\nline two\r\n';
  assert.equal(withPlatform('linux', () => flattenPromptForWindowsShell(prompt)), prompt);
  assert.equal(withPlatform('darwin', () => flattenPromptForWindowsShell(prompt)), prompt);
});

test('flattenPromptForWindowsShell collapses newline runs to single spaces on Windows', () => {
  const result = withPlatform('win32', () =>
    flattenPromptForWindowsShell('  first line  \n\n   second line\r\nthird\n'));
  assert.equal(result, 'first line second line third');
});

test('flattenPromptForWindowsShell passes non-string input through on Windows', () => {
  const value = 123 as unknown as string;
  assert.equal(withPlatform('win32', () => flattenPromptForWindowsShell(value)), value);
});
