import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductionSetup, ProductionOperator, ProductionMachineAssignment } from '../../types';
import type { TheoreticalActivityBreakdown, TheoreticalOperatorRow } from '../../lib/theoreticalOperators';
import {
  type AutoAssignMode,
  type SplitPresetId,
  type TaskGroupConfig,
  SPLIT_PRESETS,
  ALL_ACTIVITY_TASKS,
  computeAutoAssignPlan,
  executeAutoAssign,
} from '../../lib/productionAutoAssign';
import { Button } from '../ui/Button';

interface AutoAssignOperatorsDialogProps {
  setup: ProductionSetup;
  targetScope?: 'selection' | 'all';
  selectedMachineIds?: string[];
  overallBreakdown?: TheoreticalActivityBreakdown | null;
  selectionBreakdown?: TheoreticalActivityBreakdown | null;
  operatorRequirementRows?: TheoreticalOperatorRow[];
  onClose: () => void;
  onSuccess: (result: {
    newOperators: ProductionOperator[];
    updatedAssignments: ProductionMachineAssignment[];
  }) => void;
}

export function AutoAssignOperatorsDialog({
  setup,
  targetScope = 'all',
  selectedMachineIds = [],
  overallBreakdown,
  selectionBreakdown,
  operatorRequirementRows,
  onClose,
  onSuccess,
}: AutoAssignOperatorsDialogProps) {
  const hasSelection = selectedMachineIds.length > 0;
  const [scope, setScope] = useState<'selection' | 'all'>(
    hasSelection && targetScope === 'selection' ? 'selection' : 'all',
  );

  const activeBreakdown = scope === 'selection'
    ? (selectionBreakdown ?? overallBreakdown)
    : overallBreakdown;

  const currentTargetMachineIds = useMemo(() => {
    return scope === 'selection' ? selectedMachineIds : undefined;
  }, [scope, selectedMachineIds]);

  const [mode, setMode] = useState<AutoAssignMode>('multi');

  // Multi task state
  const rawMultiReq = activeBreakdown?.allTask.operators;
  const initialMultiCount = rawMultiReq
    ? Math.max(1, Math.round(rawMultiReq))
    : Math.max(1, scope === 'selection' ? Math.round(selectedMachineIds.length / 10) : setup.operators.length || 10);
  const [multiCount, setMultiCount] = useState<number>(initialMultiCount);
  const [multiPrefix, setMultiPrefix] = useState<string>('Opr');

  useEffect(() => {
    if (rawMultiReq) {
      setMultiCount(Math.max(1, Math.round(rawMultiReq)));
    }
  }, [rawMultiReq]);

  // Split task state
  const [splitPresetId, setSplitPresetId] = useState<SplitPresetId>('three_groups_dlr');
  const [balanceFractional, setBalanceFractional] = useState<boolean>(true);
  const [splitGlobalPrefix, setSplitGlobalPrefix] = useState<string>('Opr');

  // Groups config
  const [customGroups, setCustomGroups] = useState<TaskGroupConfig[]>(() => {
    const p = SPLIT_PRESETS.find((item) => item.id === 'three_groups_dlr') ?? SPLIT_PRESETS[0];
    return p.groups(activeBreakdown);
  });

  // Split total count in balanced mode
  const rawSplitReq = useMemo(() => {
    if (!activeBreakdown) return undefined;
    const sum = activeBreakdown.activities.reduce((s, a) => s + (a.operators ?? 0), 0);
    return sum > 0 ? sum : activeBreakdown.allTask.operators;
  }, [activeBreakdown]);

  const [splitTotalCount, setSplitTotalCount] = useState<number>(() => {
    return rawSplitReq ? Math.max(1, Math.round(rawSplitReq)) : 6;
  });

  // Re-sync groups & counts when activeBreakdown or preset changes
  useEffect(() => {
    const p = SPLIT_PRESETS.find((item) => item.id === splitPresetId);
    if (p && splitPresetId !== 'custom') {
      const groups = p.groups(activeBreakdown);
      setCustomGroups(
        splitGlobalPrefix.trim()
          ? groups.map((g) => ({ ...g, prefix: splitGlobalPrefix.trim() }))
          : groups,
      );
    }
    if (rawSplitReq) {
      setSplitTotalCount(Math.max(1, Math.round(rawSplitReq)));
    }
  }, [splitPresetId, activeBreakdown, rawSplitReq]);

  const [onlyPlanned, setOnlyPlanned] = useState<boolean>(true);

  // Execution state
  const [executing, setExecuting] = useState(false);
  const [progressState, setProgressState] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePresetChange = (presetId: SplitPresetId) => {
    setSplitPresetId(presetId);
    if (presetId !== 'custom') {
      const p = SPLIT_PRESETS.find((item) => item.id === presetId);
      if (p) {
        const groups = p.groups(activeBreakdown);
        setCustomGroups(
          splitGlobalPrefix.trim()
            ? groups.map((g) => ({ ...g, prefix: splitGlobalPrefix.trim() }))
            : groups,
        );
      }
    }
  };

  const handleGlobalPrefixChange = (val: string) => {
    setSplitGlobalPrefix(val);
    setCustomGroups((prev) =>
      prev.map((g) => ({ ...g, prefix: val })),
    );
  };

  const handleGroupCountChange = (groupId: string, newCount: number) => {
    setCustomGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, count: Math.max(1, newCount) } : g)),
    );
  };

  const handleGroupPrefixChange = (groupId: string, newPrefix: string) => {
    setCustomGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, prefix: newPrefix } : g)),
    );
  };

  // Preview computation
  const planPreview = useMemo(() => {
    try {
      return computeAutoAssignPlan({
        setup,
        options: {
          mode,
          multiCount,
          multiPrefix,
          splitPresetId,
          taskGroups: customGroups,
          balanceFractionalDemand: balanceFractional,
          splitTotalCount: balanceFractional ? splitTotalCount : undefined,
          targetMachineIds: currentTargetMachineIds,
          onlyPlannedMachines: onlyPlanned,
          operatorRequirementRows,
        },
        activityBreakdown: activeBreakdown,
      });
    } catch {
      return null;
    }
  }, [
    setup,
    mode,
    multiCount,
    multiPrefix,
    splitPresetId,
    customGroups,
    balanceFractional,
    splitTotalCount,
    currentTargetMachineIds,
    onlyPlanned,
    operatorRequirementRows,
    activeBreakdown,
  ]);

  const totalMachinesAssigned = planPreview?.machineAssignments.size ?? 0;
  const totalOperatorsToCreate = planPreview?.operatorsToCreate.length ?? 0;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !executing) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [executing, onClose]);

  const handleRun = async () => {
    if (!planPreview || planPreview.operatorsToCreate.length === 0) return;

    setExecuting(true);
    setError(null);
    try {
      const result = await executeAutoAssign({
        setup,
        options: {
          mode,
          multiCount,
          multiPrefix,
          splitPresetId,
          taskGroups: customGroups,
          balanceFractionalDemand: balanceFractional,
          splitTotalCount: balanceFractional ? splitTotalCount : undefined,
          targetMachineIds: currentTargetMachineIds,
          onlyPlannedMachines: onlyPlanned,
          operatorRequirementRows,
        },
        activityBreakdown: activeBreakdown,
        onProgress: (phase, done, total) => {
          setProgressState({ phase, done, total });
        },
      });

      onSuccess(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute Auto Assign.');
      setExecuting(false);
      setProgressState(null);
    }
  };

  return createPortal(
    <div className="modal-overlay om-detail-overlay" style={{ zIndex: 1100 }} onClick={() => !executing && onClose()}>
      <div
        className="om-detail auto-assign-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Auto Assign Operator"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '640px', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">Production Simulation Optimizer</span>
            <h3>✨ Auto Assign Opr</h3>
            <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
              Automatically assign operators with facing Take-Up (TU) pair priority and compact machine routing.
            </p>
          </div>
          <button
            type="button"
            className="om-detail-close"
            onClick={onClose}
            disabled={executing}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Target Scope Switcher (if selection exists) */}
          {hasSelection && (
            <div>
              <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '6px' }}>
                Machine Scope:
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => !executing && setScope('selection')}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: `1.5px solid ${scope === 'selection' ? '#38bdf8' : '#334155'}`,
                    background: scope === 'selection' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(15, 23, 42, 0.4)',
                    color: scope === 'selection' ? '#38bdf8' : '#94a3b8',
                    cursor: executing ? 'default' : 'pointer',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                  }}
                >
                  <span>🎯 Selected Machines ({selectedMachineIds.length})</span>
                </button>
                <button
                  type="button"
                  onClick={() => !executing && setScope('all')}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: `1.5px solid ${scope === 'all' ? '#38bdf8' : '#334155'}`,
                    background: scope === 'all' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(15, 23, 42, 0.4)',
                    color: scope === 'all' ? '#38bdf8' : '#94a3b8',
                    cursor: executing ? 'default' : 'pointer',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                  }}
                >
                  <span>🌐 Entire Setup ({setup.layout.length})</span>
                </button>
              </div>
            </div>
          )}

          {/* Mode Selection */}
          <div>
            <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '8px' }}>
              Assignment Mode:
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div
                onClick={() => !executing && setMode('multi')}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  border: `2px solid ${mode === 'multi' ? '#38bdf8' : '#334155'}`,
                  background: mode === 'multi' ? 'rgba(56, 189, 248, 0.1)' : 'rgba(15, 23, 42, 0.6)',
                  cursor: executing ? 'default' : 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="radio"
                    name="assignMode"
                    checked={mode === 'multi'}
                    onChange={() => setMode('multi')}
                    disabled={executing}
                  />
                  <strong style={{ color: mode === 'multi' ? '#38bdf8' : '#f8fafc', fontSize: '0.88rem' }}>
                    Multi Task
                  </strong>
                </div>
                <span style={{ fontSize: '0.74rem', color: '#94a3b8', paddingLeft: '24px' }}>
                  Each machine is assigned to 1 operator for all activity tasks.
                </span>
              </div>

              <div
                onClick={() => !executing && setMode('split')}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  border: `2px solid ${mode === 'split' ? '#38bdf8' : '#334155'}`,
                  background: mode === 'split' ? 'rgba(56, 189, 248, 0.1)' : 'rgba(15, 23, 42, 0.6)',
                  cursor: executing ? 'default' : 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="radio"
                    name="assignMode"
                    checked={mode === 'split'}
                    onChange={() => setMode('split')}
                    disabled={executing}
                  />
                  <strong style={{ color: mode === 'split' ? '#38bdf8' : '#f8fafc', fontSize: '0.88rem' }}>
                    Split Task
                  </strong>
                </div>
                <span style={{ fontSize: '0.74rem', color: '#94a3b8', paddingLeft: '24px' }}>
                  Tasks are split by activity group (Doffing, Loading, Repairs, etc.).
                </span>
              </div>
            </div>
          </div>

          {/* Mode Configuration details */}
          {mode === 'multi' ? (
            <div
              style={{
                padding: '14px',
                background: '#0b1120',
                border: '1px solid #1e293b',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#f1f5f9' }}>
                  Multi Task Configuration:
                </span>
                {rawMultiReq && (
                  <span style={{ fontSize: '0.74rem', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.12)', padding: '2px 8px', borderRadius: '4px' }}>
                    Theoretical Required: {rawMultiReq.toFixed(2)} Opr
                  </span>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>
                    Operator Count:
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    className="input"
                    value={multiCount}
                    onChange={(e) => setMultiCount(Math.max(1, Number(e.target.value) || 1))}
                    disabled={executing}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>
                    Operator Prefix:
                  </label>
                  <input
                    type="text"
                    className="input"
                    value={multiPrefix}
                    placeholder="e.g. Opr"
                    onChange={(e) => setMultiPrefix(e.target.value)}
                    disabled={executing}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{
                padding: '14px',
                background: '#0b1120',
                border: '1px solid #1e293b',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <label style={{ fontSize: '0.82rem', fontWeight: 600, color: '#f1f5f9' }}>
                Split Task Preset:
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {SPLIT_PRESETS.map((preset) => (
                  <div
                    key={preset.id}
                    onClick={() => !executing && handlePresetChange(preset.id)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '6px',
                      border: `1px solid ${splitPresetId === preset.id ? '#38bdf8' : '#334155'}`,
                      background: splitPresetId === preset.id ? 'rgba(56, 189, 248, 0.08)' : 'rgba(15, 23, 42, 0.4)',
                      cursor: executing ? 'default' : 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="radio"
                        name="splitPreset"
                        checked={splitPresetId === preset.id}
                        onChange={() => handlePresetChange(preset.id)}
                        disabled={executing}
                      />
                      <strong style={{ color: splitPresetId === preset.id ? '#38bdf8' : '#f8fafc', fontSize: '0.82rem' }}>
                        {preset.label}
                      </strong>
                    </div>
                    <p style={{ margin: '3px 0 0 24px', fontSize: '0.72rem', color: '#94a3b8' }}>
                      {preset.description}
                    </p>
                  </div>
                ))}
              </div>

              {/* Fractional Demand Balancing Toggle */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '10px 12px',
                  background: 'rgba(56, 189, 248, 0.06)',
                  borderRadius: '6px',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                }}
              >
                <input
                  type="checkbox"
                  id="chkBalanceFractional"
                  checked={balanceFractional}
                  onChange={(e) => setBalanceFractional(e.target.checked)}
                  disabled={executing}
                  style={{ marginTop: '3px', cursor: 'pointer' }}
                />
                <div style={{ flex: 1 }}>
                  <label htmlFor="chkBalanceFractional" style={{ fontSize: '0.82rem', fontWeight: 600, color: '#f1f5f9', cursor: 'pointer', display: 'block' }}>
                    ⚡ Optimize Fractional Workload (Operator Balancing)
                  </label>
                  <span style={{ fontSize: '0.73rem', color: '#94a3b8', lineHeight: 1.45, display: 'block', marginTop: '2px' }}>
                    Reallocates fractional activity demands (&lt; 1.0 person, e.g. 0.5 Doffing) to operators with spare capacity to match theoretical demand without excess headcount.
                  </span>
                </div>
              </div>

              {/* Total Operator target when balanced */}
              {balanceFractional ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: '#1e293b',
                    borderRadius: '6px',
                  }}
                >
                  <div>
                    <strong style={{ fontSize: '0.82rem', color: '#f8fafc', display: 'block' }}>
                      Target Total Operators:
                    </strong>
                    {rawSplitReq !== undefined && (
                      <span style={{ fontSize: '0.74rem', color: '#38bdf8' }}>
                        Theoretical Required: {rawSplitReq.toFixed(2)} ops
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      className="input"
                      style={{ width: '65px', textAlign: 'center', fontWeight: 'bold', fontSize: '0.9rem' }}
                      value={splitTotalCount}
                      onChange={(e) => setSplitTotalCount(Math.max(1, Number(e.target.value) || 1))}
                      disabled={executing}
                    />
                    <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>Operators</span>
                  </div>
                </div>
              ) : null}

              {/* Group breakdown and counts */}
              <div style={{ marginTop: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
                  <span style={{ fontSize: '0.76rem', fontWeight: 600, color: '#cbd5e1' }}>
                    Task Groups & Prefixes:
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <label style={{ fontSize: '0.74rem', color: '#38bdf8', fontWeight: 500 }}>
                      Global Prefix:
                    </label>
                    <input
                      className="input"
                      style={{ width: '80px', padding: '2px 8px', height: '26px', fontSize: '0.75rem' }}
                      placeholder="e.g. Opr"
                      value={splitGlobalPrefix}
                      onChange={(e) => handleGlobalPrefixChange(e.target.value)}
                      disabled={executing}
                      title="Changing this prefix updates all task groups below"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
                  {customGroups.map((grp) => {
                    const req = grp.tasks.reduce((sum, taskKey) => {
                      const act = activeBreakdown?.activities.find((a) => a.key === taskKey);
                      return sum + (act?.operators ?? 0);
                    }, 0);
                    return (
                      <div
                        key={grp.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                          padding: '6px 10px',
                          background: '#1e293b',
                          borderRadius: '6px',
                          fontSize: '0.78rem',
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <strong style={{ color: '#f1f5f9', display: 'block' }}>{grp.name}</strong>
                          <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                            {req > 0 ? `Theoretical: ${req.toFixed(2)} ops · ` : ''}
                            {grp.tasks.map((t) => ALL_ACTIVITY_TASKS.find((a) => a.key === t)?.label ?? t).join(', ')}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Prefix:</span>
                          <input
                            className="input"
                            style={{ width: '70px', padding: '2px 6px', height: '26px', fontSize: '0.75rem' }}
                            value={grp.prefix}
                            onChange={(e) => handleGroupPrefixChange(grp.id, e.target.value)}
                            disabled={executing}
                          />
                          {!balanceFractional && (
                            <>
                              <span style={{ fontSize: '0.72rem', color: '#94a3b8', marginLeft: '4px' }}>Count:</span>
                              <input
                                type="number"
                                min={1}
                                max={200}
                                className="input"
                                style={{ width: '55px', padding: '2px 6px', height: '26px', fontSize: '0.75rem' }}
                                value={grp.count}
                                onChange={(e) => handleGroupCountChange(grp.id, Number(e.target.value) || 1)}
                                disabled={executing}
                              />
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Allocation Strategy Info */}
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '6px',
              background: 'rgba(56, 189, 248, 0.08)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              fontSize: '0.76rem',
              color: '#bae6fd',
              lineHeight: 1.45,
            }}
          >
            <strong>ℹ️ Facing TU Allocation:</strong> Machines are ordered in facing Take-Up (TU) pairs along the working aisle in a continuous serpentine path, ensuring each operator handles a compact, contiguous machine block without walking back and forth.
          </div>

          {/* Preview of Operators to be Generated */}
          {planPreview && planPreview.operatorsToCreate.length > 0 && (
            <div style={{ padding: '10px 12px', background: '#0b1120', border: '1px solid #1e293b', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '0.76rem', fontWeight: 600, color: '#f1f5f9' }}>
                  Operator Preview ({planPreview.operatorsToCreate.length} operators for {totalMachinesAssigned} machines):
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '100px', overflowY: 'auto' }}>
                {planPreview.operatorsToCreate.map((op, idx) => (
                  <span
                    key={`${op.label}-${idx}`}
                    style={{
                      fontSize: '0.72rem',
                      background: '#1e293b',
                      color: '#e2e8f0',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      border: '1px solid #334155',
                    }}
                    title={op.description}
                  >
                    {op.label}
                    {op.description ? <span style={{ color: '#94a3b8', marginLeft: '4px' }}>({op.description})</span> : ''}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Scope Options */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }}>
            <input
              type="checkbox"
              id="chkOnlyPlanned"
              checked={onlyPlanned}
              onChange={(e) => setOnlyPlanned(e.target.checked)}
              disabled={executing}
              style={{ cursor: 'pointer' }}
            />
            <label htmlFor="chkOnlyPlanned" style={{ fontSize: '0.78rem', color: '#cbd5e1', cursor: 'pointer' }}>
              Only assign planned machines (machines with a Construction Detail assigned).
            </label>
          </div>

          {/* Execution Progress */}
          {progressState && (
            <div style={{ padding: '10px', background: '#0b1120', borderRadius: '6px', border: '1px solid #334155' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#38bdf8', marginBottom: '4px' }}>
                <span>{progressState.phase}</span>
                {progressState.total > 0 && (
                  <span>{progressState.done} / {progressState.total}</span>
                )}
              </div>
              <div style={{ width: '100%', height: '6px', background: '#1e293b', borderRadius: '3px', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    background: '#38bdf8',
                    transition: 'width 0.2s ease',
                    width: progressState.total > 0 ? `${(progressState.done / progressState.total) * 100}%` : '100%',
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="construction-selector-error" style={{ margin: 0 }}>
              {error}
            </p>
          )}
        </div>

        <div className="operator-start-actions" style={{ borderTop: '1px solid #1e293b', paddingTop: '12px' }}>
          <Button variant="ghost" onClick={onClose} disabled={executing}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleRun} disabled={executing || totalOperatorsToCreate === 0}>
            {executing ? 'Processing…' : `Apply Auto Assign Opr (${totalOperatorsToCreate} Operators)`}
          </Button>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
