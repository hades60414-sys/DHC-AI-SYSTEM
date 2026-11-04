import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from '@/modules/plugins/plugin-registry.service.js';

const validManifest = () => ({
  name: 'my-plugin_1',
  displayName: 'My Plugin',
  entry: 'dist/index.js',
});

test('validateManifest accepts a minimal manifest', () => {
  assert.deepEqual(validateManifest(validManifest()), { valid: true });
});

test('validateManifest accepts every optional field when well formed', () => {
  assert.deepEqual(
    validateManifest({
      ...validManifest(),
      type: 'module',
      slot: 'tab',
      server: 'server/index.js',
      permissions: ['fs:read', 'net'],
    }),
    { valid: true },
  );
  assert.deepEqual(validateManifest({ ...validManifest(), server: null }), { valid: true });
});

test('validateManifest rejects non-object input', () => {
  for (const manifest of [null, undefined, 'manifest', 42]) {
    assert.deepEqual(validateManifest(manifest), { valid: false, error: 'Manifest must be a JSON object' });
  }
});

test('validateManifest requires name, displayName and entry as non-empty strings', () => {
  for (const field of ['name', 'displayName', 'entry']) {
    for (const value of [undefined, '', 7]) {
      const manifest: Record<string, unknown> = { ...validManifest(), [field]: value };
      assert.deepEqual(
        validateManifest(manifest),
        { valid: false, error: `Missing or invalid required field: ${field}` },
        `${field}=${String(value)}`,
      );
    }
  }
});

test('validateManifest only allows safe plugin names', () => {
  for (const name of ['../evil', 'has space', 'dot.name', '名稱']) {
    assert.deepEqual(validateManifest({ ...validManifest(), name }), {
      valid: false,
      error: 'Plugin name must only contain letters, numbers, hyphens, and underscores',
    });
  }
});

test('validateManifest rejects unknown types and slots', () => {
  assert.deepEqual(validateManifest({ ...validManifest(), type: 'iframe' }), {
    valid: false,
    error: 'Invalid plugin type: iframe. Must be one of: react, module',
  });
  assert.deepEqual(validateManifest({ ...validManifest(), slot: 'sidebar' }), {
    valid: false,
    error: 'Invalid plugin slot: sidebar. Must be one of: tab',
  });
});

test('validateManifest rejects traversal or absolute entry and server paths', () => {
  for (const entry of ['../outside.js', 'dist/../../x.js', '/abs/index.js']) {
    assert.deepEqual(validateManifest({ ...validManifest(), entry }), {
      valid: false,
      error: 'Entry must be a relative path without ".."',
    });
  }
  for (const server of ['../server.js', '/abs/server.js', 42]) {
    assert.deepEqual(validateManifest({ ...validManifest(), server }), {
      valid: false,
      error: 'Server entry must be a relative path string without ".."',
    });
  }
});

test('validateManifest requires permissions to be an array of strings', () => {
  for (const permissions of ['fs:read', ['fs:read', 1], { 0: 'fs:read' }]) {
    assert.deepEqual(validateManifest({ ...validManifest(), permissions }), {
      valid: false,
      error: 'Permissions must be an array of strings',
    });
  }
});
