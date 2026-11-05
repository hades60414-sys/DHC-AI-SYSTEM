import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OffloadSplit, splitSlices } from '../UsageMeters';

const week = {
  start: '2026-10-25T12:00:00Z',
  end: '2026-11-01T12:00:00Z',
  total: { in: 1000, cw: 7000, out: 2000 },
  offload: {
    Codex: { tokens: 0, calls: 0, models: {} },
    Gemini: { tokens: 6000, calls: 3, models: { agy: 6000 } },
    Other: { tokens: 4000, calls: 1, models: {} },
  },
};

describe('offload split meter', () => {
  it('counts Claude as fresh tokens and drops vendors with nothing this week', () => {
    const s = splitSlices(week);
    expect(s.map((x) => [x.name, x.tokens])).toEqual([['Claude', 10000], ['Gemini', 6000], ['Other', 4000]]);
  });

  it('shows the share carried by the other vendors', () => {
    render(<OffloadSplit week={week} />);
    expect(screen.getByText('其他模型分擔 50.0%')).toBeTruthy();
    expect(screen.getByText('Gemini 30.0%')).toBeTruthy();
  });

  it('renders nothing before data arrives', () => {
    const { container } = render(<OffloadSplit week={null} />);
    expect(container.innerHTML).toBe('');
  });
});
