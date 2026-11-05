import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  moment: { choice: 'now', off: undefined as boolean | undefined } as { choice: string; off?: boolean },
  momentCalls: [] as unknown[],
  handoffCalls: [] as unknown[],
  handoff: { data: { newSessionId: 'new-1', handoffPath: 'C:\\h.md' } } as Record<string, unknown>,
}));

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      handoffMoment: (body: unknown) => {
        api.momentCalls.push(body);
        return Promise.resolve({ ok: true, status: 200, json: async () => api.moment });
      },
      handoffSession: (sessionId: string, body: unknown) => {
        api.handoffCalls.push({ sessionId, body });
        return Promise.resolve({ ok: true, status: 200, json: async () => api.handoff });
      },
    },
  },
}));

import HandoffPrompt from '@/modules/chat/composer/HandoffPrompt';
import { LONG_CONTEXT_TOKENS } from '@/modules/chat/composer/TokenUsageSummary';
import {
  HANDOFF_FORCE_TOKENS,
  HANDOFF_SNOOZE_STEP_TOKENS,
  isHandoffSnoozed,
  lastTurnTexts,
  readHandoffSnooze,
  shouldAskHandoffMoment,
  shouldShowHandoff,
  writeHandoffSnooze,
} from '@/modules/chat/utils/handoffPrompt';

const ask = (over: Partial<Parameters<typeof shouldAskHandoffMoment>[0]> = {}) => shouldAskHandoffMoment({
  used: LONG_CONTEXT_TOKENS,
  longTokens: LONG_CONTEXT_TOKENS,
  isProcessing: false,
  turnJustCompleted: true,
  snoozedAt: null,
  cardVisible: false,
  ...over,
});

describe('when to ask the judge', () => {
  it('asks only for a long, idle conversation whose turn just ended', () => {
    assert.equal(ask(), true);
    assert.equal(ask({ used: LONG_CONTEXT_TOKENS - 1 }), false);
    assert.equal(ask({ isProcessing: true }), false);
    assert.equal(ask({ turnJustCompleted: false }), false, 'merely opening an old long conversation');
    assert.equal(ask({ cardVisible: true }), false);
  });

  it('stays quiet until the conversation has grown another 50K after a snooze', () => {
    const at = 220_000;
    assert.equal(isHandoffSnoozed(at + HANDOFF_SNOOZE_STEP_TOKENS - 1, at), true);
    assert.equal(isHandoffSnoozed(at + HANDOFF_SNOOZE_STEP_TOKENS, at), false);
    assert.equal(ask({ used: 260_000, snoozedAt: at }), false);
    assert.equal(ask({ used: 270_000, snoozedAt: at }), true);
  });
});

describe('when to show the card', () => {
  it('shows for now, or past 280K whatever the judge said, and never when off', () => {
    assert.equal(shouldShowHandoff({ choice: 'now', off: false }, 210_000), true);
    assert.equal(shouldShowHandoff({ choice: 'later', off: false }, 210_000), false);
    assert.equal(shouldShowHandoff({ choice: 'later', off: false }, HANDOFF_FORCE_TOKENS), true);
    assert.equal(shouldShowHandoff({ choice: 'later', off: true }, 400_000), false);
    assert.equal(shouldShowHandoff({ choice: 'now', off: true }, 400_000), false);
  });
});

describe('the texts sent to the judge', () => {
  it('takes the last user message and the tail of the last assistant text, skipping tool rows', () => {
    const messages = [
      { type: 'user', content: '舊的問題' },
      { type: 'assistant', content: '舊的回答' },
      { type: 'user', content: '最後一句' },
      { type: 'assistant', content: '', isToolUse: true },
      { type: 'assistant', content: '開頭'.repeat(1000) + '收尾' },
    ];
    const { lastUser, lastAssistant } = lastTurnTexts(messages);
    assert.equal(lastUser, '最後一句');
    assert.equal(lastAssistant.length, 1500);
    assert.ok(lastAssistant.endsWith('收尾'));
    assert.deepEqual(lastTurnTexts([]), { lastUser: '', lastAssistant: '' });
  });
});

describe('snooze storage', () => {
  beforeEach(() => localStorage.clear());
  it('keeps the used count per session', () => {
    assert.equal(readHandoffSnooze('s1'), null);
    writeHandoffSnooze('s1', 231_234.6);
    assert.equal(readHandoffSnooze('s1'), 231_235);
    assert.equal(localStorage.getItem('dhc.handoffSnooze:s1'), '231235');
    assert.equal(readHandoffSnooze('s2'), null);
  });
});

