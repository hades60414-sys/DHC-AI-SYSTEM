import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { setCoProjectNames, type CoSession } from '@/shared/coSessions';
import type { ChatMessage, DiffLine } from '@/shared/types';
import { setDhcConfig } from '@/shared/dhcConfig';

/**
 * DHC CLI Co-workspace in the transcript: a shared session's user message shows who sent it, taken from the
 * speaker mark at the start of its text, and the mark itself is not shown.
 */

const CO_SESSION: CoSession = { ownerProjectId: 'olive', members: ['amy'], sharedAt: '', title: '月報', provider: 'claude' };
const createDiff = (): DiffLine[] => [];
const userMessage = (content: string): ChatMessage => ({ type: 'user', content, timestamp: '2026-10-08T03:00:00.000Z' });

const renderBubble = (content: string, coSession: CoSession | null, prevMessage: ChatMessage | null = null) => render(
  <UiPreferencesProvider>
    <MessageComponent message={userMessage(content)} prevMessage={prevMessage} createDiff={createDiff} provider="claude" coSession={coSession} />
  </UiPreferencesProvider>,
);

setCoProjectNames([{ projectId: 'olive', displayName: 'Olive' }, { projectId: 'amy', displayName: 'Amy' }]);

// Co-Work is a team feature (dhc.config.json "mode": "team").
beforeEach(() => setDhcConfig({ mode: 'team' }));
afterEach(() => setDhcConfig({ mode: 'personal' }));

test('personal mode: no sender face beside a shared session message', () => {
  setDhcConfig({ mode: 'personal' });
  renderBubble('【Amy】幫我看這張表', CO_SESSION);

  assert.equal(screen.queryByRole('img', { name: 'Amy' }), null);
});

test('a marked message shows the sender and hides the mark', () => {
  const { container } = renderBubble('【Amy】幫我看這張表', CO_SESSION);

  assert.equal(container.querySelector('[data-co-sender]')?.textContent, 'Amy');
  assert.ok(screen.getByRole('img', { name: 'Amy' }));
  assert.match(container.textContent ?? '', /幫我看這張表/);
  assert.doesNotMatch(container.textContent ?? '', /【Amy】/);
});

test('an unmarked message in a shared session is the owner’s', () => {
  const { container } = renderBubble('分享前寫的', CO_SESSION);

  assert.equal(container.querySelector('[data-co-sender]')?.textContent, 'Olive');
});

test('the name is not repeated while the same person keeps talking, and returns when the speaker changes', () => {
  const same = renderBubble('【Amy】第二句', CO_SESSION, userMessage('【Amy】第一句'));
  assert.equal(same.container.querySelector('[data-co-sender]'), null);
  same.unmount();

  const changed = renderBubble('【Amy】換我', CO_SESSION, userMessage('【Olive】我先'));
  assert.equal(changed.container.querySelector('[data-co-sender]')?.textContent, 'Amy');
});

test('outside a shared session the text is shown as written', () => {
  const { container } = renderBubble('【Amy】幫我看這張表', null);

  assert.equal(container.querySelector('[data-co-sender]'), null);
  assert.match(container.textContent ?? '', /【Amy】幫我看這張表/);
});
