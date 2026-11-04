import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import { toPosixPath } from '@/shared/image-attachments.js';

// ---------------------------------------------------------------------------
// parseFrontMatter
// ---------------------------------------------------------------------------

test('parseFrontMatter splits YAML front matter from the markdown body', () => {
  const parsed = parseFrontMatter('---\nname: deploy\ntags:\n  - ops\n---\n# Deploy\n');
  assert.deepEqual(parsed.data, { name: 'deploy', tags: ['ops'] });
  assert.equal(parsed.content, '# Deploy\n');
});

test('parseFrontMatter returns empty data when there is no front matter', () => {
  const parsed = parseFrontMatter('# Just a heading\n');
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.content, '# Just a heading\n');
});

test('parseFrontMatter never evaluates JS or JSON front matter', () => {
  for (const language of ['js', 'javascript', 'json']) {
    const parsed = parseFrontMatter(`---${language}\n{ "name": "should-not-parse" }\n---\nbody`);
    assert.deepEqual(parsed.data, {}, `${language} front matter must be ignored`);
    assert.equal(parsed.content, 'body');
  }
});

// ---------------------------------------------------------------------------
// toPosixPath
// ---------------------------------------------------------------------------

test('toPosixPath converts every backslash to a forward slash', () => {
  assert.equal(toPosixPath('C:\\Users\\me\\image.png'), 'C:/Users/me/image.png');
  assert.equal(toPosixPath('.\\assets\\a.png'), './assets/a.png');
});

test('toPosixPath leaves POSIX paths unchanged', () => {
  assert.equal(toPosixPath('/home/me/image.png'), '/home/me/image.png');
  assert.equal(toPosixPath(''), '');
});
