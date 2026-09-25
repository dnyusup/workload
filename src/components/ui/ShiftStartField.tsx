import { useShiftStart } from '../../hooks/useShiftStart';

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, '0'));

/** Shift start time picker — two selects (hour 00–23, minute 00–59) so it's always 24-hour,
 * regardless of the browser/OS locale a native time input would follow. */
export function ShiftStartField() {
  const { shiftStart, setShiftStart } = useShiftStart();
  const [hour, minute] = shiftStart.split(':');
  return (
    <label className="shift-start-field" title="Clock time the shift starts (24-hour). Timelines show real clock times from here.">
      <span>Shift start</span>
      <select className="input" value={hour} onChange={(e) => setShiftStart(`${e.target.value}:${minute}`)} aria-label="Shift start hour">
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span className="shift-start-sep">:</span>
      <select className="input" value={minute} onChange={(e) => setShiftStart(`${hour}:${e.target.value}`)} aria-label="Shift start minute">
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </label>
  );
}