describe('HandoffPrompt', () => {
  const messages = [{ type: 'user', content: '好' }, { type: 'assistant', content: '報表完成了。' }];
  const props = (over: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    used: 230_000,
    isProcessing: false,
    messages,
    getRunOptions: () => ({ permissionMode: 'plan' }),
    onOpenSession: vi.fn(),
    ...over,
  });

  beforeEach(() => {
    localStorage.clear();
    api.moment = { choice: 'now' };
    api.momentCalls.length = 0;
    api.handoffCalls.length = 0;
    api.handoff = { data: { newSessionId: 'new-1', handoffPath: 'C:\\h.md' } };
  });

  it('does not ask just because an old long conversation was opened', async () => {
    render(<HandoffPrompt {...props()} />);
    await act(async () => { await Promise.resolve(); });
    assert.equal(api.momentCalls.length, 0);
    assert.equal(screen.queryByText('開新對話接手'), null);
  });

  it('shows the card after a turn ends, then hands over and opens the new session', async () => {
    const p = props({ isProcessing: true });
    const view = render(<HandoffPrompt {...p} />);
    view.rerender(<HandoffPrompt {...p} isProcessing={false} />);
    await screen.findByText('開新對話接手');
    assert.deepEqual(api.momentCalls[0], { lastUser: '好', lastAssistant: '報表完成了。' });
    screen.getByText("剛好告一段落");
    screen.getByText(/對話 230K，開新對話接手/);

    fireEvent.click(screen.getByText('開新對話接手'));
    await screen.findByText(/交接中…舊對話正在寫交接/);
    await waitFor(() => assert.deepEqual(p.onOpenSession.mock.calls, [['new-1']]));
    assert.deepEqual(api.handoffCalls[0], { sessionId: 's1', body: { permissionMode: 'plan' } });
  });

  it('shows nothing when the answer is off, or later below 280K', async () => {
    for (const [moment, used] of [[{ choice: 'later', off: true }, 300_000], [{ choice: 'later' }, 250_000]] as const) {
      api.moment = moment;
      api.momentCalls.length = 0;
      const p = props({ isProcessing: true, used });
      const view = render(<HandoffPrompt {...p} />);
      view.rerender(<HandoffPrompt {...p} isProcessing={false} />);
      await waitFor(() => assert.equal(api.momentCalls.length, 1));
      await act(async () => { await Promise.resolve(); });
      assert.equal(screen.queryByText('開新對話接手'), null);
      view.unmount();
    }
  });

  it('snoozes: the card hides, the used count is stored, and it stays quiet for the next 50K', async () => {
    const p = props({ isProcessing: true });
    const view = render(<HandoffPrompt {...p} />);
    view.rerender(<HandoffPrompt {...p} isProcessing={false} />);
    fireEvent.click(await screen.findByText('暫緩'));
    assert.equal(screen.queryByText('開新對話接手'), null);
    assert.equal(localStorage.getItem('dhc.handoffSnooze:s1'), '230000');

    api.momentCalls.length = 0;
    view.rerender(<HandoffPrompt {...p} isProcessing />);
    view.rerender(<HandoffPrompt {...p} isProcessing={false} used={270_000} />);
    await act(async () => { await Promise.resolve(); });
    assert.equal(api.momentCalls.length, 0);
  });

  it('shows nothing for a long conversation before any stopping point (the always-on hint is gone)', () => {
    const view = render(<HandoffPrompt {...props({ used: 250_000 })} />);
    assert.equal(screen.queryByText(/換件事時開新對話/), null);
    assert.equal(view.container.textContent, '');
    assert.equal(api.momentCalls.length, 0);
  });

  it('puts a failed handoff in the card as text and keeps the button', async () => {
    api.handoff = { success: false, error: { message: '舊對話寫交接失敗：busy' } };
    const p = props({ isProcessing: true });
    const view = render(<HandoffPrompt {...p} />);
    view.rerender(<HandoffPrompt {...p} isProcessing={false} />);
    fireEvent.click(await screen.findByText('開新對話接手'));
    await screen.findByText('舊對話寫交接失敗：busy');
    screen.getByText('開新對話接手');
    assert.equal(p.onOpenSession.mock.calls.length, 0);
  });
});
