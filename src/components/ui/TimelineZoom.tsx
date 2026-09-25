import { MAX_TIMELINE_ZOOM, MIN_TIMELINE_ZOOM, useTimelineZoom } from '../../hooks/useTimelineZoom';
import { useShiftStart } from '../../hooks/useShiftStart';
import { formatClock } from '../../lib/shiftClock';

const TICK_STEPS_MIN = [60, 30, 15, 10, 5, 2, 1];

/** The single zoom bar for every timeline: −, a (logarithmic) slider, +, the current level, and
 * Fit to shift (back to 1× = the whole shift in view). */
export function TimelineZoomControl() {
  const { zoom, setZoom: onZoom, fitToShift: onFit } = useTimelineZoom();
  const maxExp = Math.log2(MAX_TIMELINE_ZOOM);
  const exp = Math.log2(zoom);
  const zoomToExp = (next: number) => onZoom(2 ** Math.min(maxExp, Math.max(0, next)));
  return (
    <div className="timeline-zoom-control">
      <span className="timeline-zoom-caption">Timeline zoom</span>
      <button type="button" onClick={() => zoomToExp(exp - 0.5)} disabled={zoom <= MIN_TIMELINE_ZOOM} title="Zoom out timeline" aria-label="Zoom out timeline">
        −
      </button>
      <input
        type="range"
        min={0}
        max={maxExp}
        step={0.05}
        value={exp}
        onChange={(e) => zoomToExp(Number(e.target.value))}
        aria-label="Timeline zoom"
        title="Timeline zoom"
      />
      <button type="button" onClick={() => zoomToExp(exp + 0.5)} disabled={zoom >= MAX_TIMELINE_ZOOM} title="Zoom in timeline" aria-label="Zoom in timeline">
        +
      </button>
      <span className="timeline-zoom-level">{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×</span>
      <button type="button" className="timeline-zoom-fit" onClick={onFit} disabled={zoom === MIN_TIMELINE_ZOOM} title="Fit the whole shift in view">
        Fit to shift
      </button>
    </div>
  );
}

/** Time ruler that scales with the zoom level and reads in wall-clock time from the shift start
 * (24-hour): ticks land on round clock times — hourly at 1×, down to every minute when zoomed far
 * in — plus the shift's own start. `offsetPx` lines it up with tracks that sit after a fixed label
 * column (e.g. machine rows). */
export function TimelineRuler({ shiftTimeMin, zoom, offsetPx = 0 }: { shiftTimeMin: number; zoom: number; offsetPx?: number }) {
  const { shiftStartMin } = useShiftStart();
  if (shiftTimeMin <= 0) return null;
  const step = [...TICK_STEPS_MIN].reverse().find((s) => s >= 60 / zoom) ?? 60;
  // Offsets (minutes since shift start) of every round-clock tick inside the shift.
  const ticks: number[] = [];
  for (let clock = Math.ceil(shiftStartMin / step) * step; clock <= shiftStartMin + shiftTimeMin + 1e-9; clock += step) {
    ticks.push(clock - shiftStartMin);
  }
  // Always label the shift start, unless a round tick already sits right next to it.
  if (ticks.length === 0 || ticks[0] > step * 0.4) ticks.unshift(0);
  return (
    <div className="timeline-ruler" style={{ paddingLeft: offsetPx }}>
      <div className="timeline-ruler-track">
        {ticks.map((t) => (
          <span
            key={t}
            className={`timeline-ruler-tick${(shiftStartMin + t) % 60 === 0 ? ' is-hour' : ''}`}
            style={{ left: `${(t / shiftTimeMin) * 100}%` }}
          >
            {formatClock(shiftStartMin + t)}
          </span>
        ))}
      </div>
    </div>
  );
}
