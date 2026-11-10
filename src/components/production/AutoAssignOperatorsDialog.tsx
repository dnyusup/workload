import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductionSetup, ProductionOperator, ProductionMachineAssignment } from '../../types';
import type { TheoreticalActivityBreakdown } from '../../lib/theoreticalOperators';
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
    ? Math.max(1, Math.ceil(rawMultiReq))
    : Math.max(1, scope === 'selection' ? Math.ceil(selectedMachineIds.length / 10) : setup.operators.length || 10);
  const [multiCount, setMultiCount] = useState<number>(initialMultiCount);
  const [multiPrefix, setMultiPrefix] = useState<string>('Opr');

  // Split task state
  const [splitPresetId, setSplitPresetId] = useState<SplitPresetId>('three_groups_dlr');
  const [balanceFractional, setBalanceFractional] = useState<boolean>(true);

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
    return rawSplitReq ? Math.max(1, Math.ceil(rawSplitReq)) : 6;
  });

  // Re-sync groups & counts when activeBreakdown or preset changes
  useEffect(() => {
    const p = SPLIT_PRESETS.find((item) => item.id === splitPresetId);
    if (p && splitPresetId !== 'custom') {
      setCustomGroups(p.groups(activeBreakdown));
    }
    if (rawSplitReq) {
      setSplitTotalCount(Math.max(1, Math.ceil(rawSplitReq)));
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
        setCustomGroups(p.groups(activeBreakdown));
      }
    }
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
        },
        activityBreakdown: activeBreakdown,
        onProgress: (phase, done, total) => {
          setProgressState({ phase, done, total });
        },
      });

      onSuccess(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menjalankan Auto Assign.');
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
              Alokasikan operator otomatis dengan prioritas pasangan Take Up (TU) saling berhadapan.
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
                Cakupan Mesin:
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
                  <span>🎯 Mesin Terpilih ({selectedMachineIds.length})</span>
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
                  <span>🌐 Seluruh Setup ({setup.layout.length})</span>
                </button>
              </div>
            </div>
          )}

          {/* Mode Selection */}
          <div>
            <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '8px' }}>
              Pilih Tipe Penugasan:
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
                  Setiap mesin dikerjakan oleh 1 operator untuk seluruh aktivitas.
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
                  Tugas dibagi per kelompok aktivitas (Doffing, Loading, Fracture+Defect).
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
                  Konfigurasi Multi Task:
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
                    Jumlah Operator yang Dibuat:
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
                    Prefix Nama Operator:
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
                Pilih Pola Pembagian Split Task (Optimal Preset):
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
                    ⚡ Optimalkan Beban Pecahan (Operator Balancing)
                  </label>
                  <span style={{ fontSize: '0.73rem', color: '#94a3b8', lineHeight: 1.45, display: 'block', marginTop: '2px' }}>
                    Mengalihkan sisa kebutuhan aktivitas pecahan (&lt; 1.0 orang, misal 0.5 Doffing) ke operator lain yang masih kekurangan mesin, sehingga total operator sesuai kebutuhan teoritis tanpa membengkak.
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
                      Target Total Operator:
                    </strong>
                    {rawSplitReq !== undefined && (
                      <span style={{ fontSize: '0.74rem', color: '#38bdf8' }}>
                        Kebutuhan Teoritis: {rawSplitReq.toFixed(2)} orang
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
                    <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>Operator</span>
                  </div>
                </div>
              ) : null}

              {/* Group breakdown and counts */}
              <div style={{ marginTop: '4px' }}>
                <span style={{ fontSize: '0.76rem', fontWeight: 600, color: '#cbd5e1', display: 'block', marginBottom: '8px' }}>
                  Rincian Kelompok Tugas & Prefix:
                </span>
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
                            {req > 0 ? `Teoritis: ${req.toFixed(2)} orang · ` : ''}
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
                              <span style={{ fontSize: '0.72rem', color: '#94a3b8', marginLeft: '4px' }}>Jumlah:</span>
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
            <strong>ℹ️ Pola Alokasi TU Berhadapan:</strong> Mesin diurutkan berpasangan Take-Up (TU) atas dan bawah sepanjang lorong kerja, sehingga setiap operator memegang blok mesin yang kompak tanpa harus bolak-balik lorong.
          </div>

          {/* Preview of Operators to be Generated */}
          {planPreview && planPreview.operatorsToCreate.length > 0 && (
            <div style={{ padding: '10px 12px', background: '#0b1120', border: '1px solid #1e293b', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '0.76rem', fontWeight: 600, color: '#f1f5f9' }}>
                  Preview Operator ({planPreview.operatorsToCreate.length} orang untuk {totalMachinesAssigned} mesin):
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
              Hanya alokasikan mesin yang terencana (sudah memiliki Construction Detail).
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
            Batal
          </Button>
          <Button variant="primary" onClick={handleRun} disabled={executing || totalOperatorsToCreate === 0}>
            {executing ? 'Sedang Memproses…' : `Terapkan Auto Assign Opr (${totalOperatorsToCreate} Operator)`}
          </Button>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
