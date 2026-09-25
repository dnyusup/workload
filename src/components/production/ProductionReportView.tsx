import { useMemo, useState, type ReactNode } from 'react';
import type { ProductionSetup, ProductionSimulationState } from '../../types';
import type { ResolvedConstruction } from '../../lib/productionConstructionResolver';
import {
  REPORT_DIMENSIONS,
  buildMachineFacts,
  buildOperatorFacts,
  dimensionValue,
  groupMachines,
  summarize,
  type ReportDimension,
  type ReportGroup,
} from '../../lib/productionReport';
import { formatClock } from '../../lib/shiftClock';
import { useShiftStart } from '../../hooks/useShiftStart';

/* Dark-mode categorical slots (validated on the app surface #111827: worst adjacent CVD ΔE 8.4,
 * all ≥ 3:1). Order is fixed; entities keep their slot regardless of filtering. */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER_COLOR = '#64748b';
const RUNNING_COLOR = SERIES[2];
/** Downtime reasons take the remaining slots (blue stays with single-series magnitude bars). */
const REASON_SLOTS = [SERIES[1], SERIES[3], SERIES[4], SERIES[6], SERIES[7], SERIES[5]];
const TOP_BARS = 12;
const TABLE_PAGE = 100;

type OeeStatus = { key: 'good' | 'warning' | 'critical'; label: string; icon: string };
function oeeStatus(oee: number): OeeStatus {
  if (oee >= 0.85) return { key: 'good', label: 'World class', icon: '✓' };
  if (oee >= 0.65) return { key: 'warning', label: 'Typical', icon: '!' };
  return { key: 'critical', label: 'Low', icon: '✕' };
}

const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const num = (v: number, digits = 1) => v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const hours = (min: number) => `${num(min / 60, 1)} h`;

type SortKey = 'label' | 'machines' | 'spools' | 'goodTon' | 'share' | 'availability' | 'oee' | 'downtimeMin' | 'avgOccupation';

