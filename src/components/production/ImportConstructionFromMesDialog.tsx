import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductionMachineAssignment, ProductionSetup } from '../../types';
import type { Mpp_wl_productses } from '../../generated/models/Mpp_wl_productsesModel';
import { loadActualOutputData, type ActualOutputRecord } from '../../lib/actualOutputCatalog';
import { updateMachineAssignments } from '../../lib/productionSetupsStore';
import { loadDefaultValuesOrBuiltIn } from '../../lib/defaultValuesStore';
import { Button } from '../ui/Button';
import { DateInput } from '../ui/Field';

interface ImportConstructionFromMesDialogProps {
  setup: ProductionSetup;
  products: Mpp_wl_productses[];
  onClose: () => void;
  onLocalChange: (patch: Partial<ProductionSetup>) => void;
  onSuccess: (message: string) => void;
}

function getYesterdayIso(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeKey(str: string): string {
  return str.trim().toLowerCase().replace(/\s+/g, '');
}

export function ImportConstructionFromMesDialog({
  setup,
  products,
  onClose,
  onLocalChange,
  onSuccess,
}: ImportConstructionFromMesDialogProps) {
  const [plant, setPlant] = useState('PTBI');
  const [date, setDate] = useState(getYesterdayIso);
  const [shift, setShift] = useState(1);

  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [stage, setStage] = useState<'idle' | 'querying' | 'processing' | 'saving' | 'complete'>('idle');
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initialize Plant from Setting Default Values
  useEffect(() => {
    let active = true;
    void loadDefaultValuesOrBuiltIn().then((defaults) => {
      if (active && defaults.frequencyPlant) {
        setPlant(defaults.frequencyPlant);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [loading, onClose]);

  const handleStartImport = async () => {
    if (!plant.trim() || !date) {
      setError('Please provide valid Plant Name and Date.');
      return;
    }

    setLoading(true);
    setError(null);
    setStage('querying');
    setStatusText(`Querying actual production output from Power BI (Plant: ${plant}, Date: ${date}, Shift ${shift})…`);

    try {
      // Step 1: Query Power BI via Power Automate flow WL_ActualOutput
      const { records } = await loadActualOutputData(
        { plant: plant.trim(), date, shift: Number(shift) },
        true,
      );

      if (!records || records.length === 0) {
        throw new Error(
          `No records found in MES for Plant "${plant}", Date "${date}", Shift ${shift}. Please ensure data exists in Power BI Semantic Model for this shift.`,
        );
      }

      // Step 2: Index records by machine name (highest volume wins if multiple)
      setStage('processing');
      setStatusText(`Processing ${records.length.toLocaleString()} MES records & matching layout machines…`);

      const recByMachine = new Map<string, ActualOutputRecord>();
      for (const rec of records) {
        const mach = rec.machineName?.trim().toLowerCase();
        if (!mach || !rec.constructionDetail) continue;
        const existing = recByMachine.get(mach);
        if (!existing) {
          recByMachine.set(mach, rec);
        } else {
          const existVol = existing.tonProduced ?? existing.totalProducedKG ?? 0;
          const newVol = rec.tonProduced ?? rec.totalProducedKG ?? 0;
          if (newVol > existVol) {
            recByMachine.set(mach, rec);
          }
        }
      }

      // Index WL_Products by normalized construction detail code
      const productByCode = new Map<string, Mpp_wl_productses>();
      for (const p of products) {
        if (p.mpp_constructiondetailcode) {
          productByCode.set(normalizeKey(p.mpp_constructiondetailcode), p);
        }
      }

      // Match machines from current setup layout
      const patchByMachineId = new Map<string, Partial<ProductionMachineAssignment>>();
      let matchedInCatalogCount = 0;
      let customLabelCount = 0;
      let noMesDataCount = 0;

      for (const machine of setup.layout) {
        const mLabel = machine.label?.trim().toLowerCase();
        const rec = recByMachine.get(mLabel);

        if (rec && rec.constructionDetail) {
          const patch: Partial<ProductionMachineAssignment> = {};
          const matchedProduct = productByCode.get(normalizeKey(rec.constructionDetail));

          if (matchedProduct) {
            patch.constructionDetailId = matchedProduct.mpp_wl_productsid;
            patch.constructionDetailLabel = matchedProduct.mpp_constructiondetailcode;
            matchedInCatalogCount++;
          } else {
            // Not in catalog, but keep exact MES ConstructionDetail label
            patch.constructionDetailLabel = rec.constructionDetail;
            customLabelCount++;
          }
          patchByMachineId.set(machine.id, patch);
        } else {
          noMesDataCount++;
        }
      }

      const changes = Array.from(patchByMachineId.entries()).map(([machineId, patch]) => ({
        machineId,
        patch,
      }));

      if (changes.length === 0) {
        throw new Error(
          `None of the ${setup.layout.length} machines in layout "${setup.name || 'Setup'}" were found in MES output for ${date} Shift ${shift}.`,
        );
      }

      // Step 3: Persist updates to Dataverse and local setup
      setStage('saving');
      setSaveProgress({ done: 0, total: changes.length });
      setStatusText(`Saving construction assignments to setup: 0 / ${changes.length}…`);

      // Apply locally first for immediate responsiveness
      onLocalChange({
        assignments: setup.assignments.map((a) =>
          patchByMachineId.has(a.machineId) ? { ...a, ...patchByMachineId.get(a.machineId) } : a,
        ),
      });

      await updateMachineAssignments(setup.id, changes, (done, total) => {
        setSaveProgress({ done, total });
        setStatusText(`Saving construction assignments: ${done} / ${total} machines (${Math.round((done / total) * 100)}%)…`);
      });

      setStage('complete');
      const successMsg = `Successfully imported Construction from MES for ${changes.length} machine(s) (${matchedInCatalogCount} matched with WL_Products catalog${customLabelCount > 0 ? `, ${customLabelCount} with raw MES codes` : ''}). ${noMesDataCount > 0 ? `${noMesDataCount} machine(s) had no MES activity.` : ''}`;
      onSuccess(successMsg);
      onClose();
    } catch (err) {
      console.error('Import from MES error:', err);
      const msg = err instanceof Error ? err.message : 'Failed to import Construction from MES.';
      setError(msg);
      setStage('idle');
      setLoading(false);
      setStatusText(null);
      setSaveProgress(null);
    }
  };

  const progressPercent = saveProgress
    ? Math.min(100, Math.round((saveProgress.done / saveProgress.total) * 100))
    : stage === 'querying'
    ? 25
    : stage === 'processing'
    ? 65
    : stage === 'complete'
    ? 100
    : 0;

  return createPortal(
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '20px',
      }}
      onClick={() => {
        if (!loading) onClose();
      }}
    >
      <div
        className="frequency-dax-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import Construction from MES"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '560px',
          background: '#0f172a',
          border: '1px solid #1e293b',
          borderRadius: '12px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.65)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #1e293b',
            background: '#0b1120',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <span
              style={{
                color: '#38bdf8',
                fontSize: '0.72rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              Power BI MES Integration
            </span>
            <h3 style={{ margin: '2px 0 0', fontSize: '1.2rem', color: '#f8fafc', fontWeight: 600 }}>
              📥 Import Construction from MES
            </h3>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            disabled={loading}
            title="Close dialog"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: '1.4rem',
              cursor: loading ? 'not-allowed' : 'pointer',
              padding: '4px 8px',
              borderRadius: '6px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.5 }}>
            Pilih parameter produksi aktual dari <strong>MES / Power BI Semantic Model</strong> (
            <code>WL_ActualOutput</code>). Aplikasi akan mencocokkan setiap mesin di layout dengan{' '}
            <strong>ConstructionDetail</strong> yang berjalan pada shift tersebut.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1.2fr 1fr',
              gap: '12px',
              background: '#0b1120',
              padding: '14px',
              borderRadius: '8px',
              border: '1px solid #1e293b',
            }}
          >
            {/* Plant */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>🏭 Plant Name</label>
              <input
                type="text"
                value={plant}
                onChange={(e) => setPlant(e.target.value)}
                disabled={loading}
                style={{
                  background: '#1e293b',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  borderRadius: '6px',
                  padding: '7px 10px',
                  fontSize: '0.88rem',
                  fontWeight: 600,
                  outline: 'none',
                }}
                placeholder="e.g. PTBI"
              />
            </div>

            {/* Date */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>
                📅 Production Date (H-1)
              </label>
              <DateInput
                value={date}
                onChange={(v) => setDate(v)}
                disabled={loading}
                className="frequency-date-input"
              />
            </div>

            {/* Shift */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>⏱️ Shift</label>
              <select
                value={shift}
                onChange={(e) => setShift(Number(e.target.value))}
                disabled={loading}
                style={{
                  background: '#1e293b',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  borderRadius: '6px',
                  padding: '7px 10px',
                  fontSize: '0.88rem',
                  cursor: 'pointer',
                  outline: 'none',
                }}
              >
                <option value={1}>Shift 1</option>
                <option value={2}>Shift 2</option>
                <option value={3}>Shift 3</option>
              </select>
            </div>
          </div>

          {/* Target Layout Summary */}
          <div
            style={{
              fontSize: '0.8rem',
              color: '#64748b',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <span>
              Target Setup: <strong style={{ color: '#cbd5e1' }}>{setup.name || 'Current Setup'}</strong>
            </span>
            <span>
              Total Layout Machines: <strong style={{ color: '#38bdf8' }}>{setup.layout.length}</strong>
            </span>
          </div>

          {/* Progress Bar Display */}
          {loading && (
            <div
              style={{
                background: '#0b1120',
                border: '1px solid #1e293b',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.84rem', color: '#38bdf8', fontWeight: 600 }}>
                  {stage === 'querying'
                    ? '⚡ Step 1/2: Querying Power BI Semantic Model…'
                    : stage === 'processing'
                    ? '🔍 Step 2/2: Matching Machines & Products…'
                    : '💾 Step 2/2: Saving Machine Assignments…'}
                </span>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                  {saveProgress ? `${saveProgress.done} / ${saveProgress.total}` : `${progressPercent}%`}
                </span>
              </div>

              {/* Progress Track */}
              <div
                style={{
                  width: '100%',
                  height: '8px',
                  background: '#1e293b',
                  borderRadius: '4px',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${progressPercent}%`,
                    background: 'linear-gradient(90deg, #38bdf8, #818cf8)',
                    borderRadius: '4px',
                    transition: 'width 0.25s ease',
                  }}
                />
              </div>

              <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{statusText}</span>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                padding: '12px 14px',
                color: '#fca5a5',
                fontSize: '0.82rem',
                lineHeight: 1.5,
              }}
            >
              <strong style={{ display: 'block', marginBottom: '2px', color: '#f87171' }}>
                ⚠️ Import Error:
              </strong>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid #1e293b',
            background: '#0b1120',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
          }}
        >
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleStartImport()}
            disabled={loading || !plant.trim() || !date}
          >
            {loading ? 'Importing…' : '⚡ Import & Apply from MES'}
          </Button>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
