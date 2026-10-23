import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ClickTrendChart from './ClickTrendChart';

describe('ClickTrendChart', () => {
  it('shows an honest empty state when the API returns no activity', () => {
    render(<ClickTrendChart points={[]} label="Daily clicks" />);

    expect(screen.getByText('No recorded clicks yet.')).toBeInTheDocument();
    expect(screen.getByText('Share a short link to see activity here.')).toBeInTheDocument();
  });

  it('spaces points by calendar date and exposes per-day details', () => {
    const { container } = render(
      <ClickTrendChart
        label="Daily clicks"
        points={[
          { date: '2026-05-01', clicks: 2 },
          { date: '2026-05-02', clicks: 4 },
          { date: '2026-05-05', clicks: 3 },
        ]}
      />,
    );
    const points = [...container.querySelectorAll<SVGCircleElement>('.chart-point')];

    expect(points.map((point) => Number(point.getAttribute('cx')))).toEqual([42, 207, 702]);
    expect(points[1]?.getAttribute('aria-label')).toBe('2026-05-02: 4 clicks');
    expect(screen.getByText('Only dates with recorded clicks are plotted.')).toBeInTheDocument();
  });
});
