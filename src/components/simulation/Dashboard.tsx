import { useState } from 'react';
import type { AppConfig, DowntimeReason, SimulationState } from '../../types';
import { deriveMachineSpec } from '../../lib/calculations';
import { Card } from '../ui/Card';
import { useAuth } from '../../context/AuthContext';

function fmt(v: number) {
  return Math.round(v * 10) / 10;
}

function fmtTime(min: number) {
  const totalMinutes = Math.round(min);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

const defaultDowntimeLabels: Record<string, string> = {
  doffing: 'Doffing',
  loading: 'Loading',
  fractureRepairing: 'Fracture Repairing',
  waiting: 'Waiting for Operator',
};

const downtimeColors: Record<string, string> = {
  doffing: '#38bdf8',
  loading: '#a78bfa',
  fractureRepairing: '#f87171',
  waiting: '#fbbf24',
};

function colorForDowntime(key: string, index: number) {
  const palette = ['#38bdf8', '#a78bfa', '#f87171', '#c084fc', '#2dd4bf', '#fb923c', '#facc15'];
  return downtimeColors[key] ?? palette[index % palette.length];
}

export function Dashboard({ state, config }: { state: SimulationState; config: AppConfig }) {
  const { user } = useAuth();
  const { metrics, machines, log } = state;
  const isAdmin = user.role === 'admin';
  const [targetUtilization, setTargetUtilization] = useState(85);
  const busyMin = metrics.walkingMin + metrics.servicingMin;
  const workedElapsed = Math.max(0, metrics.clockMin - metrics.breakElapsedMin);
  const utilization = workedElapsed > 0 ? (busyMin / workedElapsed) * 100 : 0;
  const utilizationPct = (minutes: number) => (workedElapsed > 0 ? (minutes / workedElapsed) * 100 : 0);
  const avgWait = metrics.totalWaitCount > 0 ? metrics.totalWaitMin / metrics.totalWaitCount : 0;
  const queue = machines.filter((m) => m.status === 'needs-service');

  const plannedProductionMin = metrics.assignedMachineCount * metrics.clockMin;
  const totalDowntimeMin = Object.values(metrics.downtimeByReason).reduce((a, b) => a + b, 0);
  const availability = plannedProductionMin > 0 ? ((plannedProductionMin - totalDowntimeMin) / plannedProductionMin) * 100 : 100;
  const oee = Math.max(0, Math.min(100, availability));

  // Output: what was actually produced this shift, and how efficiently the scheduled machine-time
  // converted into finished spools (excludes any machine time still mid-spool, not yet a full unit).
  // A spool only really counts as "output" once it's been doffed (collected off the machine) — using
  // completedByActivity.doffing instead of raw production count also keeps this in sync with the
  // Doffing count shown under Completed Activities, including the initial-backlog Doffing tasks
  // some machines start the shift with (leftover from before the shift, serviced during it).
  const totalSpools = metrics.completedByActivity.doffing ?? 0;
  const spoolWeightKg = deriveMachineSpec(config.spec).spoolWeight;
  const tonage = (totalSpools * spoolWeightKg) / 1000;
  const shiftHours = metrics.shiftTimeMin / 60;
  const manHourPerTon = tonage > 0 ? shiftHours / tonage : 0;
  const scheduledMachineMin = metrics.assignedMachineCount * metrics.shiftTimeMin;
  const producedMachineMin = totalSpools * metrics.runtimePerSpoolMin;
  const outputOee = scheduledMachineMin > 0 ? (producedMachineMin / scheduledMachineMin) * 100 : 0;
  const scheduledMachineHours = metrics.assignedMachineCount * shiftHours;
  const machHoursPerTon = tonage > 0 ? scheduledMachineHours / tonage : 0;
  const totalFractureCount = Object.entries(metrics.completedByActivity)
    .filter(([key]) => key === 'fractureRepairing' || key.startsWith('fractureRepairing-'))
    .reduce((sum, [, count]) => sum + count, 0);
  const actualFracturePerTon = tonage > 0 ? totalFractureCount / tonage : 0;
  const actualDiesPerTon = tonage > 0 ? metrics.diesChanged / tonage : 0;
  const totalDefectRepairingCount = Object.entries(metrics.completedByActivity)
    .filter(([key]) => key === 'defectRepairing' || key.startsWith('defectRepairing-'))
    .reduce((sum, [, count]) => sum + count, 0);
  const actualDefectPerTon = tonage > 0 ? totalDefectRepairingCount / tonage : 0;

  let verdict = 'Operator capacity is sufficient.';
  let verdictClass = 'verdict-ok';
  if (utilization >= 100) {
    verdict = 'Operator overload — consider adding an operator or reducing machines.';
    verdictClass = 'verdict-bad';
  } else if (utilization >= 95) {
    verdict = 'High workload — approaching capacity limit.';
    verdictClass = 'verdict-warn';
  } else if (utilization < 75) {
    verdict = 'Need operator optimization — operator is underutilized.';
    verdictClass = 'verdict-info';
  }

  // Sizes #MachHandled so utilization would land back around the target — shown for every verdict
  // except when it would round to zero (i.e. already right at the target).
  const machRecommendation =
    utilization > 0 && metrics.assignedMachineCount > 0
      ? Math.round(metrics.assignedMachineCount * (targetUtilization / utilization)) - metrics.assignedMachineCount
      : 0;

  const downtimeEntries = (Object.keys(metrics.downtimeByReason) as DowntimeReason[])
    .map((key, index) => ({
      key,
      label: config.activities.find((activity) => activity.key === key)?.label ?? defaultDowntimeLabels[key] ?? key,
      value: metrics.downtimeByReason[key],
      color: colorForDowntime(key, index),
    }))
    .sort((a, b) => b.value - a.value);
  const maxDowntime = downtimeEntries[0]?.value ?? 0;

  return (
    <div className="dashboard-scroll-outer">
    <div className="dashboard">
      <Card title="Output" subtitle="Actual finished spools this shift — OEE here excludes machine time still mid-spool">
        <div className="metric-row">
          <span>#Spool</span>
          <strong>{totalSpools}</strong>
        </div>
        <div className="metric-row">
          <span>Tonage</span>
          <strong>{fmt(tonage)} ton</strong>
        </div>
        <div className="metric-row">
          <span>OEE (finished spool)</span>
          <strong>{fmt(outputOee)}%</strong>
        </div>
        <div className="metric-row">
          <span>Manhour/ton</span>
          <strong>{fmt(manHourPerTon)}</strong>
        </div>
        <div className="metric-row">
          <span>Machhours/ton</span>
          <strong>{fmt(machHoursPerTon)}</strong>
        </div>
        <div className="metric-row" title="Total Fracture Repairing ÷ Tonage">
          <span>Fracture/Ton (actual)</span>
          <strong>{fmt(actualFracturePerTon)}</strong>
        </div>
        <div className="metric-row" title="Total Dies Change events ÷ Tonage">
          <span>Dies/Ton (actual)</span>
          <strong>{fmt(actualDiesPerTon)}</strong>
        </div>
        <div className="metric-row" title="Total Defect Repairing events ÷ Tonage">
          <span>Defect/Ton (actual)</span>
          <strong>{fmt(actualDefectPerTon)}</strong>
        </div>
      </Card>

      <Card title="Operator Utilization" subtitle="Calculated against net working time (excluding lunch/meeting)">
        <div className="util-bar">
          <div className="util-segment util-walk" style={{ width: `${(metrics.walkingMin / (workedElapsed || 1)) * 100}%` }} />
          <div className="util-segment util-service" style={{ width: `${(metrics.servicingMin / (workedElapsed || 1)) * 100}%` }} />
        </div>
        <div className="metric-row">
          <span>Utilization</span>
          <strong>{fmt(utilization)}%</strong>
        </div>
        <div className="metric-row small">
          <span>Walking</span>
          <span>
            {fmtTime(metrics.walkingMin)} ({fmt(utilizationPct(metrics.walkingMin))}%)
          </span>
        </div>
        <div className="metric-row small">
          <span>Total handle</span>
          <span>
            {fmtTime(metrics.servicingMin)} ({fmt(utilizationPct(metrics.servicingMin))}%)
          </span>
        </div>
        {config.activities.map((activity) => (
          <div className="metric-row small" key={`service-${activity.key}`}>
            <span>Handle: {activity.label}</span>
            <span>
              {fmtTime(metrics.servicingByActivity[activity.key] ?? 0)} (
              {fmt(utilizationPct(metrics.servicingByActivity[activity.key] ?? 0))}%)
            </span>
          </div>
        ))}
        {(metrics.servicingByActivity.service ?? 0) > 1e-9 && (
          <div className="metric-row small">
            <span>Unclassified handle</span>
            <span>
              {fmtTime(metrics.servicingByActivity.service)} ({fmt(utilizationPct(metrics.servicingByActivity.service))}%)
            </span>
          </div>
        )}
        <div className="metric-row small">
          <span>Idle</span>
          <span>
            {fmtTime(metrics.idleMin)} ({fmt(utilizationPct(metrics.idleMin))}%)
          </span>
        </div>
        <div className={`verdict ${verdictClass}`}>{verdict}</div>
        <label className="target-utilization-field">
          <span>Target Utilization</span>
          <span className="target-utilization-input-group">
            <input
              className="input input-sm"
              type="number"
              min={1}
              max={100}
              value={targetUtilization}
              onChange={(e) => {
                const value = parseFloat(e.target.value);
                if (Number.isFinite(value)) setTargetUtilization(Math.min(100, Math.max(1, value)));
              }}
            />
            <span>%</span>
          </span>
        </label>
        {isAdmin && machRecommendation !== 0 && (
          <div className="verdict-recommendation">
            #Mach Recommendation: {machRecommendation > 0 ? `+${machRecommendation}` : machRecommendation} machine
            {Math.abs(machRecommendation) > 1 ? 's' : ''} (target ~{targetUtilization}% utilization)
          </div>
        )}
      </Card>

      <Card
        title="OEE & Downtime"
        className="dashboard-oee-card"
        subtitle="Availability across assigned machines (Performance & Quality assumed at 100%)"
      >
        <div className="oee-gauge-row">
          <div className="oee-gauge">
            <span className="oee-value">{fmt(oee)}%</span>
            <span className="oee-caption">OEE (Availability)</span>
          </div>
          <div className="metric-col">
            <div className="metric-row small">
              <span>Planned production</span>
              <span>{fmt(plannedProductionMin)} machine-minutes</span>
            </div>
            <div className="metric-row small">
              <span>Total downtime</span>
              <span>{fmt(totalDowntimeMin)} machine-minutes</span>
            </div>
          </div>
        </div>
        <div className="downtime-bars">
          {downtimeEntries.map((d) => {
            const pct = plannedProductionMin > 0 ? (d.value / plannedProductionMin) * 100 : 0;
            const barPct = maxDowntime > 0 ? (d.value / maxDowntime) * 100 : 0;
            return (
              <div key={d.key} className="downtime-row">
                <span className="downtime-label">{d.label}</span>
                <div className="downtime-bar-track">
                  <div className="downtime-bar-fill" style={{ width: `${barPct}%`, background: d.color }} />
                </div>
                <span className="downtime-value">
                  {fmt(d.value)}m ({fmt(pct)}%)
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Completed Activities"
        subtitle={`vs theoretical estimate (± ${metrics.theoreticalSpoolsPerShift} spools/machine per shift)`}
      >
        {config.activities.map((activity) => (
          <div className="metric-row" key={activity.key}>
            <span>{activity.label}</span>
            <strong>
              {metrics.completedByActivity[activity.key] ?? 0}
              <span className="metric-est"> / ~{metrics.expectedEventsByActivity[activity.key] ?? 0}</span>
            </strong>
          </div>
        ))}
        <div className="metric-row">
          <span>Average wait time</span>
          <strong>{fmt(avgWait)} min</strong>
        </div>
      </Card>

      <Card title={`Queue (${queue.length})`}>
        {queue.length === 0 && <p className="empty-hint">No machines waiting.</p>}
        <ul className="queue-list">
          {queue.map((m) => (
            <li key={m.id}>
              <span>Machine {m.label}</span>
              <span className="queue-tasks">{m.pendingTasks.map((t) => t.label).join(', ')}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Activity Log">
        <div className="event-log">
          {[...log].reverse().slice(0, 30).map((e) => (
            <div key={e.id} className="log-row">
              <span className="log-time">{fmtTime(e.timeMin)}</span>
              <span>{e.message}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
    </div>
  );
}
