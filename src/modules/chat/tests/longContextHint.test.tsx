import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { describe, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

const HINT = '對話很長，換件事就開新對話更省';

describe('token chip', () => {
  it('no longer carries the long conversation hint (it moved to the handoff card)', () => {
    render(<TokenUsageSummary usage={{ used: 250_000, total: 1_000_000 }} />);
    assert.equal(screen.queryByText(HINT), null);
    screen.getByText('250K');
  });
});
