import type { ActivityConfig, MachCondition } from '../../types';
import { fractureRepairingDenominator } from '../../lib/calculations';
import { Card } from '../ui/Card';

const CORE_ACTIVITY_KEYS = ['doffing', 'loading', 'fractureRepairing'];

const SUB_ACTIVITY_DEFAULTS: Record<string, { label: string; timeMinutes: number; denominator: number }> = {
  doffing: { label: 'Doffing Partial', timeMinutes: 1, denominator: 2 },
  loading: { label: 'Loading Partial', timeMinutes: 3, denominator: 3 },
  fractureRepairing: { label: 'Fracture Repairing Partial', timeMinutes: 5, denominator: 2 },
};

export function ActivityTable({
  activities,
  spoolWeight,
  fracturePerTon,
  diesPerTon,
  defectsPerTon,
  onChange,
}: {
  activities: ActivityConfig[];
  spoolWeight: number;
  fracturePerTon: number;
  diesPerTon: number;
  defectsPerTon: number;
  onChange: (next: ActivityConfig[]) => void;
}) {
  const update = (key: string, patch: Partial<ActivityConfig>) => {
    onChange(activities.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  };

  const addActivity = () => {
    const key = `activity-${Date.now()}`;
    onChange([
      ...activities,
      {
        key,
        label: 'New Activity',
        timeMinutes: 1,
        numerator: 1,
        numeratorAuto: false,
        denominator: 1,
        denominatorAuto: false,
        machCondition: 'stop',
      },
    ]);
  };

  const addSubActivity = (parentKey: string) => {
    const key = `${parentKey}-sub-${Date.now()}`;
    const parentIndex = activities.findIndex((activity) => activity.key === parentKey);
    // Insert after the parent's last existing sub-activity, not right after the parent itself.
    let insertAt = parentIndex;
    for (let i = parentIndex + 1; i < activities.length; i += 1) {
      if (activities[i].parentKey === parentKey) insertAt = i;
      else break;
    }
    const defaults = SUB_ACTIVITY_DEFAULTS[parentKey] ?? { label: 'Sub Activity', timeMinutes: 1, denominator: 2 };
    const activity: ActivityConfig = {
      key,
      parentKey,
      label: defaults.label,
      timeMinutes: defaults.timeMinutes,
      numerator: 1,
      numeratorAuto: false,
      denominator: defaults.denominator,
      denominatorAuto: false,
      machCondition: 'stop',
    };
    const next = [...activities];
    next.splice(insertAt >= 0 ? insertAt + 1 : next.length, 0, activity);
    onChange(next);
  };

  const removeActivity = (key: string) => {
    if (activities.length <= 1) return;
    if (CORE_ACTIVITY_KEYS.includes(key)) return;
    onChange(activities.filter((activity) => activity.key !== key));
  };

  return (
    <Card title="Activity Table" subtitle="Time and frequency for each service type per spool cycle">
      <div className="activity-table-wrap">
        <table className="table activity-table">
          <thead>
            <tr>
              <th className="activity-column">Activity</th>
              <th>Time (min)</th>
              <th>Numerator</th>
              <th>Denominator</th>
              <th>Mach Condition</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {activities.map((a) => {
            const autoNumerator =
              a.key === 'diesChange'
                ? diesPerTon
                : a.key === 'defectRepairing'
                  ? defectsPerTon
                  : fracturePerTon;
            const displayNumerator = a.numeratorAuto ? autoNumerator : a.numerator;
            const displayDenominator = a.denominatorAuto ? fractureRepairingDenominator(spoolWeight) : a.denominator;
            const numeratorLocked = a.numeratorAuto || a.numeratorReadOnly;
            const denominatorLocked = a.denominatorAuto || a.denominatorReadOnly;
            const remarks: string[] = [];
            if (a.numeratorAuto) {
              remarks.push(
                `Numerator = ${a.key === 'diesChange' ? 'Dies/Ton' : a.key === 'defectRepairing' ? 'Defect/Ton' : 'Fracture/Ton'}`,
              );
            }
            if (a.denominatorAuto) remarks.push('Denominator = 1000 / SpoolWeight');
            if (a.numeratorReadOnly || a.denominatorReadOnly || a.timeReadOnly) remarks.push('From WL_Products POlength / WL_Activities');
            const canHaveSubs = !a.parentKey;
            const canRemove = !CORE_ACTIVITY_KEYS.includes(a.key);
              return (
                <tr key={a.key} title={remarks.length > 0 ? remarks.join(' · ') : undefined}>
                  <td className={`activity-column ${a.parentKey ? 'activity-sub-row' : ''}`}>
                    {a.parentKey && <span className="activity-sub-marker">↳ </span>}
                    <input
                      className="input"
                      value={a.label}
                      onChange={(e) => update(a.key, { label: e.target.value })}
                    />
                  </td>
                <td>
                  <input
                    className={`input ${a.timeReadOnly ? 'input-readonly' : ''}`}
                    type="number"
                    readOnly={a.timeReadOnly}
                    value={a.timeMinutes}
                    onChange={(e) => update(a.key, { timeMinutes: parseFloat(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    className={`input ${numeratorLocked ? 'input-readonly' : ''}`}
                    type="number"
                    readOnly={numeratorLocked}
                    value={round(displayNumerator)}
                    onChange={(e) => update(a.key, { numerator: parseFloat(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    className={`input ${denominatorLocked ? 'input-readonly' : ''}`}
                    type="number"
                    readOnly={denominatorLocked}
                    value={round(displayDenominator)}
                    onChange={(e) => update(a.key, { denominator: parseFloat(e.target.value) })}
                  />
                </td>
                <td>
                  <select
                    className="input"
                    value={a.machCondition ?? 'stop'}
                    onChange={(e) => update(a.key, { machCondition: e.target.value as MachCondition })}
                  >
                    <option value="stop">Stop</option>
                    <option value="run">Run</option>
                  </select>
                </td>
                <td>
                  {canRemove && (
                    <button type="button" className="btn btn-ghost table-remove" onClick={() => removeActivity(a.key)}>
                                Remove
                    </button>
                  )}
                  {canHaveSubs && (
                    <button
                      type="button"
                      className="btn btn-ghost table-sub-add"
                      disabled={a.key === 'fractureRepairing'}
                      title={a.key === 'fractureRepairing' ? 'Belum ada regulasi untuk Sub Fracture Repairing' : undefined}
                      onClick={() => addSubActivity(a.key)}
                    >
                      + Sub {a.label}
                    </button>
                  )}
                </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn btn-secondary activity-add" onClick={addActivity}>
        + Add Activity
      </button>
    </Card>
  );
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}
