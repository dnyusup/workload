import { useEffect, useMemo, useState } from 'react';
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

interface MatchedItem {
  machineId: string;
  machineLabel: string;
  currentLabel: string;
  mesConstruction: string;
  product: Mpp_wl_productses;
  volumeKG: number;
}

interface UnmatchedCatalogItem {
  machineId: string;
  machineLabel: string;
  currentLabel: string;
  mesConstruction: string;
  volumeKG: number;
}

interface NoActivityItem {
  machineId: string;
  machineLabel: string;
  currentLabel: string;
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
  return str.trim().toLowerCase().replace(/[\s\-_]/g, '');
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

  const [stage, setStage] = useState<'params' | 'querying' | 'processing' | 'preview' | 'saving' | 'complete'>('params');
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Analysis result state
  const [matchedItems, setMatchedItems] = useState<MatchedItem[]>([]);
  const [unmatchedCatalog, setUnmatchedCatalog] = useState<UnmatchedCatalogItem[]>([]);
  const [noActivity, setNoActivity] = useState<NoActivityItem[]>([]);
  const [activeTab, setActiveTab] = useState<'matched' | 'unmatched' | 'noActivity'>('matched');
  const [filterSearch, setFilterSearch] = useState('');
  const [copied, setCopied] = useState(false);

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
      if (e.key === 'Escape' && !loading && stage !== 'saving') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [loading, stage, onClose]);

  // Lookup map for current setup assignments
  const assignmentByMachineId = useMemo(() => {
    const map = new Map<string, ProductionMachineAssignment>();
    for (const a of setup.assignments) {
      map.set(a.machineId, a);
    }
    return map;
  }, [setup.assignments]);

  // Lookup map for products catalog
  const { productByExact, productByNormalized } = useMemo(() => {
    const exact = new Map<string, Mpp_wl_productses>();
    const norm = new Map<string, Mpp_wl_productses>();
    for (const p of products) {
      if (p.mpp_constructiondetailcode) {
        const raw = p.mpp_constructiondetailcode.trim();
        exact.set(raw.toLowerCase(), p);
        norm.set(normalizeKey(raw), p);
      }
    }
    return { productByExact: exact, productByNormalized: norm };
  }, [products]);

  // Step 1: Query Power BI & Analyze Matching
  const handleFetchAndAnalyze = async () => {
    if (!plant.trim() || !date) {
      setError('Mohon masukkan nama Plant dan Tanggal yang valid.');
      return;
    }

    setLoading(true);
    setError(null);
    setStage('querying');
    setStatusText(`Menghubungi Power BI Semantic Model (Plant: ${plant}, Date: ${date}, Shift: ${shift})…`);

    try {
      const { records } = await loadActualOutputData(
        { plant: plant.trim(), date, shift: Number(shift) },
        true,
      );

      if (!records || records.length === 0) {
        throw new Error(
          `Tidak ditemukan data aktual di MES untuk Plant "${plant}", Tanggal "${date}", Shift ${shift}. Pastikan semantic model Power BI telah ter-refresh dan data tersedia.`,
        );
      }

      setStage('processing');
      setStatusText(`Menganalisis ${records.length.toLocaleString()} record MES dan mencocokkan dengan ${setup.layout.length} mesin layout…`);

      // Index records by machine name (highest volume wins if multiple)
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

      const matched: MatchedItem[] = [];
      const missingCatalog: UnmatchedCatalogItem[] = [];
      const noAct: NoActivityItem[] = [];

      for (const machine of setup.layout) {
        const mLabel = (machine.label || machine.id).trim();
        const currentAssign = assignmentByMachineId.get(machine.id);
        const currentLabel = currentAssign?.constructionDetailLabel || '—';

        const rec = recByMachine.get(mLabel.toLowerCase());
        if (rec && rec.constructionDetail?.trim()) {
          const mesCode = rec.constructionDetail.trim();
          const vol = rec.totalProducedKG ?? (rec.tonProduced ? rec.tonProduced * 1000 : 0);

          const matchedProd =
            productByExact.get(mesCode.toLowerCase()) ??
            productByNormalized.get(normalizeKey(mesCode));

          if (matchedProd) {
            matched.push({
              machineId: machine.id,
              machineLabel: mLabel,
              currentLabel,
              mesConstruction: mesCode,
              product: matchedProd,
              volumeKG: vol,
            });
          } else {
            // Ada di MES tapi belum terdaftar di WL_Products
            missingCatalog.push({
              machineId: machine.id,
              machineLabel: mLabel,
              currentLabel,
              mesConstruction: mesCode,
              volumeKG: vol,
            });
          }
        } else {
          // Tidak ada output aktual di MES untuk shift ini
          noAct.push({
            machineId: machine.id,
            machineLabel: mLabel,
            currentLabel,
          });
        }
      }

      setMatchedItems(matched);
      setUnmatchedCatalog(missingCatalog);
      setNoActivity(noAct);

      // Default active tab to missingCatalog if any exists so user immediately sees the warning log
      if (missingCatalog.length > 0) {
        setActiveTab('unmatched');
      } else {
        setActiveTab('matched');
      }

      setStage('preview');
      setLoading(false);
      setStatusText(null);
    } catch (err) {
      console.error('Fetch MES error:', err);
      const msg = err instanceof Error ? err.message : 'Gagal mengambil data dari Power BI MES.';
      setError(msg);
      setStage('params');
      setLoading(false);
      setStatusText(null);
    }
  };

  // Step 2: Apply matched assignments to Dataverse & local state
  const handleApplyImport = async () => {
    if (matchedItems.length === 0) {
      setError('Tidak ada mesin yang cocok dengan katalog WL_Products untuk di-import.');
      return;
    }

    setLoading(true);
    setError(null);
    setStage('saving');
    setSaveProgress({ done: 0, total: matchedItems.length });
    setStatusText(`Menyimpan perubahan Construction ke setup: 0 / ${matchedItems.length}…`);

    try {
      // Create pure construction-only patches
      // Kolom lain (operator, group, doffPriority) TIDAK disertakan dalam patch sehingga tidak tersentuh!
      const patchByMachineId = new Map<string, Partial<ProductionMachineAssignment>>();
      for (const item of matchedItems) {
        patchByMachineId.set(item.machineId, {
          constructionDetailId: item.product.mpp_wl_productsid,
          constructionDetailLabel: item.product.mpp_constructiondetailcode,
        });
      }

      // Update local setup state:
      // Menggabungkan patch HANYA pada constructionDetailId & constructionDetailLabel
      // Semua property lainnya (...a) tetap utuh!
      onLocalChange({
        assignments: setup.assignments.map((a) =>
          patchByMachineId.has(a.machineId)
            ? { ...a, ...patchByMachineId.get(a.machineId) }
            : a,
        ),
      });

      const changes = Array.from(patchByMachineId.entries()).map(([machineId, patch]) => ({
        machineId,
        patch,
      }));

      // Update Dataverse
      await updateMachineAssignments(setup.id, changes, (done, total) => {
        setSaveProgress({ done, total });
        setStatusText(`Menyimpan Construction ke Dataverse: ${done} / ${total} mesin (${Math.round((done / total) * 100)}%)…`);
      });

      setStage('complete');
      const skippedInfo =
        unmatchedCatalog.length > 0
          ? ` (${unmatchedCatalog.length} mesin dengan kode MES belum terdaftar di WL_Products dilewati agar tidak blank)`
          : '';
      const successMsg = `Berhasil meng-import Construction dari MES untuk ${matchedItems.length} mesin.${skippedInfo}`;
      onSuccess(successMsg);
      onClose();
    } catch (err) {
      console.error('Save import error:', err);
      const msg = err instanceof Error ? err.message : 'Gagal menyimpan perubahan ke Dataverse.';
      setError(msg);
      setStage('preview');
      setLoading(false);
      setStatusText(null);
      setSaveProgress(null);
    }
  };

  // Copy missing construction detail codes to clipboard
  const handleCopyMissingCodes = async () => {
    const uniqueCodes = Array.from(new Set(unmatchedCatalog.map((u) => u.mesConstruction))).sort();
    if (uniqueCodes.length === 0) return;
    try {
      await navigator.clipboard.writeText(uniqueCodes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback if clipboard API is restricted
      const textarea = document.createElement('textarea');
      textarea.value = uniqueCodes.join('\n');
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const uniqueMissingCodesCount = useMemo(() => {
    return new Set(unmatchedCatalog.map((u) => u.mesConstruction)).size;
  }, [unmatchedCatalog]);

  const progressPercent = saveProgress
    ? Math.min(100, Math.round((saveProgress.done / saveProgress.total) * 100))
    : stage === 'querying'
    ? 30
    : stage === 'processing'
    ? 75
    : stage === 'complete'
    ? 100
    : 0;

  // Filtered lists for the active tab based on search query
  const query = filterSearch.trim().toLowerCase();
  const filteredMatched = useMemo(() => {
    if (!query) return matchedItems;
    return matchedItems.filter(
      (m) =>
        m.machineLabel.toLowerCase().includes(query) ||
        m.currentLabel.toLowerCase().includes(query) ||
        m.mesConstruction.toLowerCase().includes(query),
    );
  }, [matchedItems, query]);

  const filteredUnmatched = useMemo(() => {
    if (!query) return unmatchedCatalog;
    return unmatchedCatalog.filter(
      (m) =>
        m.machineLabel.toLowerCase().includes(query) ||
        m.currentLabel.toLowerCase().includes(query) ||
        m.mesConstruction.toLowerCase().includes(query),
    );
  }, [unmatchedCatalog, query]);

  const filteredNoAct = useMemo(() => {
    if (!query) return noActivity;
    return noActivity.filter(
      (m) =>
        m.machineLabel.toLowerCase().includes(query) ||
        m.currentLabel.toLowerCase().includes(query),
    );
  }, [noActivity, query]);

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
        if (!loading && stage !== 'saving') onClose();
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
          maxWidth: '820px',
          maxHeight: '90vh',
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
            disabled={loading || stage === 'saving'}
            title="Close dialog"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: '1.4rem',
              cursor: loading || stage === 'saving' ? 'not-allowed' : 'pointer',
              padding: '4px 8px',
              borderRadius: '6px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            overflowY: 'auto',
            flex: 1,
          }}
        >
          {/* Parameter Filters Bar */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1.3fr 1fr auto',
              gap: '12px',
              background: '#0b1120',
              padding: '12px 14px',
              borderRadius: '8px',
              border: '1px solid #1e293b',
              alignItems: 'end',
            }}
          >
            {/* Plant */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>🏭 Plant Name</label>
              <input
                type="text"
                value={plant}
                onChange={(e) => setPlant(e.target.value)}
                disabled={loading || stage === 'saving'}
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
                disabled={loading || stage === 'saving'}
                className="frequency-date-input"
              />
            </div>

            {/* Shift */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>⏱️ Shift</label>
              <select
                value={shift}
                onChange={(e) => setShift(Number(e.target.value))}
                disabled={loading || stage === 'saving'}
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

            {/* Fetch Button if still in params or want to re-fetch */}
            <div>
              <Button
                variant="primary"
                onClick={() => void handleFetchAndAnalyze()}
                disabled={loading || stage === 'saving' || !plant.trim() || !date}
                title="Tarik data aktual dari Power BI dan lakukan pencocokan"
                style={{ height: '36px', whiteSpace: 'nowrap' }}
              >
                {loading && (stage === 'querying' || stage === 'processing')
                  ? 'Menganalisis…'
                  : '🔍 Fetch & Match'}
              </Button>
            </div>
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
                    ? '⚡ Langkah 1/2: Menghubungi Power BI Semantic Model…'
                    : stage === 'processing'
                    ? '🔍 Langkah 2/2: Mencocokkan Mesin & Katalog WL_Products…'
                    : '💾 Menyimpan Perubahan Construction ke Dataverse…'}
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
                ⚠️ Terjadi Kendala:
              </strong>
              {error}
            </div>
          )}

          {/* PREVIEW & LOG STAGE */}
          {stage === 'preview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {/* Summary Metric Cards */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: '10px',
                }}
              >
                {/* Matched */}
                <div
                  onClick={() => setActiveTab('matched')}
                  style={{
                    background: activeTab === 'matched' ? 'rgba(34, 197, 94, 0.12)' : '#0b1120',
                    border: `1px solid ${activeTab === 'matched' ? '#22c55e' : '#1e293b'}`,
                    borderRadius: '8px',
                    padding: '10px 12px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <span style={{ fontSize: '0.72rem', color: '#86efac', fontWeight: 600, display: 'block' }}>
                    ✅ Cocok di Katalog
                  </span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f0fdf4', margin: '2px 0' }}>
                    {matchedItems.length}
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Siap di-update</span>
                </div>

                {/* Missing in Catalog */}
                <div
                  onClick={() => setActiveTab('unmatched')}
                  style={{
                    background: activeTab === 'unmatched' ? 'rgba(239, 68, 68, 0.12)' : '#0b1120',
                    border: `1px solid ${activeTab === 'unmatched' ? '#ef4444' : unmatchedCatalog.length > 0 ? '#b91c1c' : '#1e293b'}`,
                    borderRadius: '8px',
                    padding: '10px 12px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <span style={{ fontSize: '0.72rem', color: '#fca5a5', fontWeight: 600, display: 'block' }}>
                    ⚠️ Belum di WL_Products
                  </span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#fef2f2', margin: '2px 0' }}>
                    {unmatchedCatalog.length}
                  </div>
                  <span style={{ fontSize: '0.7rem', color: unmatchedCatalog.length > 0 ? '#f87171' : '#94a3b8' }}>
                    {unmatchedCatalog.length > 0 ? 'Dilewati (Tidak blank)' : 'Semua terdaftar'}
                  </span>
                </div>

                {/* No Activity */}
                <div
                  onClick={() => setActiveTab('noActivity')}
                  style={{
                    background: activeTab === 'noActivity' ? 'rgba(148, 163, 184, 0.12)' : '#0b1120',
                    border: `1px solid ${activeTab === 'noActivity' ? '#94a3b8' : '#1e293b'}`,
                    borderRadius: '8px',
                    padding: '10px 12px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <span style={{ fontSize: '0.72rem', color: '#cbd5e1', fontWeight: 600, display: 'block' }}>
                    ℹ️ Tanpa Aktivitas MES
                  </span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc', margin: '2px 0' }}>
                    {noActivity.length}
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Mesin tidak berjalan</span>
                </div>

                {/* Total Layout Machines */}
                <div
                  style={{
                    background: '#0b1120',
                    border: '1px solid #1e293b',
                    borderRadius: '8px',
                    padding: '10px 12px',
                  }}
                >
                  <span style={{ fontSize: '0.72rem', color: '#38bdf8', fontWeight: 600, display: 'block' }}>
                    🏢 Total Mesin Layout
                  </span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f0f9ff', margin: '2px 0' }}>
                    {setup.layout.length}
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{setup.name || 'Setup'}</span>
                </div>
              </div>

              {/* Safety Assurance Notice */}
              <div
                style={{
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '0.76rem',
                  color: '#bae6fd',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <span>🔒</span>
                <span>
                  <strong>Aman & Terisolasi:</strong> Proses import ini <u>hanya</u> meng-update kolom <strong>Construction</strong>. Data operator, group, doff priority, dan kolom penugasan lainnya <strong>tetap utuh 100%</strong> dan tidak terpengaruh sama sekali.
                </span>
              </div>

              {/* Tabs Bar */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  borderBottom: '1px solid #1e293b',
                  paddingBottom: '8px',
                }}
              >
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setActiveTab('matched')}
                    style={{
                      background: activeTab === 'matched' ? '#1e293b' : 'transparent',
                      border: 'none',
                      color: activeTab === 'matched' ? '#4ade80' : '#94a3b8',
                      fontWeight: 600,
                      fontSize: '0.82rem',
                      padding: '6px 12px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    ✅ Siap Di-update ({matchedItems.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('unmatched')}
                    style={{
                      background: activeTab === 'unmatched' ? '#1e293b' : 'transparent',
                      border: 'none',
                      color: activeTab === 'unmatched' ? '#f87171' : unmatchedCatalog.length > 0 ? '#fb7185' : '#94a3b8',
                      fontWeight: 600,
                      fontSize: '0.82rem',
                      padding: '6px 12px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    ⚠️ Gagal Lookup ({unmatchedCatalog.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('noActivity')}
                    style={{
                      background: activeTab === 'noActivity' ? '#1e293b' : 'transparent',
                      border: 'none',
                      color: activeTab === 'noActivity' ? '#e2e8f0' : '#94a3b8',
                      fontWeight: 600,
                      fontSize: '0.82rem',
                      padding: '6px 12px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    ℹ️ Tanpa Aktivitas MES ({noActivity.length})
                  </button>
                </div>

                {/* Filter Search */}
                <input
                  type="text"
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                  placeholder="Cari mesin / produk…"
                  style={{
                    background: '#1e293b',
                    border: '1px solid #334155',
                    color: '#f8fafc',
                    borderRadius: '6px',
                    padding: '4px 10px',
                    fontSize: '0.78rem',
                    width: '180px',
                    outline: 'none',
                  }}
                />
              </div>

              {/* TAB 1: UNMATCHED / FAILED LOOKUP LOG */}
              {activeTab === 'unmatched' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {unmatchedCatalog.length > 0 ? (
                    <>
                      <div
                        style={{
                          background: 'rgba(239, 68, 68, 0.08)',
                          border: '1px solid rgba(239, 68, 68, 0.25)',
                          borderRadius: '8px',
                          padding: '10px 14px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '12px',
                        }}
                      >
                        <div style={{ fontSize: '0.8rem', color: '#fca5a5', lineHeight: 1.4 }}>
                          <strong>⚠️ Mengapa data tidak otomatis diisi?</strong>
                          <br />
                          Kode ConstructionDetail dari MES berikut <strong>belum terdaftar</strong> di katalog master <code>WL_Products</code>. Agar simulasi tidak error dan <u>data di tabel Machine Assignment tidak tiba-tiba blank</u>, mesin-mesin ini <strong>dilewati (skipped)</strong> dan assignment yang lama tetap dipertahankan.
                        </div>
                        <Button
                          variant="secondary"
                          onClick={() => void handleCopyMissingCodes()}
                          style={{
                            whiteSpace: 'nowrap',
                            fontSize: '0.78rem',
                            padding: '6px 12px',
                            background: '#1e293b',
                            borderColor: '#475569',
                          }}
                        >
                          {copied ? '✅ Berhasil Dicopy!' : `📋 Copy ${uniqueMissingCodesCount} Kode Missing`}
                        </Button>
                      </div>

                      <div
                        style={{
                          maxHeight: '260px',
                          overflowY: 'auto',
                          border: '1px solid #1e293b',
                          borderRadius: '6px',
                          background: '#0b1120',
                        }}
                      >
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                          <thead>
                            <tr style={{ background: '#1e293b', color: '#94a3b8', textAlign: 'left' }}>
                              <th style={{ padding: '8px 10px' }}>Mesin</th>
                              <th style={{ padding: '8px 10px' }}>Current Setup Construction</th>
                              <th style={{ padding: '8px 10px' }}>MES Actual ConstructionDetail</th>
                              <th style={{ padding: '8px 10px' }}>Tindakan Sistem</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredUnmatched.map((item) => (
                              <tr key={item.machineId} style={{ borderBottom: '1px solid #1e293b' }}>
                                <td style={{ padding: '8px 10px', fontWeight: 600, color: '#f8fafc' }}>
                                  {item.machineLabel}
                                </td>
                                <td style={{ padding: '8px 10px', color: '#cbd5e1' }}>
                                  {item.currentLabel}
                                </td>
                                <td style={{ padding: '8px 10px', color: '#fca5a5', fontFamily: 'monospace' }}>
                                  {item.mesConstruction}
                                </td>
                                <td style={{ padding: '8px 10px' }}>
                                  <span
                                    style={{
                                      background: 'rgba(245, 158, 11, 0.15)',
                                      color: '#fbbf24',
                                      padding: '2px 8px',
                                      borderRadius: '4px',
                                      fontSize: '0.72rem',
                                      fontWeight: 600,
                                    }}
                                  >
                                    🛡️ Dilewati (Tetap: {item.currentLabel})
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div
                      style={{
                        padding: '24px',
                        textAlign: 'center',
                        color: '#4ade80',
                        fontSize: '0.85rem',
                        background: 'rgba(34, 197, 94, 0.05)',
                        borderRadius: '8px',
                        border: '1px solid rgba(34, 197, 94, 0.2)',
                      }}
                    >
                      🎉 Semua mesin yang berjalan di MES memiliki kode yang cocok di katalog <code>WL_Products</code>! Tidak ada mesin yang gagal lookup.
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: MATCHED & READY TO UPDATE */}
              {activeTab === 'matched' && (
                <div
                  style={{
                    maxHeight: '300px',
                    overflowY: 'auto',
                    border: '1px solid #1e293b',
                    borderRadius: '6px',
                    background: '#0b1120',
                  }}
                >
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                    <thead>
                      <tr style={{ background: '#1e293b', color: '#94a3b8', textAlign: 'left' }}>
                        <th style={{ padding: '8px 10px' }}>Mesin</th>
                        <th style={{ padding: '8px 10px' }}>Current Construction</th>
                        <th style={{ padding: '8px 10px' }}>New Construction (MES)</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right' }}>Output KG</th>
                        <th style={{ padding: '8px 10px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredMatched.length > 0 ? (
                        filteredMatched.map((item) => {
                          const isSame =
                            item.currentLabel.trim().toLowerCase() ===
                            (item.product.mpp_constructiondetailcode ?? '').trim().toLowerCase();
                          return (
                            <tr key={item.machineId} style={{ borderBottom: '1px solid #1e293b' }}>
                              <td style={{ padding: '8px 10px', fontWeight: 600, color: '#f8fafc' }}>
                                {item.machineLabel}
                              </td>
                              <td style={{ padding: '8px 10px', color: '#94a3b8' }}>
                                {item.currentLabel}
                              </td>
                              <td
                                style={{
                                  padding: '8px 10px',
                                  color: '#38bdf8',
                                  fontWeight: 600,
                                  fontFamily: 'monospace',
                                }}
                              >
                                {item.product.mpp_constructiondetailcode}
                              </td>
                              <td style={{ padding: '8px 10px', textAlign: 'right', color: '#cbd5e1' }}>
                                {Math.round(item.volumeKG).toLocaleString()} kg
                              </td>
                              <td style={{ padding: '8px 10px' }}>
                                {isSame ? (
                                  <span
                                    style={{
                                      background: 'rgba(148, 163, 184, 0.15)',
                                      color: '#94a3b8',
                                      padding: '2px 8px',
                                      borderRadius: '4px',
                                      fontSize: '0.72rem',
                                    }}
                                  >
                                    Sudah Sesuai
                                  </span>
                                ) : (
                                  <span
                                    style={{
                                      background: 'rgba(34, 197, 94, 0.15)',
                                      color: '#4ade80',
                                      padding: '2px 8px',
                                      borderRadius: '4px',
                                      fontSize: '0.72rem',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Akan Di-update
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={5} style={{ padding: '20px', textAlign: 'center', color: '#94a3b8' }}>
                            Tidak ada data mesin yang cocok.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* TAB 3: NO ACTIVITY IN MES */}
              {activeTab === 'noActivity' && (
                <div
                  style={{
                    maxHeight: '300px',
                    overflowY: 'auto',
                    border: '1px solid #1e293b',
                    borderRadius: '6px',
                    background: '#0b1120',
                  }}
                >
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                    <thead>
                      <tr style={{ background: '#1e293b', color: '#94a3b8', textAlign: 'left' }}>
                        <th style={{ padding: '8px 10px' }}>Mesin</th>
                        <th style={{ padding: '8px 10px' }}>Current Setup Construction</th>
                        <th style={{ padding: '8px 10px' }}>Status Penanganan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredNoAct.length > 0 ? (
                        filteredNoAct.map((item) => (
                          <tr key={item.machineId} style={{ borderBottom: '1px solid #1e293b' }}>
                            <td style={{ padding: '8px 10px', fontWeight: 600, color: '#f8fafc' }}>
                              {item.machineLabel}
                            </td>
                            <td style={{ padding: '8px 10px', color: '#cbd5e1' }}>
                              {item.currentLabel}
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <span
                                style={{
                                  background: 'rgba(148, 163, 184, 0.15)',
                                  color: '#cbd5e1',
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  fontSize: '0.72rem',
                                }}
                              >
                                Dipertahankan (Tidak ada data MES)
                              </span>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={3} style={{ padding: '20px', textAlign: 'center', color: '#94a3b8' }}>
                            Semua mesin di layout memiliki aktivitas di MES.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
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
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            {stage === 'preview' && (
              <Button
                variant="ghost"
                onClick={() => {
                  setStage('params');
                  setMatchedItems([]);
                  setUnmatchedCatalog([]);
                  setNoActivity([]);
                }}
                disabled={loading}
                style={{ fontSize: '0.8rem' }}
              >
                ← Ganti Filter Tanggal / Shift
              </Button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <Button
              variant="secondary"
              onClick={onClose}
              disabled={loading}
            >
              Batal
            </Button>

            {stage === 'saving' ? (
              <Button variant="primary" disabled style={{ fontWeight: 600 }}>
                Menyimpan…
              </Button>
            ) : stage === 'preview' ? (
              <Button
                variant="primary"
                onClick={() => void handleApplyImport()}
                disabled={loading || matchedItems.length === 0}
                style={{ fontWeight: 600 }}
              >
                {`💾 Terapkan (${matchedItems.length} Mesin) ke Setup`}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void handleFetchAndAnalyze()}
                disabled={loading || !plant.trim() || !date}
                style={{ fontWeight: 600 }}
              >
                {loading ? 'Mengambil Data…' : '🔍 Fetch & Match Data MES'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
