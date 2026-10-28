import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { createRef } from 'react';
import { cleanup, render } from '@testing-library/react';

import PermissionContext from '@/modules/chat/context/PermissionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import type { ChatMessage, PendingPermissionRequest } from '@/shared/types';

/**
 * Quiet view (簡約檢視) folds every tool row of a turn. The plan card is a tool row too, and it is
 * the only place its Build / Revise buttons live, so a folded plan left the run waiting with nothing
 * on screen to answer.
 */

vi.mock('@/modules/chat/transcript/MessageComponent', () => ({
  default: ({ message }: { message: ChatMessage }) => (
    <div data-testid="row">{message.toolName || String(message.content)}</div>
  ),
}));
vi.mock('@/modules/chat/utils/transcriptViewMode', () => ({ useTranscriptQuiet: () => true }));
vi.mock('@/modules/chat/transcript/ChatExportMenu', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ConversationJumpRail', () => ({ default: () => null }));

const messages = [
  { type: 'user', content: 'prompt', timestamp: '2026-10-08T01:00:00.000Z' },
  { type: 'assistant', isToolUse: true, toolName: 'Read', toolId: 't1', content: '', timestamp: '2026-10-08T01:00:01.000Z' },
  { type: 'assistant', isToolUse: true, toolName: 'ExitPlanMode', toolId: 't2', content: '', timestamp: '2026-10-08T01:00:02.000Z' },
] as unknown as ChatMessage[];

const planRequest = { requestId: 'r1', toolName: 'ExitPlanMode', input: {} } as unknown as PendingPermissionRequest;

const renderPane = (pending: PendingPermissionRequest[]) => {
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
    <PermissionContext.Provider value={{ pendingPermissionRequests: pending, handlePermissionDecision: () => {} }}>
      <ChatMessagesPane {...props} />
    </PermissionContext.Provider>,
  );
  return getAllByTestId('row').map((row) => row.textContent);
};

describe('quiet view and a plan waiting for approval', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the plan card on screen while its Build / Revise answer is pending', () => {
    expect(renderPane([planRequest])).toEqual(['prompt', 'ExitPlanMode']);
  });

  it('folds the plan with the other tool rows once it has been answered', () => {
    expect(renderPane([])).toEqual(['prompt']);
  });
});
