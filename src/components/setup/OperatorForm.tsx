import type { ExtraBreak, OperatorConfig, TaskPriorityMode } from '../../types';
import { Fragment } from 'react';
import { availableTimeMinutes, extraBreakMinutes } from '../../lib/calculations';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, NumberInput, SelectInput } from '../ui/Field';

const TASK_PRIORITY_OPTIONS: { value: TaskPriorityMode; label: string }[] = [
  { value: 'nearest', label: 'Nearest Task' },
  { value: 'quickest', label: 'Quickest Task' },
];

export function OperatorForm({
  operator,
  onChange,
}: {
  operator: OperatorConfig;
  onChange: (next: OperatorConfig) => void;
}) {
  const set = <K extends keyof OperatorConfig>(key: K) => (v: OperatorConfig[K]) => onChange({ ...operator, [key]: v });
  const extraBreaks = operator.extraBreaks ?? [];
  const available = availableTimeMinutes(operator.shiftTime, operator.lunchTime, operator.meetingTime, extraBreakMinutes(extraBreaks));
  const setExtraBreaks = (next: ExtraBreak[]) => onChange({ ...operator, extraBreaks: next });
  const updateExtraBreak = (id: string, patch: Partial<ExtraBreak>) =>
    setExtraBreaks(extraBreaks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const addExtraBreak = () => setExtraBreaks([...extraBreaks, { id: `other-${Date.now()}`, time: 0, startAt: 0 }]);
  const removeExtraBreak = (id: string) => setExtraBreaks(extraBreaks.filter((b) => b.id !== id));

  return (
    <Card title="Operator Activities" subtitle="Work capacity and breaks within the shift">
      {/* Two columns: each row pairs a break's duration with where it starts in the shift. */}
      <div className="operator-form-grid">
        <Field
          label="Task Priority"
          tooltip="Nearest Task: always go to the closest machine in queue. Quickest Task: go to whichever queued task (walk + service time) finishes soonest."
        >
          <SelectInput value={operator.taskPriority} options={TASK_PRIORITY_OPTIONS} onChange={set('taskPriority')} />
        </Field>
        <Field label="Shift Time (min)">
          <NumberInput value={operator.shiftTime} onChange={set('shiftTime')} />
        </Field>
        <Field label="Lunch Time (min)">
          <NumberInput value={operator.lunchTime} onChange={set('lunchTime')} />
        </Field>
        <Field label="Lunch starts at minute" tooltip="Lunch break position within the shift">
          <NumberInput value={operator.lunchStartAt} min={0} onChange={set('lunchStartAt')} />
        </Field>
        <Field label="Meeting Time (min)">
          <NumberInput value={operator.meetingTime} onChange={set('meetingTime')} />
        </Field>
        <Field label="Meeting starts at minute" tooltip="Meeting break position within the shift">
          <NumberInput value={operator.meetingStartAt} min={0} onChange={set('meetingStartAt')} />
        </Field>
        {extraBreaks.map((extra, index) => (
          <Fragment key={extra.id}>
            <Field label={`Other${index + 1} Time (min)`}>
              <NumberInput value={extra.time} min={0} onChange={(v) => updateExtraBreak(extra.id, { time: v })} />
            </Field>
            <Field label={`Other${index + 1} starts at minute`} tooltip={`Other${index + 1} break position within the shift`}>
              <div className="operator-extra-row">
                <NumberInput value={extra.startAt} min={0} onChange={(v) => updateExtraBreak(extra.id, { startAt: v })} />
                <button
                  type="button"
                  className="operator-extra-remove"
                  onClick={() => removeExtraBreak(extra.id)}
                  title={`Remove Other${index + 1}`}
                  aria-label={`Remove Other${index + 1}`}
                >
                  ×
                </button>
              </div>
            </Field>
          </Fragment>
        ))}
      </div>
      <Button type="button" variant="ghost" className="operator-add-activity" onClick={addExtraBreak}>
        + Add activity
      </Button>
      <div className="divider" />
      <Field
        label="Available Time (min)"
        hint={`= ShiftTime - LunchTime - MeetingTime${extraBreaks.length > 0 ? ' - Other' : ''}. The simulation runs for the full ShiftTime, with every break inserted at its configured minute.`}
      >
        <NumberInput value={available} readOnly />
      </Field>
    </Card>
  );
}
