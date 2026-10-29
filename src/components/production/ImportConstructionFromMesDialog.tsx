import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductionMachineAssignment, ProductionSetup } from '../../types';
import type { Mpp_wl_productses, Mpp_wl_productsesBase } from '../../generated/models/Mpp_wl_productsesModel';
import { Mpp_wl_productsesService } from '../../generated/services/Mpp_wl_productsesService';
import { Mpp_wl_activitiesService } from '../../generated/services/Mpp_wl_activitiesService';
import { fetchAllPages } from '../../lib/dataversePaging';
import { loadActualOutputData, type ActualOutputRecord } from '../../lib/actualOutputCatalog';
import { updateMachineAssignments } from '../../lib/productionSetupsStore';
import { loadDefaultValuesOrBuiltIn } from '../../lib/defaultValuesStore';
import {
  isWwdRecord,
  isWwdConstruction,
  extractWwdBaseConstruction,
  saveWwdSpec,
  getWwdSpec,
  synthesizeWwdSpec,
  findMatchingActivityConstruction,
} from '../../lib/wwdSpecStore';
import { loadFrequencyCatalog, lookupHistoricalFrequency } from '../../lib/frequencyCatalog';
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
  currentId?: string;
  mesConstruction: string;
  product?: Mpp_wl_productses;
  isWwd?: boolean;
  baseConstruction?: string;
  numberOfWires?: number | null;
  volumeKG: number;
  willChange: boolean;
}

interface UnmatchedCatalogItem {
  machineId: string;
  machineLabel: string;
  currentLabel: string;
  currentId?: string;
  mesConstruction: string;
  isWwd?: boolean;
  baseConstruction?: string;
  volumeKG: number;
  willChange: boolean;
  reason?: string;
}

interface NoActivityItem {
  machineId: string;
  machineLabel: string;
  currentLabel: string;
  currentId?: string;
  willChange: boolean;
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
  const [wwdMesItems, setWwdMesItems] = useState<MatchedItem[]>([]);
  const [unmatchedCatalog, setUnmatchedCatalog] = useState<UnmatchedCatalogItem[]>([]);
  const [noActivity, setNoActivity] = useState<NoActivityItem[]>([]);
  const [activeTab, setActiveTab] = useState<'matched' | 'wwd' | 'unmatched' | 'noActivity'>('matched');
  const [filterSearch, setFilterSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const [savingWwd, setSavingWwd] = useState(false);
  const [wwdSaveSuccess, setWwdSaveSuccess] = useState<string | null>(null);

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
      setError('Please provide a valid Plant Name and Date.');
      return;
    }

    setLoading(true);
    setError(null);
    setStage('querying');
    setStatusText(`Querying MES_ActualOutput from Power BI Semantic Model (Plant: ${plant}, Date: ${date}, Shift: ${shift})…`);

