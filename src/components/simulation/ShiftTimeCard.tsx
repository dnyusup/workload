import { useState, useRef, type ReactNode } from 'react';
import { Card } from '../ui/Card';
import { useShiftStart } from '../../hooks/useShiftStart';
import { formatClock } from '../../lib/shiftClock';

export function ShiftTimeCard({
  elapsedMinutes,
  totalMinutes,
  availableMinutes,
  breakMessage,
  className = '',
  onSeek,
  maxSeekMinutes,
  isReplay = false,
}: {
  elapsedMinutes: number;
  totalMinutes: number;
  availableMinutes: number;
  breakMessage?: ReactNode;
  className?: string;
  onSeek?: (minute: number) => void;
  maxSeekMinutes?: number;
  isReplay?: boolean;
}) {
  const { shiftStartMin } = useShiftStart();
  const [isDragging, setIsDragging] = useState(false);
  const [hoverMin, setHoverMin] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number>(0);
  const barRef = useRef<HTMLDivElement>(null);

  const formatTime = (minutes: number) => {
    const total = Math.round(minutes);
    return `${Math.floor(total / 60)}h ${total % 60}m`;
  };

  const calcMinuteFromClientX = (clientX: number): number => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetMin = pct * totalMinutes;
    const ceiling = maxSeekMinutes != null ? Math.min(totalMinutes, maxSeekMinutes) : totalMinutes;
    return Math.max(0, Math.min(ceiling, targetMin));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    const min = calcMinuteFromClientX(e.clientX);
    onSeek(min);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barRef.current || !onSeek) return;
    const rect = barRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    setHoverX(x);
    const min = calcMinuteFromClientX(e.clientX);
    setHoverMin(min);
    if (isDragging) {
      onSeek(min);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setIsDragging(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const step = e.shiftKey ? 15 : e.ctrlKey || e.metaKey ? 5 : 1;
    const ceiling = maxSeekMinutes != null ? Math.min(totalMinutes, maxSeekMinutes) : totalMinutes;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onSeek(Math.max(0, elapsedMinutes - step));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onSeek(Math.min(ceiling, elapsedMinutes + step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSeek(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSeek(ceiling);
    }
  };

  const fillPercent = Math.min(100, Math.max(0, (elapsedMinutes / (totalMinutes || 1)) * 100));
  const bufferedPercent = maxSeekMinutes != null
    ? Math.min(100, Math.max(0, (maxSeekMinutes / (totalMinutes || 1)) * 100))
    : 100;

  return (
    <Card
      className={`simulation-shift-inline ${isReplay ? 'replay-active ' : ''}${className}`.trim()}
      actions={
        <div className="shift-time-header-metrics">
          <div className="shift-time-header-metric">
            <span>Clock</span>
            <strong>{formatClock(shiftStartMin + elapsedMinutes)}</strong>
          </div>
          <div className="shift-time-header-metric">
            <span>Elapsed</span>
            <strong>{formatTime(elapsedMinutes)}</strong>
          </div>
          {/* Shift clock range and available time live in this tooltip to keep the card compact. */}
          <div
            className="shift-time-header-metric"
            title={`${formatClock(shiftStartMin)}–${formatClock(shiftStartMin + totalMinutes)} · Available ${formatTime(availableMinutes)} (shift minus lunch and meeting)`}
          >
            <span>Total shift</span>
            <strong>{formatTime(totalMinutes)}</strong>
          </div>
        </div>
      }
    >
      <div
        ref={barRef}
        className={`progress-bar${onSeek ? ' scrubbable' : ''}${isDragging ? ' dragging' : ''}`}
        tabIndex={onSeek ? 0 : undefined}
        role={onSeek ? 'slider' : undefined}
        aria-label="Shift timeline slider"
        aria-valuemin={0}
        aria-valuemax={totalMinutes}
        aria-valuenow={Math.round(elapsedMinutes)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          if (!isDragging) setHoverMin(null);
        }}
        onKeyDown={handleKeyDown}
        title={onSeek ? 'Click or drag to seek anywhere along the shift timeline' : undefined}
      >
        <div className="progress-track">
          {maxSeekMinutes != null && maxSeekMinutes < totalMinutes && (
            <div className="progress-buffered" style={{ width: `${bufferedPercent}%` }} />
          )}
          <div className="progress-fill" style={{ width: `${fillPercent}%` }} />
        </div>
        {onSeek && (
          <div
            className="progress-thumb"
            style={{ left: `${fillPercent}%` }}
            aria-hidden="true"
          />
        )}
        {onSeek && hoverMin !== null && (
          <div
            className="progress-hover-tooltip"
            style={{ left: `${hoverX}px` }}
          >
            {formatClock(shiftStartMin + hoverMin)} ({formatTime(hoverMin)})
          </div>
        )}
      </div>
      {breakMessage && <div className="break-banner">{breakMessage}</div>}
    </Card>
  );
}
