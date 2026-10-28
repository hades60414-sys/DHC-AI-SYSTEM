import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import AgentConnectionsStep from '@/modules/onboarding/AgentConnectionsStep';
import { DEFAULT_DHC_CONFIG, filterEnabledAgents, setDhcConfig } from '@/shared/dhcConfig';
import TeamOnly from '@/shared/TeamOnly';
import type { ProviderAuthStatusMap } from '@/shared/types';

const STATUS = { authenticated: false, email: null, loading: false, error: null };
const STATUSES = { claude: STATUS, cursor: STATUS, codex: STATUS, opencode: STATUS } as unknown as ProviderAuthStatusMap;

afterEach(() => setDhcConfig(DEFAULT_DHC_CONFIG));

test('TeamOnly renders nothing in personal mode and its children in team mode', () => {
  setDhcConfig({ mode: 'personal' });
  const { container, rerender } = render(<TeamOnly><p>Co-Work</p></TeamOnly>);
  assert.equal(container.textContent, '');

  setDhcConfig({ mode: 'team' });
  rerender(<TeamOnly><p>Co-Work</p></TeamOnly>);
  assert.equal(container.textContent, 'Co-Work');
});

test('only the agents listed in dhc.config.json are offered (default: Claude Code and Codex)', () => {
  const { rerender } = render(<AgentConnectionsStep providerStatuses={STATUSES} onOpenProviderLogin={() => {}} />);
  assert.ok(screen.getByText('Claude Code'));
  assert.ok(screen.getByText('OpenAI Codex'));
  assert.equal(screen.queryByText('Cursor'), null);

  setDhcConfig({ agents: ['cursor'] });
  rerender(<AgentConnectionsStep providerStatuses={STATUSES} onOpenProviderLogin={() => {}} />);
  assert.ok(screen.getByText('Cursor'));
  assert.equal(screen.queryByText('Claude Code'), null);
});

test('an agents list that matches nothing shows every provider instead of none', () => {
  assert.deepEqual(filterEnabledAgents(['claude', 'codex'], (id) => id, ['claude']), ['claude']);
  assert.deepEqual(filterEnabledAgents(['claude', 'codex'], (id) => id, ['unknown']), ['claude', 'codex']);
});
