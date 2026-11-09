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
  activityBreakdown?: TheoreticalActivityBreakdown | null;
  onClose: () => void;
  onSuccess: (result: {
    newOperators: ProductionOperator[];
    updatedAssignments: ProductionMachineAssignment[];
  }) => void;
}

export function AutoAssignOperatorsDialog({
  setup,
  activityBreakdown,
  onClose,
  onSuccess,
}: AutoAssignOperatorsDialogProps) {
  const [mode, setMode] = useState<AutoAssignMode>('multi');

  // Multi task state
  const rawMultiReq = activityBreakdown?.allTask.operators;
  const initialMultiCount = rawMultiReq
    ? Math.max(1, Math.ceil(rawMultiReq))
    : Math.max(1, setup.operators.length || 10);
  const [multiCount, setMultiCount] = useState<number>(initialMultiCount);
  const [multiPrefix, setMultiPrefix] = useState<string>('Opr');

  // Split task state
  const [splitPresetId, setSplitPresetId] = useState<SplitPresetId>('full_split');
  const [customGroups, setCustomGroups] = useState<TaskGroupConfig[]>(() => {
    return SPLIT_PRESETS[0].groups(activityBreakdown);
  });

  const [onlyPlanned, setOnlyPlanned] = useState<boolean>(true);

  // Execution state
  const [executing, setExecuting] = useState(false);
  const [progressState, setProgressState] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When preset changes in split mode, update groups
  const handlePresetChange = (presetId: SplitPresetId) => {
    setSplitPresetId(presetId);
    if (presetId !== 'custom') {
      const p = SPLIT_PRESETS.find((item) => item.id === presetId);
      if (p) {
        setCustomGroups(p.groups(activityBreakdown));
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
          onlyPlannedMachines: onlyPlanned,
        },
        activityBreakdown,
      });
    } catch {
      return null;
    }
  }, [setup, mode, multiCount, multiPrefix, splitPresetId, customGroups, onlyPlanned, activityBreakdown]);

  const totalMachinesAssigned = planPreview?.machineAssignments.size ?? 0;
  const totalOperatorsToCreate = planPreview?.operatorsToCreate.length ?? 0;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !executing) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [executing, onClose]);

  const handleRun = async () => {
    if (!planPreview || planPreview.operatorsToCreate.length === 0) return;
    if (
      !window.confirm(
        `Konfirmasi Auto Assign:\n` +
          `Akan meregenerasi ${totalOperatorsToCreate} operator baru dan mengalokasikan ${totalMachinesAssigned} mesin (berdasarkan pasangan TU berhadapan).\n\n` +
          `Operator lama pada setup ini akan digantikan. Lanjutkan?`,
      )
    ) {
      return;
    }

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
          onlyPlannedMachines: onlyPlanned,
        },
        activityBreakdown,
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
    <div className="modal-overlay om-detail-overlay" onClick={() => !executing && onClose()}>
      <div
        className="om-detail auto-assign-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Auto Assign Operator"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '620px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">Production Simulation Optimizer</span>
            <h3>✨ Auto Assign Operator</h3>
            <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
              Secara otomatis meregenerasi operator dan mengalokasikan mesin dengan memprioritaskan pasangan Take Up (TU) yang saling berhadapan.
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
          {/* Mode Selection */}
          <div>
            <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '8px' }}>
              1. Pilih Tipe Penugasan:
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
                  Setiap mesin dikerjakan oleh 1 operator untuk seluruh aktivitas (Doffing, Loading, Repair, Dies).
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
                  Tugas per mesin dibagi berdasarkan aktivitas spesifik (misal: Doffing terpisah dari Repair).
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

              {/* Group breakdown and counts */}
              <div style={{ marginTop: '8px' }}>
                <span style={{ fontSize: '0.76rem', fontWeight: 600, color: '#cbd5e1', display: 'block', marginBottom: '8px' }}>
                  Rincian Operator per Kelompok Tugas:
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
                  {customGroups.map((grp) => (
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
                          Tasks: {grp.tasks.map((t) => ALL_ACTIVITY_TASKS.find((a) => a.key === t)?.label ?? t).join(', ')}
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
                        <span style={{ fontSize: '0.72rem', color: '#94a3b8', marginLeft: '4px' }}>Jumlah:</span>
                        <input
                          type="number"
                          min={1}
                          max={200}
                          className="input"
                          style={{ width: '60px', padding: '2px 6px', height: '26px', fontSize: '0.75rem' }}
                          value={grp.count}
                          onChange={(e) => handleGroupCountChange(grp.id, Number(e.target.value) || 1)}
                          disabled={executing}
                        />
                      </div>
                    </div>
                  ))}
                </div>
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
            <strong>ℹ️ Pola Alokasi TU Berhadapan (Facing Take-Ups):</strong> Mesin dipasangkan dari atas dan bawah di lorong kerja yang sama sesuai urutan default Workload Simulator, sehingga tiap operator memegang blok mesin yang kompak tanpa harus berpindah lorong.
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
            {executing ? 'Sedang Memproses…' : `Terapkan Auto Assign (${totalOperatorsToCreate} Operator)`}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
