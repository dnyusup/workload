import type { ExtraBreak, MovementParams, OperatorConfig, TaskPriorityMode } from '../../types';
import { Fragment } from 'react';
import { availableTimeMinutes, extraBreakMinutes } from '../../lib/calculations';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, NumberInput, SelectInput } from '../ui/Field';
import { Toggle } from '../ui/Toggle';
import { DOFF_PRIORITY_TOOLTIP } from '../ui/doffPriorityText';
import { BUILT_IN_DEFAULTS } from '../../lib/defaultValuesStore';

const TASK_PRIORITY_OPTIONS: { value: TaskPriorityMode; label: string }[] = [
  { value: 'nearest', label: 'Nearest Task' },
  { value: 'quickest', label: 'Quickest Task' },
];

export function OperatorForm({
  operator,
  onChange,
  movement,
  onMovementChange,
}: {
  operator: OperatorConfig;
  onChange: (next: OperatorConfig) => void;
  movement: MovementParams;
  onMovementChange: (next: MovementParams) => void;
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
      <div className="operator-form-grid">
        <Field
          label="Available Time (min)"
          hint={`= ShiftTime - LunchTime - MeetingTime${extraBreaks.length > 0 ? ' - Other' : ''}. The simulation runs for the full ShiftTime, with every break inserted at its configured minute.`}
        >
          <NumberInput value={available} readOnly />
        </Field>
        <Field label="Walking Speed (m/min)" tooltip="Used to work out how long the operator walks between machines on the layout">
          <NumberInput value={movement.walkingSpeed} min={0} onChange={(walkingSpeed) => onMovementChange({ ...movement, walkingSpeed })} />
        </Field>
      </div>
      <div className="operator-form-grid operator-doff-priority">
        <Field label="Doff Priority" tooltip={DOFF_PRIORITY_TOOLTIP}>
          <Toggle
            checked={!!operator.doffPriority}
            onChange={(doffPriority) =>
              onChange({
                ...operator,
                doffPriority,
                // Lock in the value the field already shows, so the simulation uses the same number.
                minRemainForDoffPriority: operator.minRemainForDoffPriority ?? BUILT_IN_DEFAULTS.minRemainForDoffPriority,
              })
            }
            ariaLabel="Doff Priority"
          />
        </Field>
        <Field label="Min Remain Task for Doff Priority (min)">
          <NumberInput
            value={operator.minRemainForDoffPriority ?? BUILT_IN_DEFAULTS.minRemainForDoffPriority}
            min={0}
            readOnly={!operator.doffPriority}
            onChange={(v) => set('minRemainForDoffPriority')(Number.isFinite(v) ? v : 0)}
          />
        </Field>
      </div>
    </Card>
  );
}
