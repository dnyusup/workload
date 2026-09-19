import type { ReactNode } from 'react';
import { Card } from '../ui/Card';

export function ShiftTimeCard({
  elapsedMinutes,
  totalMinutes,
  availableMinutes,
  breakMessage,
  className = '',
}: {
  elapsedMinutes: number;
  totalMinutes: number;
  availableMinutes: number;
  breakMessage?: ReactNode;
  className?: string;
}) {
  const formatTime = (minutes: number) => {
    const total = Math.round(minutes);
    return `${Math.floor(total / 60)}h ${total % 60}m`;
  };

  return (
    <Card
      className={`simulation-shift-inline ${className}`.trim()}
      actions={
        <div className="shift-time-header-metrics">
          <div className="shift-time-header-metric">
            <span>Elapsed</span>
            <strong>{formatTime(elapsedMinutes)}</strong>
          </div>
          <div className="shift-time-header-metric">
            <span>Total shift</span>
            <strong>{formatTime(totalMinutes)}</strong>
          </div>
          <div className="shift-time-header-metric">
            <span>Available</span>
            <strong>{formatTime(availableMinutes)}</strong>
          </div>
        </div>
      }
    >
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${Math.min(100, (elapsedMinutes / (totalMinutes || 1)) * 100)}%` }} />
      </div>
      {breakMessage && <div className="break-banner">{breakMessage}</div>}
    </Card>
  );
}
