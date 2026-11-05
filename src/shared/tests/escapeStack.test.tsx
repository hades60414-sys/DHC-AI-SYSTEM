import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React, { useState } from 'react';
import { test } from 'vitest';

import { useEscapeClose } from '@/shared/escapeStack';

function Layer({ name, log, children }: { name: string; log: string[]; children?: React.ReactNode }) {
  useEscapeClose(() => log.push(name));
  return <>{children}</>;
}

test('10/18: Esc closes only the topmost layer, and not while an input method is composing', () => {
  const log: string[] = [];
  render(<Layer name="library" log={log}><Layer name="tool" log={log} /></Layer>);
  fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
  assert.deepEqual(log, [], 'composing Esc is left to the IME');
  fireEvent.keyDown(window, { key: 'Escape' });
  assert.deepEqual(log, ['tool'], 'only the layer opened last');
});

test('10/18: the layer under becomes topmost when the upper one closes', () => {
  const log: string[] = [];
  function App() {
    const [open, setOpen] = useState(true);
    return <Layer name="library" log={log}>{open && <Layer name="tool" log={log} />}<button onClick={() => setOpen(false)}>x</button></Layer>;
  }
  const view = render(<App />);
  fireEvent.click(view.getByText('x'));
  fireEvent.keyDown(window, { key: 'Escape' });
  assert.deepEqual(log, ['library']);
});
