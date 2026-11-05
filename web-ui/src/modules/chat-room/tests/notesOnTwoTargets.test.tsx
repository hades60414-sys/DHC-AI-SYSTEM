import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import { useNotesOn } from '@/shared/chatRoom';

/** 10/19: a session's notes and a board's notes read at once used to evict one shared cache and loop React (#185). */

function TwoTargets() {
  const onSession = useNotesOn('session', 's1');
  const onBoard = useNotesOn('board', 'b1');
  return <span>{onSession.length + onBoard.length}</span>;
}

test('session and board notes can be read in the same render', () => {
  const view = render(<TwoTargets />);
  assert.equal(view.container.textContent, '0');
});
