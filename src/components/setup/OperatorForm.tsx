import type { OperatorConfig, TaskPriorityMode } from '../../types';
import { availableTimeMinutes } from '../../lib/calculations';
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
  const available = availableTimeMinutes(operator.shiftTime, operator.lunchTime, operator.meetingTime);

  return (
    <Card title="Operator Activities" subtitle="Work capacity and number of assigned machines">
      <div className="grid-2">
        <Field
          label="Task Priority"
          hint="Nearest Task: always go to the closest machine in queue. Quickest Task: go to whichever queued task (walk + service time) finishes soonest."
        >
          <SelectInput value={operator.taskPriority} options={TASK_PRIORITY_OPTIONS} onChange={set('taskPriority')} />
        </Field>
        <Field label="# Assigned Machines">
          <NumberInput value={operator.machHandled} min={0} onChange={set('machHandled')} />
        </Field>
        <Field label="Shift Time (min)">
          <NumberInput value={operator.shiftTime} onChange={set('shiftTime')} />
        </Field>
        <Field label="Lunch Time (min)">
          <NumberInput value={operator.lunchTime} onChange={set('lunchTime')} />
        </Field>
        <Field label="Lunch starts at minute" hint="Lunch break position within the shift">
          <NumberInput value={operator.lunchStartAt} min={0} onChange={set('lunchStartAt')} />
        </Field>
        <Field label="Meeting Time (min)">
          <NumberInput value={operator.meetingTime} onChange={set('meetingTime')} />
        </Field>
        <Field label="Meeting starts at minute" hint="Meeting break position within the shift">
          <NumberInput value={operator.meetingStartAt} min={0} onChange={set('meetingStartAt')} />
        </Field>
      </div>
      <div className="divider" />
      <Field
        label="Available Time (min)"
        hint="= ShiftTime - LunchTime - MeetingTime. The simulation runs for the full ShiftTime, with lunch and meeting inserted at the configured minutes."
      >
        <NumberInput value={available} readOnly />
      </Field>
    </Card>
  );
}
