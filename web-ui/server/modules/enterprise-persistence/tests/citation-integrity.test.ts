import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractCitationIndices } from '../citation-integrity.js';

test('ASTRA-007 引用標記擷取：半形／全形、空白、去重排序；非數字與 5 位數以上不算', () => {
  assert.deepEqual(extractCitationIndices('甲 [2] 乙 [1][1] 丙［ 3 ］ 丁 [ 10 ]'), [1, 2, 3, 10]);
  assert.deepEqual(extractCitationIndices('無引用 [a] [] [12345] 【1】'), []);
  assert.deepEqual(extractCitationIndices('[999]'), [999]);
});
