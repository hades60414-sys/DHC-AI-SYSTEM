import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React, { createRef } from 'react';
import { test, vi } from 'vitest';

import ConversationJumpRail from '@/modules/chat/transcript/ConversationJumpRail';

/** DHC CLI 對話跳轉: one dot per prompt; hover previews the prompt, click scrolls its row into view. */
test('dots preview and jump to their prompt rows', () => {
  const ref = createRef<HTMLDivElement>();
  render(
    <div>
      <div ref={ref}>
        <div data-jump-anchor="a">first</div>
        <div data-jump-anchor="b">second</div>
      </div>
      <ConversationJumpRail
        scrollContainerRef={ref}
        prompts={[
          { key: 'a', text: '超限發生後要在多久內通報？', timestamp: undefined },
          { key: 'b', text: '交易員什麼情況會被停權？', timestamp: undefined },
        ]}
      />
    </div>,
  );
  const scrollTo = vi.fn();
  ref.current!.scrollTo = scrollTo as unknown as HTMLDivElement["scrollTo"];

  const second = screen.getByRole('button', { name: /第 2 則提問/ });
  fireEvent.mouseEnter(second);
  assert.match(screen.getByRole('tooltip').textContent ?? '', /交易員什麼情況會被停權/);

  fireEvent.click(second);
  assert.equal(scrollTo.mock.calls.length, 1);
});

test('a single prompt shows no rail', () => {
  const ref = createRef<HTMLDivElement>();
  render(<ConversationJumpRail scrollContainerRef={ref} prompts={[{ key: 'a', text: 'x', timestamp: undefined }]} />);
  assert.equal(screen.queryByRole('navigation'), null);
});