export function ProductionReportView({
  state,
  setup,
  resolved,
  rejectPercent,
  activityLabel,
  onBack,
}: {
  state: ProductionSimulationState;
  setup: ProductionSetup;
  resolved: Map<string, ResolvedConstruction>;
  rejectPercent: number;
  activityLabel: (key: string) => string;
  onBack: () => void;
}) {
  const { shiftStartMin } = useShiftStart();
  const [dimension, setDimension] = useState<ReportDimension>('constructionDetail');
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'goodTon', dir: 'desc' });
  const [tableQuery, setTableQuery] = useState('');
  const [showAllRows, setShowAllRows] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);

  const quality = 1 - Math.min(100, Math.max(0, rejectPercent)) / 100;
  const shiftHours = state.metrics.shiftTimeMin / 60;
  const clock = Math.min(state.metrics.clockMin, state.metrics.shiftTimeMin);

  const machineFacts = useMemo(() => buildMachineFacts(state, setup, resolved, activityLabel), [state, setup, resolved, activityLabel]);
  const operatorFacts = useMemo(() => buildOperatorFacts(state, setup, activityLabel), [state, setup, activityLabel]);

  // Reason colors are assigned once from the whole-plant ranking, so drilling in never repaints them.
  const reasonColor = useMemo(() => {
    const all = summarize(machineFacts, operatorFacts, quality, shiftHours).downtimeByReason;
    const map = new Map<string, string>();
    all.forEach(([reason], index) => map.set(reason, REASON_SLOTS[index] ?? OTHER_COLOR));
    return (reason: string) => map.get(reason) ?? OTHER_COLOR;
  }, [machineFacts, operatorFacts, quality, shiftHours]);

  const focused = focusKey !== null;
  const scopeMachines = focused ? machineFacts.filter((m) => dimensionValue(m, dimension) === focusKey) : machineFacts;
  const scopeMachineIds = new Set(scopeMachines.map((m) => m.id));
  const scopeOperators = operatorFacts.filter((op) => op.machineIds.some((id) => scopeMachineIds.has(id)));
  const totals = summarize(scopeMachines, operatorFacts, quality, shiftHours);
  // Drilled into one group → break it down by machine.
  const breakdownDimension: ReportDimension = focused ? 'machine' : dimension;
  const groups = groupMachines(scopeMachines, operatorFacts, breakdownDimension, quality, shiftHours);
  const breakdownLabel = REPORT_DIMENSIONS.find((d) => d.key === breakdownDimension)?.label ?? '';
  const status = oeeStatus(totals.oee);

  const showTip = (e: React.MouseEvent, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content });
  const hideTip = () => setTip(null);

  // ---- chart data
  const byOutput = [...groups].sort((a, b) => b.goodTon - a.goodTon);
  const outputBars = foldOther(byOutput, (g) => g.goodTon);
  const maxOutput = Math.max(0, ...outputBars.map((b) => b.value));
  const byOee = [...groups].filter((g) => g.plannedMin > 0).sort((a, b) => a.oee - b.oee).slice(0, TOP_BARS);
  const reasonTotal = totals.downtimeByReason.reduce((s, [, v]) => s + v, 0);
  const maxReason = totals.downtimeByReason[0]?.[1] ?? 0;
  const compositionRows = byOutput.slice(0, TOP_BARS);
  const compositionReasons = totals.downtimeByReason.slice(0, REASON_SLOTS.length).map(([r]) => r);

  const bins = [
    { label: '< 60%', test: (v: number) => v < 60 },
    { label: '60–75%', test: (v: number) => v >= 60 && v < 75 },
    { label: '75–85%', test: (v: number) => v >= 75 && v < 85 },
    { label: '85–95%', test: (v: number) => v >= 85 && v < 95 },
    { label: '95–100%', test: (v: number) => v >= 95 && v < 100 },
    { label: '≥ 100%', test: (v: number) => v >= 100 },
  ].map((bin) => ({ ...bin, count: scopeOperators.filter((op) => bin.test(op.occupation)).length }));
  const maxBin = Math.max(1, ...bins.map((b) => b.count));

  // ---- table
  const shareOf = (g: ReportGroup) => (totals.goodTon > 0 ? g.goodTon / totals.goodTon : 0);
  const sortedGroups = useMemo(() => {
    const value = (g: ReportGroup): number | string => (sort.key === 'label' ? g.label : sort.key === 'share' ? shareOf(g) : g[sort.key]);
    const q = tableQuery.trim().toLowerCase();
    return [...groups]
      .filter((g) => !q || g.label.toLowerCase().includes(q))
      .sort((a, b) => {
        const av = value(a);
        const bv = value(b);
        const cmp = typeof av === 'string' ? av.localeCompare(String(bv), undefined, { numeric: true }) : av - (bv as number);
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, sort, tableQuery]);
  const visibleRows = showAllRows ? sortedGroups : sortedGroups.slice(0, TABLE_PAGE);
  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'label' ? 'asc' : 'desc' }));

  const [operatorSort, setOperatorSort] = useState<'occupation' | 'label'>('occupation');
  const operatorRows = [...scopeOperators].sort((a, b) =>
    operatorSort === 'label' ? a.label.localeCompare(b.label, undefined, { numeric: true }) : b.occupation - a.occupation,
  );

  const changeDimension = (next: ReportDimension) => {
    setDimension(next);
    setFocusKey(null);
    setTableQuery('');
    setShowAllRows(false);
  };
  const focusGroup = (key: string) => {
    if (focused) return; // already drilled to machine level
    setFocusKey(key);
    setTableQuery('');
    setShowAllRows(false);
  };

  return (
    <div className="rpt-root">
      <header className="rpt-header">
        <div className="rpt-header-main">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            ← Back to simulation
          </button>
          <div>
            <h2>Production Report</h2>
            <p>
              {setup.name} · snapshot at {formatClock(shiftStartMin + clock)} ({num(clock / 60, 1)} h of {num(shiftHours, 1)} h shift) ·
              Reject {num(rejectPercent, 1)}%
            </p>
          </div>
        </div>
        <label className="rpt-dimension">
          <span>Group by</span>
          <select className="input" value={dimension} onChange={(e) => changeDimension(e.target.value as ReportDimension)}>
            {REPORT_DIMENSIONS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <nav className="rpt-breadcrumb" aria-label="Report scope">
        <button type="button" className={focused ? 'rpt-crumb-link' : 'rpt-crumb-current'} onClick={() => setFocusKey(null)} disabled={!focused}>
          All planned machines
        </button>
        {focused && (
          <>
            <span aria-hidden="true">›</span>
            <span className="rpt-crumb-current">
              {REPORT_DIMENSIONS.find((d) => d.key === dimension)?.label}: {focusKey}
            </span>
          </>
        )}
        <span className="rpt-crumb-hint">{focused ? 'Machine-level breakdown of this group' : 'Click a row in the breakdown table to drill in'}</span>
      </nav>

      <section className="rpt-kpis">
        <Kpi label="OEE" value={pct(totals.oee)} note={<span className={`rpt-status rpt-status-${status.key}`}><b aria-hidden="true">{status.icon}</b> {status.label}</span>} hero />
        <Kpi label="Availability" value={pct(totals.availability)} note={`${hours(totals.downtimeMin)} downtime`} />
        <Kpi label="Quality" value={pct(totals.quality)} note={`${num(totals.rejectTon)} ton reject`} />
        <Kpi label="Good tonnage" value={`${num(totals.goodTon)} ton`} note={`FP ${num(totals.goodTonFp)} · SFP ${num(totals.goodTonSfp)}`} />
        <Kpi label="Spools produced" value={num(totals.spools, 0)} note={`${num(totals.machines, 0)} machines`} />
        <Kpi label="Avg man occupation" value={`${num(totals.avgOccupation)}%`} note={`${totals.operators} operators`} />
        <Kpi label="Manhour / good ton" value={num(totals.manhourPerTon, 2)} note="operators × shift ÷ good ton" />
      </section>

      <section className="rpt-grid">
        <Panel title={`Good output by ${breakdownLabel}`} subtitle={`Good tonnage, top ${TOP_BARS}${outputBars.length > TOP_BARS ? ' + other' : ''}`}>
          <div className="rpt-hbars">
            {outputBars.map((bar) => (
              <div
                key={bar.key}
                className="rpt-hbar-row"
                onMouseMove={(e) => showTip(e, <><b>{bar.label}</b><br />{num(bar.value)} ton good · {pct(totals.goodTon > 0 ? bar.value / totals.goodTon : 0)} of total</>)}
                onMouseLeave={hideTip}
              >
                <span className="rpt-hbar-label" title={bar.label}>{bar.label}</span>
                <span className="rpt-hbar-track">
                  <span className="rpt-hbar-fill" style={{ width: `${maxOutput > 0 ? (bar.value / maxOutput) * 100 : 0}%`, background: bar.other ? OTHER_COLOR : SERIES[0] }} />
                </span>
                <span className="rpt-hbar-value">{num(bar.value)} t</span>
              </div>
            ))}
            {outputBars.length === 0 && <p className="rpt-empty">No output yet.</p>}
          </div>
        </Panel>

        <Panel title={`Lowest OEE by ${breakdownLabel}`} subtitle="Worst first · dashed line = 85% world-class target">
          <div className="rpt-hbars">
            {byOee.map((g) => {
              const s = oeeStatus(g.oee);
              return (
                <div
                  key={g.key}
                  className="rpt-hbar-row"
                  onMouseMove={(e) => showTip(e, <><b>{g.label}</b><br />OEE {pct(g.oee)} · Availability {pct(g.availability)} · Quality {pct(g.quality)}<br />{s.label}</>)}
                  onMouseLeave={hideTip}
                >
                  <span className="rpt-hbar-label" title={g.label}>{g.label}</span>
                  <span className="rpt-hbar-track">
                    <span className="rpt-hbar-fill" style={{ width: `${g.oee * 100}%`, background: SERIES[0] }} />
                    <span className="rpt-hbar-target" style={{ left: '85%' }} />
                  </span>
                  <span className="rpt-hbar-value">
                    <span className={`rpt-status-icon rpt-status-${s.key}`} aria-label={s.label}>{s.icon}</span> {pct(g.oee)}
                  </span>
                </div>
              );
            })}
            {byOee.length === 0 && <p className="rpt-empty">No machine time yet.</p>}
          </div>
        </Panel>

        <Panel title="Downtime Pareto" subtitle={`By reason · ${hours(reasonTotal)} total machine downtime`}>
          <div className="rpt-hbars">
            {totals.downtimeByReason.map(([reason, minutes], index) => {
              const cumulative = totals.downtimeByReason.slice(0, index + 1).reduce((s, [, v]) => s + v, 0);
              return (
                <div
                  key={reason}
                  className="rpt-hbar-row"
                  onMouseMove={(e) => showTip(e, <><b>{reason}</b><br />{hours(minutes)} · {pct(reasonTotal > 0 ? minutes / reasonTotal : 0)} of downtime<br />Cumulative {pct(reasonTotal > 0 ? cumulative / reasonTotal : 0)}</>)}
                  onMouseLeave={hideTip}
                >
                  <span className="rpt-hbar-label">
                    <span className="rpt-swatch" style={{ background: reasonColor(reason) }} />
                    {reason}
                  </span>
                  <span className="rpt-hbar-track">
                    <span className="rpt-hbar-fill" style={{ width: `${maxReason > 0 ? (minutes / maxReason) * 100 : 0}%`, background: reasonColor(reason) }} />
                  </span>
                  <span className="rpt-hbar-value">{pct(reasonTotal > 0 ? minutes / reasonTotal : 0, 0)}</span>
                </div>
              );
            })}
            {totals.downtimeByReason.length === 0 && <p className="rpt-empty">No downtime recorded.</p>}
          </div>
        </Panel>

        <Panel title={`Machine time by ${breakdownLabel}`} subtitle={`Share of planned machine time · top ${TOP_BARS} by output`}>
          <div className="rpt-legend">
            <span><span className="rpt-swatch" style={{ background: RUNNING_COLOR }} />Running</span>
            {compositionReasons.map((r) => (
              <span key={r}><span className="rpt-swatch" style={{ background: reasonColor(r) }} />{r}</span>
            ))}
            <span><span className="rpt-swatch" style={{ background: OTHER_COLOR }} />Other</span>
          </div>
          <div className="rpt-hbars">
            {compositionRows.map((g) => {
              const planned = g.plannedMin || 1;
              const listed = compositionReasons.map((r) => ({ key: r, minutes: g.downtimeByReason.find(([name]) => name === r)?.[1] ?? 0, color: reasonColor(r) }));
              const otherMin = Math.max(0, g.plannedMin - g.runningMin - listed.reduce((s, x) => s + x.minutes, 0));
              const parts = [{ key: 'Running', minutes: g.runningMin, color: RUNNING_COLOR }, ...listed, { key: 'Other', minutes: otherMin, color: OTHER_COLOR }].filter((p) => p.minutes > 0);
              return (
                <div key={g.key} className="rpt-hbar-row" onMouseLeave={hideTip}>
                  <span className="rpt-hbar-label" title={g.label}>{g.label}</span>
                  <span className="rpt-stack">
                    {parts.map((p) => (
                      <span
                        key={p.key}
                        className="rpt-stack-part"
                        style={{ width: `${(p.minutes / planned) * 100}%`, background: p.color }}
                        onMouseMove={(e) => showTip(e, <><b>{g.label}</b><br />{p.key}: {hours(p.minutes)} ({pct(p.minutes / planned)})</>)}
                      />
                    ))}
                  </span>
                  <span className="rpt-hbar-value">{pct(g.runningMin / planned, 0)}</span>
                </div>
              );
            })}
            {compositionRows.length === 0 && <p className="rpt-empty">No machine time yet.</p>}
          </div>
        </Panel>
      </section>

      <Panel
        title={`Breakdown by ${breakdownLabel}`}
        subtitle={focused ? 'Machines in the selected group' : 'Sortable · click a row to drill into its machines'}
        actions={
          <input className="input rpt-search" placeholder={`Search ${breakdownLabel}…`} value={tableQuery} onChange={(e) => setTableQuery(e.target.value)} />
        }
      >
        <div className="rpt-table-wrap">
          <table className="rpt-table">
            <thead>
              <tr>
                <SortTh label={breakdownLabel} k="label" sort={sort} onSort={toggleSort} align="left" />
                <SortTh label="Machines" k="machines" sort={sort} onSort={toggleSort} />
                <SortTh label="Spools" k="spools" sort={sort} onSort={toggleSort} />
                <SortTh label="Good ton" k="goodTon" sort={sort} onSort={toggleSort} />
                <SortTh label="Share" k="share" sort={sort} onSort={toggleSort} />
                <SortTh label="Availability" k="availability" sort={sort} onSort={toggleSort} />
                <SortTh label="OEE" k="oee" sort={sort} onSort={toggleSort} />
                <SortTh label="Downtime" k="downtimeMin" sort={sort} onSort={toggleSort} />
                <th className="rpt-left">Top downtime reason</th>
                <SortTh label="Man occ." k="avgOccupation" sort={sort} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((g) => {
                const s = oeeStatus(g.oee);
                return (
                  <tr key={g.key} className={focused ? '' : 'rpt-row-link'} onClick={() => focusGroup(g.key)}>
                    <td className="rpt-left rpt-cell-label" title={g.label}>{g.label}</td>
                    <td>{num(g.machines, 0)}</td>
                    <td>{num(g.spools, 0)}</td>
                    <td>{num(g.goodTon)}</td>
                    <td>
                      <span className="rpt-share">
                        <span className="rpt-share-bar" style={{ width: `${shareOf(g) * 100}%` }} />
                        <span>{pct(shareOf(g))}</span>
                      </span>
                    </td>
                    <td>{pct(g.availability)}</td>
                    <td>
                      <span className={`rpt-pill rpt-status-${s.key}`} title={s.label}>
                        <b aria-hidden="true">{s.icon}</b> {pct(g.oee)}
                      </span>
                    </td>
                    <td>{hours(g.downtimeMin)}</td>
                    <td className="rpt-left">
                      {g.topReason ? (
                        <>
                          <span className="rpt-swatch" style={{ background: reasonColor(g.topReason) }} />
                          {g.topReason}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{g.operators > 0 ? `${num(g.avgOccupation)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sortedGroups.length === 0 && <p className="rpt-empty">No rows match.</p>}
        </div>
        {sortedGroups.length > TABLE_PAGE && (
          <button type="button" className="btn btn-ghost rpt-more" onClick={() => setShowAllRows((v) => !v)}>
            {showAllRows ? `Show first ${TABLE_PAGE}` : `Show all ${sortedGroups.length} rows`}
          </button>
        )}
      </Panel>

      <section className="rpt-grid rpt-grid-occupation">
        <Panel title="Man occupation distribution" subtitle={`${scopeOperators.length} operators handling machines in scope`}>
          <div className="rpt-vbars">
            {bins.map((bin) => (
              <div
                key={bin.label}
                className="rpt-vbar-col"
                onMouseMove={(e) => showTip(e, <><b>{bin.label}</b><br />{bin.count} operator(s)</>)}
                onMouseLeave={hideTip}
              >
                <span className="rpt-vbar-value">{bin.count}</span>
                <span className="rpt-vbar-track">
                  <span className="rpt-vbar-fill" style={{ height: `${(bin.count / maxBin) * 100}%` }} />
                </span>
                <span className="rpt-vbar-label">{bin.label}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Operators"
          subtitle="Service · walking · idle share of available time"
          actions={
            <select className="input rpt-mini-select" value={operatorSort} onChange={(e) => setOperatorSort(e.target.value as 'occupation' | 'label')}>
              <option value="occupation">Sort: occupation</option>
              <option value="label">Sort: name</option>
            </select>
          }
        >
          <div className="rpt-legend">
            <span><span className="rpt-swatch" style={{ background: SERIES[0] }} />Service</span>
            <span><span className="rpt-swatch" style={{ background: SERIES[3] }} />Walking</span>
            <span><span className="rpt-swatch" style={{ background: OTHER_COLOR }} />Idle</span>
          </div>
          <div className="rpt-operator-list">
            {operatorRows.map((op) => {
              const base = op.availableMin || 1;
              return (
                <div
                  key={op.id}
                  className="rpt-operator-row"
                  onMouseMove={(e) =>
                    showTip(e, <><b>{op.label}</b> · {op.machineIds.length} machines<br />Service {hours(op.serviceMin)} · Walking {hours(op.walkingMin)} · Idle {hours(op.idleMin)}</>)
                  }
                  onMouseLeave={hideTip}
                >
                  <span className="rpt-operator-name">{op.label}</span>
                  <span className="rpt-stack">
                    <span className="rpt-stack-part" style={{ width: `${(op.serviceMin / base) * 100}%`, background: SERIES[0] }} />
                    <span className="rpt-stack-part" style={{ width: `${(op.walkingMin / base) * 100}%`, background: SERIES[3] }} />
                    <span className="rpt-stack-part" style={{ width: `${(op.idleMin / base) * 100}%`, background: OTHER_COLOR }} />
                  </span>
                  <span className="rpt-hbar-value">{num(op.occupation)}%</span>
                </div>
              );
            })}
            {operatorRows.length === 0 && <p className="rpt-empty">No operators in scope.</p>}
          </div>
        </Panel>
      </section>

      {tip && (
        <div className="rpt-tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }} role="tooltip">
          {tip.content}
        </div>
      )}
    </div>
  );
}

/** Top N bars by value, with the rest folded into one "Other" bar (never a generated extra hue). */
function foldOther(groups: ReportGroup[], value: (g: ReportGroup) => number) {
  const top = groups.slice(0, TOP_BARS).map((g) => ({ key: g.key, label: g.label, value: value(g), other: false }));
  const rest = groups.slice(TOP_BARS);
  if (rest.length > 0) {
    top.push({ key: '__other__', label: `Other (${rest.length})`, value: rest.reduce((s, g) => s + value(g), 0), other: true });
  }
  return top;
}

function Kpi({ label, value, note, hero = false }: { label: string; value: string; note?: ReactNode; hero?: boolean }) {
  return (
    <div className={`rpt-kpi${hero ? ' rpt-kpi-hero' : ''}`}>
      <span className="rpt-kpi-label">{label}</span>
      <strong className="rpt-kpi-value">{value}</strong>
      {note && <span className="rpt-kpi-note">{note}</span>}
    </div>
  );
}

function Panel({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rpt-panel">
      <div className="rpt-panel-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function SortTh({
  label,
  k,
  sort,
  onSort,
  align = 'right',
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === k;
  return (
    <th className={align === 'left' ? 'rpt-left' : undefined} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`rpt-sort${active ? ' active' : ''}`} onClick={() => onSort(k)}>
        {label}
        <span aria-hidden="true">{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );
}