    try {
      const { records } = await loadActualOutputData(
        { plant: plant.trim(), date, shift: Number(shift) },
        true,
      );

      if (!records || records.length === 0) {
        throw new Error(
          `No actual output records found in MES for Plant "${plant}", Date "${date}", Shift ${shift}. Please ensure data is loaded into Power BI for this shift.`,
        );
      }

      setStage('processing');
      setStatusText(`Processing ${records.length.toLocaleString()} MES records & matching ${setup.layout.length} layout machines…`);

      // Load WL_Activities to validate WWD base constructions
      let activityConstructionSet = new Set<string>();
      try {
        const actRows = await fetchAllPages(Mpp_wl_activitiesService.getAll, {
          select: ['mpp_constructiontype'],
        });
        activityConstructionSet = new Set(
          actRows.map((r) => (r.mpp_constructiontype ?? '').trim().toLowerCase()).filter(Boolean),
        );
      } catch (actErr) {
        console.warn('Failed to load WL_Activities for WWD validation:', actErr);
      }

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

      const matchedCatalogItems: MatchedItem[] = [];
      const wwdMesList: MatchedItem[] = [];
      const missingCatalog: UnmatchedCatalogItem[] = [];
      const noAct: NoActivityItem[] = [];

      for (const machine of setup.layout) {
        const mLabel = (machine.label || machine.id).trim();
        const currentAssign = assignmentByMachineId.get(machine.id);
        const currentLabel = currentAssign?.constructionDetailLabel || '—';
        const currentId = currentAssign?.constructionDetailId;

        const rec = recByMachine.get(mLabel.toLowerCase());
        if (rec && rec.constructionDetail?.trim()) {
          const mesCode = rec.constructionDetail.trim();
          const vol = rec.totalProducedKG ?? (rec.tonProduced ? rec.tonProduced * 1000 : 0);

          const isWwd = isWwdRecord(rec) || isWwdConstruction(mesCode);

          // 1. Check if construction detail code is ALREADY registered in WL_Products catalog
          const matchedProd =
            productByExact.get(mesCode.toLowerCase()) ??
            productByNormalized.get(normalizeKey(mesCode));

          if (matchedProd) {
            // Already registered in WL_Products!
            const willChange = currentId !== matchedProd.mpp_wl_productsid;
            matchedCatalogItems.push({
              machineId: machine.id,
              machineLabel: mLabel,
              currentLabel,
              currentId,
              mesConstruction: mesCode,
              product: matchedProd,
              isWwd,
              baseConstruction: matchedProd.mpp_constructioncode ?? undefined,
              volumeKG: vol,
              willChange,
            });
          } else if (isWwd) {
            // Dynamic WWD specification from MES Actual Output!
            // Validate base construction against WL_Activities using flexible variant matching
            const rawBaseConstruction = extractWwdBaseConstruction(mesCode);
            const matchedActKey = findMatchingActivityConstruction(rawBaseConstruction, activityConstructionSet);

            if (matchedActKey) {
              const canonicalBase = matchedActKey;
              const speed = typeof rec.standardSpeed === 'number' ? rec.standardSpeed : Number(rec.standardSpeed) || 0;
              const length = typeof rec.standardLength === 'number' ? rec.standardLength : Number(rec.standardLength) || 0;
              const diam = parseFloat(rec.construction);
              const density =
                rec.linerDensity ??
                (Number.isFinite(diam) && diam > 0
                  ? Number(((Math.PI / 4) * Math.pow(diam, 2) * 7.85).toFixed(4))
                  : 0);

              saveWwdSpec({
                constructionDetail: mesCode,
                baseConstruction: canonicalBase,
                standardSpeed: speed,
                standardLength: length,
                linearDensity: density,
                layLength: Number(rec.layLength) || 0,
                tensileStrength: rec.tensileStrength || '',
                spoolType: rec.spoolType || 'BS40',
                numberOfWires: rec.numberOfWires ?? 1,
                fracturePerTon: rec.fracturePerTon ?? 0,
                diesPerTon: rec.diesPerTon ?? 0,
                defectPerTon: rec.defectPerTon ?? 0,
              });

              const willChange = currentLabel !== mesCode;
              wwdMesList.push({
                machineId: machine.id,
                machineLabel: mLabel,
                currentLabel,
                currentId,
                mesConstruction: mesCode,
                isWwd: true,
                baseConstruction: canonicalBase,
                numberOfWires: rec.numberOfWires ?? 1,
                volumeKG: vol,
                willChange,
              });
            } else {
              const willChange = Boolean(currentId);
              missingCatalog.push({
                machineId: machine.id,
                machineLabel: mLabel,
                currentLabel,
                currentId,
                mesConstruction: mesCode,
                isWwd: true,
                baseConstruction: rawBaseConstruction,
                volumeKG: vol,
                willChange,
                reason: `WWD Base Construction "${rawBaseConstruction}" not found in WL_Activities`,
              });
            }
          } else {
            // Non-WWD machine not found in WL_Products catalog -> will unassign & log
            const willChange = Boolean(currentId);
            missingCatalog.push({
              machineId: machine.id,
              machineLabel: mLabel,
              currentLabel,
              currentId,
              mesConstruction: mesCode,
              volumeKG: vol,
              willChange,
              reason: 'ConstructionDetail code not registered in WL_Products',
            });
          }
        } else {
          // No MES activity on this shift -> will unassign
          const willChange = Boolean(currentId);
          noAct.push({
            machineId: machine.id,
            machineLabel: mLabel,
            currentLabel,
            currentId,
            willChange,
          });
        }
      }

      setMatchedItems(matchedCatalogItems);
      setWwdMesItems(wwdMesList);
      setUnmatchedCatalog(missingCatalog);
      setNoActivity(noAct);

      // Default active tab: missing if any, else WWD if any, else matched
      if (missingCatalog.length > 0) {
        setActiveTab('unmatched');
      } else if (wwdMesList.length > 0) {
        setActiveTab('wwd');
      } else {
        setActiveTab('matched');
      }

      setStage('preview');
      setLoading(false);
      setStatusText(null);
    } catch (err) {
      console.error('Fetch MES error:', err);
      const msg = err instanceof Error ? err.message : 'Failed to retrieve data from Power BI MES.';
      setError(msg);
      setStage('params');
      setLoading(false);
      setStatusText(null);
    }
  };

  // Step 2: Apply assignments (matched products assigned, idle/missing unassigned)
  const totalChangedMachines = useMemo(() => {
    const c1 = matchedItems.filter((m) => m.willChange).length;
    const cWwd = wwdMesItems.filter((m) => m.willChange).length;
    const c2 = unmatchedCatalog.filter((m) => m.willChange).length;
    const c3 = noActivity.filter((m) => m.willChange).length;
    return c1 + cWwd + c2 + c3;
  }, [matchedItems, wwdMesItems, unmatchedCatalog, noActivity]);

  const handleApplyImport = async () => {
    setLoading(true);
    setError(null);
    setStage('saving');

    const patchByMachineId = new Map<string, Partial<ProductionMachineAssignment>>();
    const changesToPersist: { machineId: string; patch: Partial<ProductionMachineAssignment> }[] = [];

    // 1. Matched in Catalog
    for (const item of matchedItems) {
      const targetId = item.product!.mpp_wl_productsid;
      const targetLabel = item.product!.mpp_constructiondetailcode;
      patchByMachineId.set(item.machineId, {
        constructionDetailId: targetId,
        constructionDetailLabel: targetLabel,
      });
      if (item.willChange) {
        changesToPersist.push({
          machineId: item.machineId,
          patch: {
            constructionDetailId: targetId,
            constructionDetailLabel: targetLabel,
          },
        });
      }
    }

    // 2. WWD from MES Output
    for (const item of wwdMesItems) {
      const targetId = item.product ? item.product.mpp_wl_productsid : item.mesConstruction;
      const targetLabel = item.mesConstruction;
      patchByMachineId.set(item.machineId, {
        constructionDetailId: targetId,
        constructionDetailLabel: targetLabel,
      });
      if (item.willChange) {
        changesToPersist.push({
          machineId: item.machineId,
          patch: {
            constructionDetailId: targetId,
            constructionDetailLabel: targetLabel,
          },
        });
      }
    }

    // 3. Unmatched in catalog / invalid -> unassign
    for (const item of unmatchedCatalog) {
      patchByMachineId.set(item.machineId, {
        constructionDetailId: undefined,
        constructionDetailLabel: undefined,
      });
      if (item.willChange) {
        changesToPersist.push({
          machineId: item.machineId,
          patch: {
            constructionDetailId: undefined,
            constructionDetailLabel: undefined,
          },
        });
      }
    }

    // 4. No MES data -> unassign
    for (const item of noActivity) {
      patchByMachineId.set(item.machineId, {
        constructionDetailId: undefined,
        constructionDetailLabel: undefined,
      });
      if (item.willChange) {
        changesToPersist.push({
          machineId: item.machineId,
          patch: {
            constructionDetailId: undefined,
            constructionDetailLabel: undefined,
          },
        });
      }
    }

    setSaveProgress({ done: 0, total: Math.max(1, changesToPersist.length) });
    setStatusText(`Saving Construction assignments: 0 / ${changesToPersist.length}…`);

    try {
      // Update local setup state:
      // Merges patch ONLY on constructionDetailId & constructionDetailLabel.
      // All other properties (...a) (operators, groups, doffPriority) remain 100% intact!
      onLocalChange({
        assignments: setup.assignments.map((a) =>
          patchByMachineId.has(a.machineId)
            ? { ...a, ...patchByMachineId.get(a.machineId) }
            : a,
        ),
      });

      // Update Dataverse only for machines that actually changed
      if (changesToPersist.length > 0) {
        await updateMachineAssignments(setup.id, changesToPersist, (done, total) => {
          setSaveProgress({ done, total });
          setStatusText(`Saving to Dataverse: ${done} / ${total} machines (${Math.round((done / total) * 100)}%)…`);
        });
      }

      setStage('complete');
      const assignedCount = matchedItems.length + wwdMesItems.length;
      const unassignedCount = unmatchedCatalog.filter((m) => m.willChange).length + noActivity.filter((m) => m.willChange).length;
      const successMsg = `Successfully imported MES Construction: ${assignedCount} machine(s) assigned${unassignedCount > 0 ? `, ${unassignedCount} machine(s) unassigned (no active catalog product)` : ''}.`;
      onSuccess(successMsg);
      onClose();
    } catch (err) {
      console.error('Save import error:', err);
      const msg = err instanceof Error ? err.message : 'Failed to save changes to Dataverse.';
      setError(msg);
      setStage('preview');
      setLoading(false);
      setStatusText(null);
      setSaveProgress(null);
    }
  };

  // Step 3: Save WWD constructions dynamically derived from MES to WL_Products
  const handleSaveWwdToProducts = async () => {
    if (wwdMesItems.length === 0 || savingWwd) return;
    setSavingWwd(true);
    setWwdSaveSuccess(null);
    setError(null);

    try {
      const defaults = await loadDefaultValuesOrBuiltIn();
      const defaultPoWeight = defaults.defaultWwdPoLength1 || 480;

      // Load historical frequency catalog
      const { catalog: freqCatalog } = await loadFrequencyCatalog({ plant: plant.trim() });

      // Determine unique unregistered WWD constructions
      const existingProductCodes = new Set(
        products.map((p) => (p.mpp_constructiondetailcode ?? '').trim().toLowerCase()).filter(Boolean),
      );

      const uniqueWwdByCode = new Map<string, MatchedItem>();
      for (const item of wwdMesItems) {
        const codeKey = item.mesConstruction.trim().toLowerCase();
        if (!existingProductCodes.has(codeKey) && !uniqueWwdByCode.has(codeKey) && !item.product) {
          uniqueWwdByCode.set(codeKey, item);
        }
      }

      if (uniqueWwdByCode.size === 0) {
        setWwdSaveSuccess('All WWD constructions are already registered in WL_Products!');
        setSavingWwd(false);
        return;
      }

      let createdCount = 0;
      const newlyCreated: Mpp_wl_productses[] = [];

      for (const [_, item] of uniqueWwdByCode.entries()) {
        const spec = getWwdSpec(item.mesConstruction) ?? synthesizeWwdSpec(item.mesConstruction);
        const baseConst = (item.baseConstruction || spec.baseConstruction).toUpperCase();

        // Product spec is the 2nd segment in base construction e.g. '0,280' from 'WWD-0,280-0-ST-WS44-DUAL'
        const baseParts = baseConst.split('-');
        const productSpec = baseParts[1] ?? '';

        // Strict historical frequency lookup: mach='WWD', product=productSpec (no fuzzy aliasing 1X vs non-1X!)
        const freqItem = lookupHistoricalFrequency(freqCatalog, 'WWD', productSpec, spec.layLength, spec.tensileStrength);

        const fractureRate = freqItem?.fracturePerTon ?? spec.fracturePerTon ?? defaults.defaultFracturePerTon ?? 0;
        const diesRate = freqItem?.diesPerTon ?? spec.diesPerTon ?? defaults.defaultDiesPerTon ?? 0;
        const defectRate = freqItem?.defectPerTon ?? spec.defectPerTon ?? defaults.defaultDefectPerTon ?? 0;

        const payload: Omit<Mpp_wl_productsesBase, 'mpp_wl_productsid'> = {
          mpp_machinecode: 'WWD',
          mpp_productspecification: productSpec,
          mpp_constructioncode: baseConst,
          mpp_constructiondetailcode: item.mesConstruction,
          mpp_area: 'WW',
          mpp_speed: String(spec.standardSpeed || 0),
          mpp_spoollength: spec.standardLength || 0,
          mpp_lineardensity: String(spec.linearDensity || 0),
          mpp_laylength: spec.layLength || 0,
          mpp_spooltype: spec.spoolType || 'BS40',
          mpp_tensilegroup: spec.tensileStrength || '',
          mpp_polength1: defaultPoWeight,
          mpp_polength2: null as any,
          mpp_polength3: null as any,
          mpp_numberoffibers: spec.numberOfWires ?? item.numberOfWires ?? 1,
          mpp_fractureperton: String(fractureRate),
          mpp_dieston: String(diesRate),
          mpp_defectston: String(defectRate),
          mpp_taskpriority: null as any,
          mpp_doffpriority: null as any,
          mpp_minremaintaskfordoffpriority: null as any,
          statecode: 0,
        };

        const result = await Mpp_wl_productsesService.create(payload);
        if (result.success && result.data) {
          createdCount++;
          newlyCreated.push(result.data);
        } else {
          console.warn(`Failed to create WL_Products record for ${item.mesConstruction}:`, result.error);
        }
      }

      if (createdCount > 0) {
        const createdMap = new Map<string, Mpp_wl_productses>();
        for (const p of newlyCreated) {
          if (p.mpp_constructiondetailcode) {
            createdMap.set(p.mpp_constructiondetailcode.trim().toLowerCase(), p);
          }
        }

        // Attach created product to matching WWD items
        setWwdMesItems((prev) =>
          prev.map((item) => {
            const p = createdMap.get(item.mesConstruction.trim().toLowerCase());
            return p ? { ...item, product: p } : item;
          }),
        );

        setWwdSaveSuccess(`✅ Successfully registered ${createdCount} WWD construction(s) into WL_Products with frequencies from WL_Frequency!`);
      } else {
        setError('Failed to create new WWD products in Dataverse.');
      }
    } catch (err) {
      console.error('Error saving WWD to WL_Products:', err);
      setError(err instanceof Error ? err.message : 'Failed to save WWD products.');
    } finally {
      setSavingWwd(false);
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

  const uniqueUnregisteredWwdCount = useMemo(() => {
    return new Set(wwdMesItems.filter((m) => !m.product).map((m) => m.mesConstruction)).size;
  }, [wwdMesItems]);

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

  const filteredWwd = useMemo(() => {
    if (!query) return wwdMesItems;
    return wwdMesItems.filter(
      (m) =>
        m.machineLabel.toLowerCase().includes(query) ||
        m.currentLabel.toLowerCase().includes(query) ||
        m.mesConstruction.toLowerCase().includes(query) ||
        (m.baseConstruction && m.baseConstruction.toLowerCase().includes(query)),
    );
  }, [wwdMesItems, query]);

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
              gridTemplateColumns: '1fr 1.3fr 1fr',
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
                disabled={loading || stage === 'saving' || stage === 'preview'}
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
                disabled={loading || stage === 'saving' || stage === 'preview'}
                className="frequency-date-input"
              />
            </div>

            {/* Shift */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>⏱️ Shift</label>
              <select
                value={shift}
                onChange={(e) => setShift(Number(e.target.value))}
                disabled={loading || stage === 'saving' || stage === 'preview'}
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
                    : '💾 Saving Construction Assignments to Dataverse…'}
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
                ⚠️ Error Occurred:
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
                  gridTemplateColumns: wwdMesItems.length > 0 ? 'repeat(5, 1fr)' : 'repeat(4, 1fr)',
                  gap: '8px',
                }}
              >
                {/* 1. Matched in Catalog */}
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
                    ✅ Matched in Catalog
                  </span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f0fdf4', margin: '2px 0' }}>
                    {matchedItems.length}
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Assign catalog product</span>
                </div>

                {/* 2. WWD (MES Output) - Only shown if there are dynamic WWD items from MES */}
                {wwdMesItems.length > 0 && (
                  <div
                    onClick={() => setActiveTab('wwd')}
                    style={{
                      background: activeTab === 'wwd' ? 'rgba(56, 189, 248, 0.15)' : '#0b1120',
                      border: `1px solid ${activeTab === 'wwd' ? '#38bdf8' : '#0284c7'}`,
                      borderRadius: '8px',
                      padding: '10px 12px',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <span style={{ fontSize: '0.72rem', color: '#7dd3fc', fontWeight: 600, display: 'block' }}>
                      ⚡ WWD (MES Output)
                    </span>
                    <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f0f9ff', margin: '2px 0' }}>
                      {wwdMesItems.length}
                    </div>
                    <span style={{ fontSize: '0.7rem', color: '#38bdf8' }}>
                      {uniqueUnregisteredWwdCount > 0 ? `${uniqueUnregisteredWwdCount} can save to catalog` : 'Ready to assign'}
                    </span>
                  </div>
                )}

                {/* 3. Missing in Catalog */}
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
                    ⚠️ Missing in Catalog
                  </span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#fef2f2', margin: '2px 0' }}>
                    {unmatchedCatalog.length}
                  </div>
                  <span style={{ fontSize: '0.7rem', color: unmatchedCatalog.length > 0 ? '#f87171' : '#94a3b8' }}>
                    {unmatchedCatalog.length > 0 ? 'Will unassign & log' : 'All registered'}
                  </span>
                </div>

                {/* 4. No Activity */}
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
                    ℹ️ No MES Activity
                  </span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc', margin: '2px 0' }}>
                    {noActivity.length}
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Will set to unassigned</span>
                </div>

                {/* 5. Total Layout Machines */}
                <div
                  style={{
                    background: '#0b1120',
                    border: '1px solid #1e293b',
                    borderRadius: '8px',
                    padding: '10px 12px',
                  }}
                >
                  <span style={{ fontSize: '0.72rem', color: '#38bdf8', fontWeight: 600, display: 'block' }}>
                    🏢 Total Layout Machines
                  </span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f0f9ff', margin: '2px 0' }}>
                    {setup.layout.length}
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{setup.name || 'Current Setup'}</span>
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
                  <strong>Safe & Isolated:</strong> This import <u>only</u> updates the <strong>Construction</strong> column. Operator assignments, group names, doff priorities, and other task parameters <strong>remain completely untouched</strong>.
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
                    ✅ Catalog Matched ({matchedItems.length})
                  </button>
                  {wwdMesItems.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('wwd')}
                      style={{
                        background: activeTab === 'wwd' ? '#1e293b' : 'transparent',
                        border: 'none',
                        color: activeTab === 'wwd' ? '#38bdf8' : '#7dd3fc',
                        fontWeight: 600,
                        fontSize: '0.82rem',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                      }}
                    >
                      ⚡ WWD from MES ({wwdMesItems.length})
                    </button>
                  )}
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
                    ⚠️ Missing in Catalog ({unmatchedCatalog.length})
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
                    ℹ️ No MES Activity ({noActivity.length})
                  </button>
                </div>

                {/* Filter Search */}
                <input
                  type="text"
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                  placeholder="Filter machine / code…"
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
                          <strong>⚠️ Why are these set to unassigned?</strong>
                          <br />
                          The following ConstructionDetail codes from MES are <strong>not registered</strong> in the <code>WL_Products</code> master catalog. Because simulations require product process specifications (speeds, cycle times, etc.), these machines will be set to <strong>Unassigned (Blank)</strong>. You can copy the missing codes below to register them in WL_Products.
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
                          {copied ? '✅ Copied to Clipboard!' : `📋 Copy ${uniqueMissingCodesCount} Missing Codes`}
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
                              <th style={{ padding: '8px 10px' }}>Machine</th>
                              <th style={{ padding: '8px 10px' }}>Previous Construction</th>
                              <th style={{ padding: '8px 10px' }}>MES ConstructionDetail</th>
                              <th style={{ padding: '8px 10px' }}>Action</th>
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
                                      background: 'rgba(239, 68, 68, 0.15)',
                                      color: '#f87171',
                                      padding: '2px 8px',
                                      borderRadius: '4px',
                                      fontSize: '0.72rem',
                                      fontWeight: 600,
                                    }}
                                  >
                                    {item.reason ?? 'Unassign (Not in WL_Products)'}
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
                      🎉 All machines active in MES have matching codes in <code>WL_Products</code> or <code>WL_Activities</code>!
                    </div>
                  )}
                </div>
              )}

              {/* TAB WWD FROM MES (DYNAMIC OUTPUT) */}
              {activeTab === 'wwd' && wwdMesItems.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {/* Action Banner */}
                  <div
                    style={{
                      background: 'rgba(56, 189, 248, 0.08)',
                      border: '1px solid rgba(56, 189, 248, 0.25)',
                      borderRadius: '8px',
                      padding: '12px 14px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '12px',
                    }}
                  >
                    <div style={{ fontSize: '0.8rem', color: '#bae6fd', lineHeight: 1.4 }}>
                      <strong style={{ color: '#38bdf8', fontSize: '0.85rem' }}>
                        ⚡ Dynamic WWD Specifications (From MES Output)
                      </strong>
                      <br />
                      These <strong>{wwdMesItems.length}</strong> WWD machines have construction specifications dynamically built from MES Actual Output (validated against <code>WL_Activities</code>).
                      You can assign them directly to your setup, or permanently register these WWD constructions into <code>WL_Products</code> with rates from <code>WL_Frequency</code>.
                    </div>
                    <Button
                      variant="primary"
                      onClick={() => void handleSaveWwdToProducts()}
                      disabled={savingWwd || uniqueUnregisteredWwdCount === 0}
                      style={{
                        whiteSpace: 'nowrap',
                        fontSize: '0.78rem',
                        padding: '7px 14px',
                        background:
                          uniqueUnregisteredWwdCount === 0
                            ? '#1e293b'
                            : 'linear-gradient(135deg, #0284c7, #2563eb)',
                        borderColor: uniqueUnregisteredWwdCount === 0 ? '#334155' : '#38bdf8',
                        color: uniqueUnregisteredWwdCount === 0 ? '#94a3b8' : '#ffffff',
                      }}
                    >
                      {savingWwd
                        ? '⏳ Saving to WL_Products…'
                        : uniqueUnregisteredWwdCount === 0
                        ? '✅ All Saved to WL_Products'
                        : `💾 Save to WL_Products (${uniqueUnregisteredWwdCount} codes)`}
                    </Button>
                  </div>

                  {wwdSaveSuccess && (
                    <div
                      style={{
                        background: 'rgba(34, 197, 94, 0.1)',
                        border: '1px solid rgba(34, 197, 94, 0.3)',
                        borderRadius: '6px',
                        padding: '8px 12px',
                        fontSize: '0.78rem',
                        color: '#86efac',
                      }}
                    >
                      {wwdSaveSuccess}
                    </div>
                  )}

                  {/* Table of WWD machines */}
                  <div
                    style={{
                      maxHeight: '280px',
                      overflowY: 'auto',
                      border: '1px solid #1e293b',
                      borderRadius: '6px',
                      background: '#0b1120',
                    }}
                  >
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                      <thead>
                        <tr style={{ background: '#1e293b', color: '#94a3b8', textAlign: 'left' }}>
                          <th style={{ padding: '8px 10px' }}>Machine</th>
                          <th style={{ padding: '8px 10px' }}>Current Construction</th>
                          <th style={{ padding: '8px 10px' }}>MES Output Construction</th>
                          <th style={{ padding: '8px 10px' }}>WL_Activities Base</th>
                          <th style={{ padding: '8px 10px', textAlign: 'center' }}>Wires</th>
                          <th style={{ padding: '8px 10px', textAlign: 'right' }}>Output Volume</th>
                          <th style={{ padding: '8px 10px' }}>Catalog Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredWwd.length > 0 ? (
                          filteredWwd.map((item) => (
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
                                {item.mesConstruction}
                              </td>
                              <td style={{ padding: '8px 10px', color: '#a5f3fc', fontFamily: 'monospace' }}>
                                {item.baseConstruction ?? '—'}
                              </td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', color: '#f8fafc' }}>
                                {item.numberOfWires ?? 1}
                              </td>
                              <td style={{ padding: '8px 10px', textAlign: 'right', color: '#cbd5e1' }}>
                                {Math.round(item.volumeKG).toLocaleString()} kg
                              </td>
                              <td style={{ padding: '8px 10px' }}>
                                {item.product ? (
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
                                    Registered in WL_Products
                                  </span>
                                ) : (
                                  <span
                                    style={{
                                      background: 'rgba(56, 189, 248, 0.15)',
                                      color: '#38bdf8',
                                      padding: '2px 8px',
                                      borderRadius: '4px',
                                      fontSize: '0.72rem',
                                      fontWeight: 600,
                                    }}
                                  >
                                    ⚡ MES Output (Dynamic)
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: '#94a3b8' }}>
                              No WWD machines found from MES for this shift.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
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
                        <th style={{ padding: '8px 10px' }}>Machine</th>
                        <th style={{ padding: '8px 10px' }}>Current Construction</th>
                        <th style={{ padding: '8px 10px' }}>New Construction (MES)</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right' }}>Output Volume</th>
                        <th style={{ padding: '8px 10px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredMatched.length > 0 ? (
                        filteredMatched.map((item) => {
                          const isSame = !item.willChange;
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
                                {item.product?.mpp_constructiondetailcode ?? item.mesConstruction}
                                {item.isWwd && (
                                  <span
                                    style={{
                                      marginLeft: '6px',
                                      background: 'rgba(56, 189, 248, 0.15)',
                                      color: '#38bdf8',
                                      padding: '1px 6px',
                                      borderRadius: '4px',
                                      fontSize: '0.68rem',
                                      fontWeight: 600,
                                    }}
                                    title={`WWD validated via WL_Activities base: ${item.baseConstruction}`}
                                  >
                                    WWD (WL_Activities)
                                  </span>
                                )}
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
                                    Already Assigned
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
                                    Will Update
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={5} style={{ padding: '20px', textAlign: 'center', color: '#94a3b8' }}>
                            No matched machines for this shift.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* TAB 3: NO ACTIVITY IN MES */}
              {activeTab === 'noActivity' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div
                    style={{
                      background: 'rgba(148, 163, 184, 0.08)',
                      border: '1px solid rgba(148, 163, 184, 0.25)',
                      borderRadius: '8px',
                      padding: '10px 14px',
                      fontSize: '0.8rem',
                      color: '#cbd5e1',
                      lineHeight: 1.4,
                    }}
                  >
                    ℹ️ <strong>Idle / No MES Output:</strong> These machines had no production recorded in MES for this shift. Their construction assignment will be set to <strong>Unassigned (Blank)</strong>.
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
                          <th style={{ padding: '8px 10px' }}>Machine</th>
                          <th style={{ padding: '8px 10px' }}>Previous Construction</th>
                          <th style={{ padding: '8px 10px' }}>Action</th>
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
                                  {item.currentId ? 'Unassign (No MES Output)' : 'Already Blank'}
                                </span>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={3} style={{ padding: '20px', textAlign: 'center', color: '#94a3b8' }}>
                              All layout machines had active output in MES.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
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
                ← Change Date / Shift
              </Button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            {stage === 'preview' && (
              <div
                style={{
                  fontSize: '0.74rem',
                  color: '#94a3b8',
                  lineHeight: 1.35,
                  textAlign: 'right',
                }}
              >
                <div>
                  <strong style={{ color: '#4ade80' }}>{matchedItems.length}</strong> assigned
                  {matchedItems.filter((m) => m.willChange).length > 0 && (
                    <span> (<span style={{ color: '#38bdf8' }}>{matchedItems.filter((m) => m.willChange).length}</span> to update)</span>
                  )}
                </div>
                <div>
                  <strong style={{ color: '#cbd5e1' }}>{unmatchedCatalog.length + noActivity.length}</strong> unassigned
                  {(unmatchedCatalog.filter((m) => m.willChange).length + noActivity.filter((m) => m.willChange).length) > 0 && (
                    <span> (<span style={{ color: '#f87171' }}>{unmatchedCatalog.filter((m) => m.willChange).length + noActivity.filter((m) => m.willChange).length}</span> to clear)</span>
                  )}
                </div>
              </div>
            )}

            <Button
              variant="secondary"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </Button>

            {stage === 'saving' ? (
              <Button variant="primary" disabled style={{ fontWeight: 600 }}>
                Saving to Dataverse…
              </Button>
            ) : stage === 'preview' ? (
              <Button
                variant="primary"
                onClick={() => void handleApplyImport()}
                disabled={loading || totalChangedMachines === 0}
                style={{ fontWeight: 600 }}
                title={`${totalChangedMachines} machines will have their construction assignment changed in Dataverse`}
              >
                {totalChangedMachines > 0
                  ? `💾 Apply Changes (${totalChangedMachines} Updates)`
                  : '✅ All 1,256 Machines Already Up-to-Date'}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void handleFetchAndAnalyze()}
                disabled={loading || !plant.trim() || !date}
                style={{ fontWeight: 600 }}
              >
                {loading ? 'Fetching MES Data…' : '🔍 Fetch & Match MES Data'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
