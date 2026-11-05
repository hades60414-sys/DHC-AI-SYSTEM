import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { createRef } from 'react';
import { cleanup, render } from '@testing-library/react';

import PermissionContext from '@/modules/chat/context/PermissionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import type { ChatMessage } from '@/shared/types';

/**
 * A conclusion is not always the last text of its turn: a background-task notification after it
 * gets its own short reply. Quiet view must still fold only short progress notes.
 *
 */

vi.mock('@/modules/chat/transcript/MessageComponent', () => ({
  default: ({ message }: { message: ChatMessage }) => (
    <div data-testid="row">{message.toolName || String(message.content)}</div>
  ),
}));
vi.mock('@/modules/chat/utils/transcriptViewMode', () => ({ useTranscriptQuiet: () => true }));
vi.mock('@/modules/chat/transcript/ConversationJumpRail', () => ({ default: () => null }));

const conclusion = '結論\n\n昨晚整理出 26 個工作流構想。';
const messages = [
  { type: 'user', content: 'prompt', timestamp: '2026-10-15T01:00:00.000Z' },
  { type: 'assistant', content: 'Found it, reading now.', timestamp: '2026-10-15T01:00:01.000Z' },
  { type: 'assistant', isToolUse: true, toolName: 'Bash', toolId: 't1', content: '', timestamp: '2026-10-15T01:00:02.000Z' },
  { type: 'assistant', content: conclusion, timestamp: '2026-10-15T01:00:03.000Z' },
  { type: 'assistant', isTaskNotification: true, content: 'agent done', timestamp: '2026-10-15T01:00:04.000Z' },
  { type: 'assistant', content: '背景任務也完成了。', timestamp: '2026-10-15T01:00:05.000Z' },
] as unknown as ChatMessage[];

describe('quiet view and a conclusion followed by a late reply', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('folds the progress note and tool, keeps the conclusion and the last reply', () => {
    const props = {
      scrollContainerRef: createRef<HTMLDivElement>(),
      chatMessages: messages,
      visibleMessages: messages,
      selectedSession: null,
      currentSessionId: 's1',
      provider: 'claude',
      selectedProject: { projectId: 'p1' },
    } as unknown as React.ComponentProps<typeof ChatMessagesPane>;
    const { getAllByTestId } = render(
      <PermissionContext.Provider value={{ pendingPermissionRequests: [], handlePermissionDecision: () => {} }}>
        <ChatMessagesPane {...props} />
      </PermissionContext.Provider>,
    );
    expect(getAllByTestId('row').map((row) => row.textContent)).toEqual(['prompt', conclusion, 'agent done', '背景任務也完成了。']);
  });
});
