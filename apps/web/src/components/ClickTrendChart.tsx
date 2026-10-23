import type { ClickPoint } from '../api/links';

type Props = { points: ClickPoint[]; label: string };

export default function ClickTrendChart({ points, label }: Props) {
  if (points.length === 0) {
    return (
      <div className="chart-empty">
        <p>No recorded clicks yet.</p>
        <span>Share a short link to see activity here.</span>
      </div>
    );
  }

  const width = 720;
  const height = 230;
  const left = 42;
  const right = 18;
  const top = 18;
  const bottom = 40;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(1, ...points.map((point) => point.clicks));
  const scaleTop = Math.max(2, Math.ceil(maxValue / 2) * 2);
  const firstTimestamp = new Date(`${points[0]?.date}T00:00:00Z`).getTime();
  const lastTimestamp = new Date(`${points.at(-1)?.date}T00:00:00Z`).getTime();
  const coordinates = points.map((point) => {
    const timestamp = new Date(`${point.date}T00:00:00Z`).getTime();
    return {
      ...point,
      x:
        firstTimestamp === lastTimestamp
          ? left + plotWidth / 2
          : left + ((timestamp - firstTimestamp) / (lastTimestamp - firstTimestamp)) * plotWidth,
      y: top + plotHeight - (point.clicks / scaleTop) * plotHeight,
    };
  });
  const polyline = coordinates.map(({ x, y }) => `${x},${y}`).join(' ');
  const firstDate = new Date(`${points[0]?.date}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const lastDate = new Date(`${points.at(-1)?.date}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="chart-wrap">
      <svg
        className="trend-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}: ${points.reduce((sum, point) => sum + point.clicks, 0)} clicks across ${points.length} days with activity`}
      >
        <title>{label}</title>
        <desc>Daily click counts from stored redirect events. Gaps follow calendar dates.</desc>
        {[scaleTop, scaleTop / 2, 0].map((value) => {
          const y = top + ((scaleTop - value) / scaleTop) * plotHeight;
          return (
            <g key={value}>
              <line x1={left} x2={width - right} y1={y} y2={y} className="chart-gridline" />
              <text x={left - 10} y={y + 4} textAnchor="end" className="chart-axis-label">
                {value}
              </text>
            </g>
          );
        })}
        {points.length > 1 && <polyline points={polyline} className="chart-line" />}
        {coordinates.map((point) => (
          <circle
            key={point.date}
            cx={point.x}
            cy={point.y}
            r="4"
            className="chart-point"
            tabIndex={0}
            aria-label={`${point.date}: ${point.clicks} clicks`}
          >
            <title>{`${point.date}: ${point.clicks} clicks`}</title>
          </circle>
        ))}
        <text x={left} y={height - 10} className="chart-axis-label">
          {firstDate}
        </text>
        <text x={width - right} y={height - 10} textAnchor="end" className="chart-axis-label">
          {lastDate}
        </text>
      </svg>
      <p className="chart-note">Only dates with recorded clicks are plotted.</p>
    </div>
  );
}
