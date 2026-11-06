import assert from 'node:assert/strict';
import test from 'node:test';

import { DUMMY_PASSWORD_HASH, hashEnterprisePassword, requirePasswordPolicy, verifyEnterprisePassword } from '../enterprise-password.js';

test('scrypt 雜湊可驗證、每次 salt 不同、錯誤密碼與壞格式回 false', async () => {
  const password = 'Synthetic-only-Passw0rd!';
  const first = await hashEnterprisePassword(password);
  const second = await hashEnterprisePassword(password);
  assert.match(first, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert.equal(await verifyEnterprisePassword(password, first), true);
  assert.equal(await verifyEnterprisePassword(password + 'x', first), false);
  for (const stored of ['', 'plain', 'scrypt$1$1$1$a$b', first.replace('$32768$', '$1024$'), DUMMY_PASSWORD_HASH]) {
    assert.equal(await verifyEnterprisePassword(password, stored), false);
  }
});

test('密碼政策：12–256 字元、不可全空白', () => {
  for (const bad of ['short', ' '.repeat(20), 'x'.repeat(257), 123 as unknown as string]) assert.throws(() => requirePasswordPolicy(bad), /ENTERPRISE_WEAK_PASSWORD/);
  assert.equal(requirePasswordPolicy('long-enough-pass'), 'long-enough-pass');
});
