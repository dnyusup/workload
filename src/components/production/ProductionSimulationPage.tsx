import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutMachine, ProductionMachineAssignment, ProductionSetup, TaskPriorityMode } from '../../types';
import { loadSavedLayouts, type SavedLayout } from '../../lib/savedLayoutsStore';
import {
  listProductionSetupSummaries,
  loadProductionSetup,
  createProductionSetup,
  deleteProductionSetup,
  updateProductionSetupHeader,
  addProductionOperator,
  removeProductionOperator,
  updateMachineAssignments,
  type ProductionSetupSummary,
} from '../../lib/productionSetupsStore';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import { useAuth } from '../../context/auth';
import { isOwnedByCurrentUser } from '../../lib/ownership';
import { resolveDisplayNames } from '../../lib/userDirectory';
import { Mpp_wl_productsesService } from '../../generated/services/Mpp_wl_productsesService';
import { fetchAllPages } from '../../lib/dataversePaging';
import type { Mpp_wl_productses } from '../../generated/models/Mpp_wl_productsesModel';
import { resolveConstructions, type ResolvedConstruction } from '../../lib/productionConstructionResolver';
import {
  calculatePlannedUtilization,
  calculateSelectionOccupation,
  type PlannedUtilization,
  type SelectionOccupation,
} from '../../lib/productionUtilization';
import { buildDistinctColorMap, buildSetupConstructionColorMap } from '../../lib/constructionColors';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Field, NumberInput, SelectInput } from '../ui/Field';
import { SearchableSelect } from '../ui/SearchableSelect';
import { Toggle } from '../ui/Toggle';
import { DOFF_PRIORITY_TOOLTIP, doffPriorityText } from '../ui/doffPriorityText';
import { BlockingProgressOverlay } from '../ui/BlockingProgressOverlay';
import { LayoutBuilder, type MachineAppearance } from '../setup/LayoutBuilder';
import { ProductionRunView } from './ProductionRunView';
import { CanvasLegendPanel } from './CanvasLegendPanel';
import { OperatorStartTimesDialog } from './OperatorStartTimesDialog';
import {
  MachineAssignmentsGroupBySelect,
  MachineAssignmentsSearch,
  MachineAssignmentsTable,
  type MachineAssignmentsGroupBy,
} from './MachineAssignmentsTable';
import { buildCanvasLegendData, type LegendHover } from '../../lib/canvasLegend';
import {
  operatorAssignmentLines,
  TASK_OPERATOR_FIELDS,
  TASK_OPERATOR_LABELS,
  type ProductionActivityFamily,
  type TaskOperatorField,
} from '../../lib/productionActivityRouting';
import { loadDefaultValuesOrBuiltIn } from '../../lib/defaultValuesStore';

const TASK_PRIORITY_OPTIONS: { value: TaskPriorityMode; label: string }[] = [
  { value: 'nearest', label: 'Nearest Task' },
  { value: 'quickest', label: 'Quickest Task' },
];

/** Order-insensitive key for comparing two operator-id lists (e.g. pending vs applied). */
const operatorSetKey = (ids: string[] | undefined) => [...new Set(ids ?? [])].sort().join(';');

/** Split Task rows of Assign Selection, in display order. */
const TASK_ROWS: { family: ProductionActivityFamily }[] = [
  { family: 'doffing' },
  { family: 'loading' },
  { family: 'fractureRepairing' },
  { family: 'diesChange' },
  { family: 'defectRepairing' },
];

type TaskOperatorLists = Record<ProductionActivityFamily, string[]>;
const EMPTY_TASK_LISTS: TaskOperatorLists = { doffing: [], loading: [], fractureRepairing: [], diesChange: [], defectRepairing: [] };

const CLEARED_TASK_OPERATORS: Partial<ProductionMachineAssignment> = Object.fromEntries(
  Object.values(TASK_OPERATOR_FIELDS).map((field) => [field, undefined]),
);

function taskOperatorIdsOf(a: ProductionMachineAssignment | undefined): string[] {
  return Object.values(TASK_OPERATOR_FIELDS).flatMap((field) => a?.[field] ?? []);
}

/** The value every given assignment shares; undefined when they differ or none is set. */
function sharedValue<T>(values: (T | undefined)[]): T | undefined {
  const distinct = new Set(values);
  return distinct.size === 1 ? values[0] : undefined;
}


function withoutOperator(ids: string[] | undefined, operatorId: string): string[] | undefined {
  const remaining = ids?.filter((id) => id !== operatorId);
  return remaining && remaining.length > 0 ? remaining : undefined;
}

/** Only picks which operator fields Assign Selection shows — never stored, and switching it keeps
 * the other type's operators (a machine may have both). */
type AssignType = 'multi' | 'split';
const ASSIGN_TYPE_TABS: { value: AssignType; label: string }[] = [
  { value: 'multi', label: 'Multi Task' },
  { value: 'split', label: 'Split Task' },
];

/** Multi Task unless the selection only has Split Task operators. */
function assignTypeFor(assignments: ProductionMachineAssignment[]): AssignType {
  if (assignments.some((a) => a.assignedOperatorIds?.length)) return 'multi';
  return assignments.some((a) => taskOperatorIdsOf(a).length > 0) ? 'split' : 'multi';
}

type CanvasViewMode = 'construction' | 'operator';
const CANVAS_VIEW_STORAGE_KEY = 'workload-production-canvas-view';

function readCanvasViewMode(): CanvasViewMode {
  try {
    return localStorage.getItem(CANVAS_VIEW_STORAGE_KEY) === 'operator' ? 'operator' : 'construction';
  } catch {
    return 'construction';
  }
}

/** Same gray as the `.machine-plan-unplanned` body — used for anything not assigned yet. */
const UNASSIGNED_FILL = '#334155';
const OPERATOR_VIEW_BASE_FILL = '#0f172a';

type OperatorSlot = { label: string; field: TaskOperatorField };
const DOFFING_SLOT: OperatorSlot = { label: 'Doffing', field: 'doffingOperatorIds' };
const LOADING_SLOT: OperatorSlot = { label: 'Loading', field: 'loadingOperatorIds' };
const FRACTURE_SLOT: OperatorSlot = { label: 'Fracture Repairing', field: 'fractureRepairingOperatorIds' };
const DEFECT_SLOT: OperatorSlot = { label: 'Defect Repairing', field: 'defectRepairingOperatorIds' };
const DIES_SLOT: OperatorSlot = { label: 'Dies Change', field: 'diesChangeOperatorIds' };

/** Body slices shown in Operator View, in order: CB/BU/SP/CH/CR add Defect Repairing, WW/BA/CA
 * add Dies Change instead; any other (or unknown) Area only has the three common tasks. */
function operatorSlotsForArea(area: string | undefined): OperatorSlot[] {
  if (area && ['CB', 'BU', 'SP', 'CH', 'CR'].includes(area)) return [DOFFING_SLOT, LOADING_SLOT, FRACTURE_SLOT, DEFECT_SLOT];
  if (area && ['WW', 'BA', 'CA'].includes(area)) return [DOFFING_SLOT, LOADING_SLOT, FRACTURE_SLOT, DIES_SLOT];
  return [DOFFING_SLOT, LOADING_SLOT, FRACTURE_SLOT];
}

/** Who the Operator View colors a slot with: its first Split Task operator, else the first Multi
 * Task operator — blank stays blank (gray) until someone may do it. */
function operatorForSlot(a: ProductionMachineAssignment | undefined, slot: OperatorSlot): string | undefined {
  return a?.[slot.field]?.[0] ?? a?.assignedOperatorIds?.[0];
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (value: string | number) => {
    const str = String(value ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Minimal RFC4180-ish CSV parser — handles quoted fields (with escaped "" and embedded commas /
 * newlines), matching what downloadCsv() above produces plus what Excel typically saves. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // skip — \n (below) closes the row
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

export function ProductionSimulationPage() {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const [summaries, setSummaries] = useState<ProductionSetupSummary[]>([]);
  const [loadingSummaries, setLoadingSummaries] = useState(true);
  const [summariesError, setSummariesError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSetup, setSelectedSetup] = useState<ProductionSetup | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>([]);
  const [creatingFromLayoutId, setCreatingFromLayoutId] = useState('');
  const [newSetupName, setNewSetupName] = useState('');
  const [creatingSetup, setCreatingSetup] = useState(false);
  const [createProgress, setCreateProgress] = useState<{ done: number; total: number } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);

  const [products, setProducts] = useState<Mpp_wl_productses[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [productsReloadKey, setProductsReloadKey] = useState(0);
  const [creatorNames, setCreatorNames] = useState<Map<string, string>>(new Map());
  const [setupSearchTerm, setSetupSearchTerm] = useState('');

  // `createdbyname` from Dataverse comes back blank for records created through this app's own
  // connection — resolve real display names from the stamped creator email via Office365Users
  // instead (see userDirectory.ts), once per unique email in the loaded list.
  const creatorNameFor = (s: ProductionSetupSummary) => {
    if (s.createdByEmail) {
      if (s.createdByEmail.trim().toLowerCase() === user.email.trim().toLowerCase()) return user.displayName;
      return creatorNames.get(s.createdByEmail.trim().toLowerCase()) ?? s.createdByEmail;
    }
    return s.createdByName || 'Unknown';
  };

  // Split so the initial load (where `loadingSummaries` already starts true) doesn't set state
  // synchronously inside the mount effect; the Retry button goes through refreshSummaries().
  const fetchSummaries = () => {
    listProductionSetupSummaries()
      .then((result) => {
        const visible = isAdmin ? result : result.filter((s) => isOwnedByCurrentUser(s, user));
        setSummaries(visible);
        const emailsToResolve = visible
          .map((s) => s.createdByEmail)
          .filter((email) => email && email.trim().toLowerCase() !== user.email.trim().toLowerCase());
        if (emailsToResolve.length > 0) {
          resolveDisplayNames(emailsToResolve).then(setCreatorNames);
        }
      })
      .catch((err) => setSummariesError(err instanceof Error ? err.message : 'Failed to load Production Setups.'))
      .finally(() => setLoadingSummaries(false));
  };

  const refreshSummaries = () => {
    setLoadingSummaries(true);
    setSummariesError(null);
    fetchSummaries();
  };

  // Mount-only on purpose: fetchSummaries is recreated every render.
  useEffect(() => {
    fetchSummaries();
    loadSavedLayouts()
      .then(setSavedLayouts)
      .catch(() => {
        // Layout picker just stays empty if this fails — creating a setup will show no options.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `loadingProducts` starts true for the first load; the Retry button (reloadProducts) resets
  // loading/error itself before bumping productsReloadKey.
  useEffect(() => {
    let cancelled = false;
    fetchAllPages(Mpp_wl_productsesService.getAll, { orderBy: ['mpp_constructiondetailcode asc'] })
      .then((data) => {
        if (!cancelled) setProducts(data);
      })
      .catch((err) => {
        if (!cancelled) setProductsError(err instanceof Error ? err.message : 'Failed to load WL_Products.');
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productsReloadKey]);

  const constructionLabelById = useMemo(
    () => new Map(products.map((p) => [p.mpp_wl_productsid, p.mpp_constructiondetailcode ?? p.mpp_wl_productsid])),
    [products],
  );

  // Loads the full setup (header + every operator + every machine assignment) only once a setup
  // is actually selected — the list view above never fetches per-machine rows, see
  // listProductionSetupSummaries. Waits for WL_Products so Construction labels resolve correctly
  // instead of racing an empty product list.
  useEffect(() => {
    if (!selectedId || loadingProducts) {
      // Selection-driven reset/fetch: selectedId changes from many places (list clicks, create,
      // delete), so resetting here keeps them all consistent.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!selectedId) setSelectedSetup(null);
      return;
    }
    let cancelled = false;
    setLoadingSetup(true);
    setSetupError(null);
    loadProductionSetup(selectedId, constructionLabelById)
      .then((setup) => {
        if (!cancelled) setSelectedSetup(setup);
      })
      .catch((err) => {
        if (!cancelled) setSetupError(err instanceof Error ? err.message : 'Failed to load Production Setup.');
      })
      .finally(() => {
        if (!cancelled) setLoadingSetup(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, loadingProducts]);

  const createSetup = async () => {
    const layout = savedLayouts.find((l) => l.id === creatingFromLayoutId);
    if (!layout || !newSetupName.trim()) return;
    setCreatingSetup(true);
    setCreateProgress({ done: 0, total: layout.machines.length });
    setSummariesError(null);
    try {
      const defaults = await loadDefaultValuesOrBuiltIn();
      const setup = await createProductionSetup(
        newSetupName.trim(),
        layout.machines,
        (done, total) => setCreateProgress({ done, total }),
        user.email,
        layout.operatorStart,
        layout.walls,
        layout.remarks,
        defaults,
      );
      setSummaries((prev) => [
        ...prev,
        {
          id: setup.id,
          name: setup.name,
          operatorCount: 0,
          machineCount: setup.layout.length,
          updatedAt: setup.updatedAt,
          createdAt: setup.updatedAt,
          createdByEmail: user.email,
          createdByName: user.displayName,
        },
      ]);
      setSelectedSetup(setup);
      setSelectedId(setup.id);
      setNewSetupName('');
      setCreatingFromLayoutId('');
    } catch (err) {
      setSummariesError(err instanceof Error ? err.message : 'Failed to create Production Setup.');
    } finally {
      setCreatingSetup(false);
      setCreateProgress(null);
    }
  };

  const canDelete = (s: ProductionSetupSummary) => isAdmin || isOwnedByCurrentUser(s, user);

  const filteredSummaries = summaries
    .filter((s) => {
      const q = setupSearchTerm.trim().toLowerCase();
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || creatorNameFor(s).toLowerCase().includes(q);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const deleteSetup = async (id: string) => {
    const summary = summaries.find((s) => s.id === id);
    if (!summary || !canDelete(summary)) return;
    if (!window.confirm(`Delete Production Setup "${summary.name}"?`)) return;
    setDeletingId(id);
    setDeleteProgress({ done: 0, total: summary.machineCount });
    setSummariesError(null);
    try {
      await deleteProductionSetup(id, (done, total) => setDeleteProgress({ done, total }));
      setSummaries((prev) => prev.filter((s) => s.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (err) {
      setSummariesError(err instanceof Error ? err.message : 'Failed to delete Production Setup.');
    } finally {
      setDeletingId(null);
      setDeleteProgress(null);
    }
  };

  /** Optimistic local-state patch for the currently loaded setup — callers that already wrote
   * their own change to Dataverse (add/remove operator, bulk assign, CSV import, header edits)
   * use this just to keep the in-memory copy in sync, not to trigger any persistence itself. */
  const patchLocalSetup = (patch: Partial<ProductionSetup>) => {
    const updatedAt = Date.now();
    setSelectedSetup((prev) => (prev ? { ...prev, ...patch, updatedAt } : prev));
    if (selectedId) {
      setSummaries((prev) => prev.map((summary) => (summary.id === selectedId ? { ...summary, updatedAt } : summary)));
    }
  };

  const [runState, setRunState] = useState<{ setup: ProductionSetup; resolved: Map<string, ResolvedConstruction>; errors: string[] } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [plannedResolution, setPlannedResolution] = useState<{
    utilization: PlannedUtilization | null;
    resolved: Map<string, ResolvedConstruction> | null;
    errors: string[];
    loading: boolean;
  }>({ utilization: null, resolved: null, errors: [], loading: false });

  useEffect(() => {
    if (!selectedSetup || loadingProducts) return;
    const productIds = Array.from(
      new Set(selectedSetup.assignments.map((assignment) => assignment.constructionDetailId).filter((id): id is string => !!id)),
    );
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (!cancelled) setPlannedResolution((previous) => ({ ...previous, loading: true, errors: [] }));
        return resolveConstructions(productIds, products);
      })
      .then(({ resolved, errors }) => {
        if (!cancelled) {
          setPlannedResolution({
            utilization: calculatePlannedUtilization(selectedSetup, resolved),
            resolved,
            errors,
            loading: false,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPlannedResolution({
            utilization: null,
            resolved: null,
            errors: [err instanceof Error ? err.message : 'Failed to resolve Construction Details for planned utilization.'],
            loading: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSetup, products, loadingProducts]);

  const runSimulation = async (setup: ProductionSetup) => {
    if (loadingProducts) return;
    setResolving(true);
    try {
      const productIds = Array.from(new Set(setup.assignments.map((a) => a.constructionDetailId).filter((id): id is string => !!id)));
      if (products.length === 0 && productIds.length > 0) {
        setRunState({
          setup,
          resolved: new Map(),
          errors: [
            productsError
              ? `Could not load WL_Products (${productsError}) — cannot resolve any Construction Detail. Fix the connection and try again.`
              : 'WL_Products list is empty — cannot resolve any Construction Detail assigned in this setup.',
          ],
        });
        return;
      }
      const { resolved, errors } = await resolveConstructions(productIds, products);
      setRunState({ setup, resolved, errors });
    } finally {
      setResolving(false);
    }
  };

  if (runState) {
    return (
      <ProductionRunView
        setup={runState.setup}
        resolved={runState.resolved}
        resolveErrors={runState.errors}
        allProductIds={products.map((p) => p.mpp_wl_productsid)}
        onBack={() => setRunState(null)}
      />
    );
  }

  return (
    <div className="layout-manager-grid">
      {productsError && (
        <div className="production-run-warnings" style={{ gridColumn: '1 / -1' }}>
          <div>Failed to load WL_Products: {productsError}</div>
          <Button
            variant="secondary"
            onClick={() => {
              setLoadingProducts(true);
              setProductsError(null);
              setProductsReloadKey((k) => k + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {summariesError && (
        <div className="production-run-warnings" style={{ gridColumn: '1 / -1' }}>
          <div>{summariesError}</div>
          <Button variant="secondary" onClick={refreshSummaries}>
            Retry
          </Button>
        </div>
      )}
      <Card
        title="Production Setups"
        subtitle="Snapshot of a Layout plus Construction & per-activity operator assignment per machine"
        className="layout-manager-sidebar-card"
      >
        <div className="production-new-setup">
          {savedLayouts.length === 0 ? (
            <p className="data-manager-hint">Create a Layout first in the "Layouts" menu before creating a Production Setup.</p>
          ) : (
            <>
              <select className="input" value={creatingFromLayoutId} onChange={(e) => setCreatingFromLayoutId(e.target.value)} disabled={creatingSetup}>
                <option value="">Select Layout…</option>
                {savedLayouts.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.machines.length} machines)
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="Setup name"
                value={newSetupName}
                onChange={(e) => setNewSetupName(e.target.value)}
                disabled={creatingSetup}
              />
              <Button variant="secondary" onClick={createSetup} disabled={!creatingFromLayoutId || !newSetupName.trim() || creatingSetup}>
                {creatingSetup
                  ? createProgress && createProgress.total > 0
                    ? `Creating… (${createProgress.done}/${createProgress.total})`
                    : 'Creating…'
                  : '+ New Setup'}
              </Button>
              {creatingSetup && (
                <p className="data-manager-hint">Creating machine rows in Dataverse — this can take a while for large layouts, please wait.</p>
              )}
            </>
          )}
        </div>
        {loadingSummaries ? (
          <p className="data-manager-hint">Loading…</p>
        ) : summaries.length === 0 ? (
          <p className="data-manager-hint">No Production Setups yet.</p>
        ) : (
          <>
            <input
              className="input list-search-input"
              placeholder="Search by name or creator…"
              value={setupSearchTerm}
              onChange={(e) => setSetupSearchTerm(e.target.value)}
            />
            {filteredSummaries.length === 0 ? (
              <p className="data-manager-hint">No Production Setups match "{setupSearchTerm}".</p>
            ) : (
              <div className="layout-list-scroll">
                <ul className="layout-list">
                  {filteredSummaries.map((s) => (
                    <li key={s.id} className={`layout-list-item ${selectedId === s.id ? 'active' : ''}`}>
                      <button
                        type="button"
                        className="layout-list-select"
                        title={`Last modified: ${new Date(s.updatedAt).toLocaleString()}`}
                        onClick={() => setSelectedId(s.id)}
                      >
                        <span className="layout-list-name">{s.name}</span>
                        <span className="layout-list-count">
                          {s.machineCount} machines · {s.operatorCount} operators
                        </span>
                        <span className="layout-list-count">
                          By {creatorNameFor(s)} · {new Date(s.createdAt).toLocaleString()}
                        </span>
                      </button>
                      <div className="layout-list-actions">
                        {canDelete(s) && (
                          <Button variant="danger" onClick={() => deleteSetup(s.id)} disabled={deletingId !== null}>
                            {deletingId === s.id
                              ? deleteProgress && deleteProgress.total > 0
                                ? `Deleting… (${deleteProgress.done}/${deleteProgress.total})`
                                : 'Deleting…'
                              : 'Delete'}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="layout-manager-editor production-editor">
        {setupError && <div className="production-run-warnings">{setupError}</div>}
        {loadingSetup ? (
          <Card title="Loading Setup">
            <p className="data-manager-hint">Loading…</p>
          </Card>
        ) : selectedSetup ? (
          <ProductionSetupEditor
            key={selectedSetup.id}
            setup={selectedSetup}
            products={products}
            loadingProducts={loadingProducts}
            onLocalChange={patchLocalSetup}
            onRun={() => runSimulation(selectedSetup)}
            onOperatorCountChange={(delta) =>
              setSummaries((prev) => prev.map((s) => (s.id === selectedSetup.id ? { ...s, operatorCount: s.operatorCount + delta } : s)))
            }
            resolving={resolving}
            plannedUtilization={plannedResolution.utilization}
            plannedUtilizationErrors={plannedResolution.errors}
            plannedUtilizationLoading={plannedResolution.loading}
            resolvedConstructions={plannedResolution.resolved}
          />
        ) : (
          <Card title="No Setup Selected">
            <p className="data-manager-hint">Select a Layout then click "+ New Setup" to create a new one.</p>
          </Card>
        )}
      </div>
    </div>
  );
}

function ProductionSetupEditor({
  setup,
  products,
  loadingProducts,
  onLocalChange,
  onRun,
  onOperatorCountChange,
  resolving,
  plannedUtilization,
  plannedUtilizationErrors,
  plannedUtilizationLoading,
  resolvedConstructions,
}: {
  setup: ProductionSetup;
  products: Mpp_wl_productses[];
  loadingProducts: boolean;
  onLocalChange: (patch: Partial<ProductionSetup>) => void;
  onRun: () => void;
  onOperatorCountChange: (delta: number) => void;
  resolving: boolean;
  plannedUtilization: PlannedUtilization | null;
  plannedUtilizationErrors: string[];
  plannedUtilizationLoading: boolean;
  resolvedConstructions: Map<string, ResolvedConstruction> | null;
}) {
  const [selectedMachineIds, setSelectedMachineIds] = useState<string[]>([]);
  const [newOperatorName, setNewOperatorName] = useState('');
  const [addingOperator, setAddingOperator] = useState(false);
  const [bulkOperatorCount, setBulkOperatorCount] = useState(20);
  const [bulkOperatorPrefix, setBulkOperatorPrefix] = useState('Opr');
  const [addingBulkOperators, setAddingBulkOperators] = useState(false);
  const [bulkConstructionId, setBulkConstructionId] = useState('');
  const [assignType, setAssignType] = useState<AssignType>('multi');
  const [bulkMultiTaskIds, setBulkMultiTaskIds] = useState<string[]>([]);
  const [bulkTaskIds, setBulkTaskIds] = useState<TaskOperatorLists>(EMPTY_TASK_LISTS);
  // Tracks what's actually applied on the selected machines right now (as of the last selection
  // change or Apply click) — compared against the bulk* form values above to flag an Apply button
  // yellow whenever the form has moved away from what's currently on the machines.
  const [appliedConstructionId, setAppliedConstructionId] = useState('');
  const [appliedMultiTaskIds, setAppliedMultiTaskIds] = useState<string[]>([]);
  const [appliedTaskIds, setAppliedTaskIds] = useState<TaskOperatorLists>(EMPTY_TASK_LISTS);
  /** Machine-level Doff Priority; undefined = follow the setup's. */
  const [bulkDoffPriority, setBulkDoffPriority] = useState<boolean | undefined>(undefined);
  const [bulkMinRemain, setBulkMinRemain] = useState<number | undefined>(undefined);
  const [bulkGroupName, setBulkGroupName] = useState('');
  const [appliedGroupName, setAppliedGroupName] = useState('');
  const [assignmentsGroupBy, setAssignmentsGroupBy] = useState<MachineAssignmentsGroupBy>('none');
  const [assignmentsSearch, setAssignmentsSearch] = useState('');
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [plannedUtilizationOpen, setPlannedUtilizationOpen] = useState(false);
  const [startTimesOpen, setStartTimesOpen] = useState(false);
  const [plannedUtilizationFullscreen, setPlannedUtilizationFullscreen] = useState(false);
  const plannedUtilizationPanelRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [canvasView, setCanvasView] = useState<CanvasViewMode>(readCanvasViewMode);
  const changeCanvasView = (mode: CanvasViewMode) => {
    setCanvasView(mode);
    try {
      localStorage.setItem(CANVAS_VIEW_STORAGE_KEY, mode);
    } catch {
      // Preference just isn't remembered if storage is unavailable.
    }
  };

  const assignmentByMachine = new Map(setup.assignments.map((a) => [a.machineId, a]));
  const areaByConstructionId = new Map(
    products
      .filter((product) => product.mpp_wl_productsid && product.mpp_area)
      .map((product) => [product.mpp_wl_productsid, product.mpp_area!.trim().toUpperCase()]),
  );
  const operatorLabelById = useMemo(() => new Map(setup.operators.map((o) => [o.id, o.label])), [setup.operators]);
  const operatorLabel = useCallback((id?: string) => (id ? operatorLabelById.get(id) ?? '—' : '—'), [operatorLabelById]);


  // Every Construction used in this setup gets its own fill (ordered like WL_Products, so it
  // matches the dropdown); every operator likewise gets its own.
  const constructionFillMap = useMemo(
    () => buildSetupConstructionColorMap(setup.assignments.map((a) => a.constructionDetailId), products.map((p) => p.mpp_wl_productsid)),
    [setup.assignments, products],
  );
  const operatorFillMap = useMemo(() => buildDistinctColorMap(setup.operators.map((o) => o.id)), [setup.operators]);
  const operatorUtilizationFor = (id: string) =>
    plannedUtilization?.operators.find((item) => item.operatorId === id);
  const operatorForecastLabel = (id: string, label: string) => {
    const forecast = operatorUtilizationFor(id)?.forecastUtilizationPercent;
    return `${label}${forecast === undefined ? '' : ` (${forecast.toFixed(1)}%)`}`;
  };
  const operatorIdealDemandTooltip = (id: string) => {
    const operator = operatorUtilizationFor(id);
    return operator && operator.forecastUtilizationPercent >= 100
      ? `Ideal demand: ${operator.utilizationPercent.toFixed(1)}%`
      : undefined;
  };
  const operatorOptions = setup.operators.map((operator) => {
    return {
      value: operator.id,
      label: operatorForecastLabel(operator.id, operator.label),
    };
  });

  /** Prefills the bulk-assign fields with whatever the selected machines already have applied —
   * only when every selected machine agrees on that field (same Construction, or same operator
   * per activity); a mixed selection blanks that field instead of guessing. */
  useEffect(() => {
    const selectedAssignments = selectedMachineIds
      .map((id) => setup.assignments.find((a) => a.machineId === id))
      .filter((a): a is ProductionMachineAssignment => !!a);
    // Operators only ever land on planned machines, so unplanned ones don't count toward them.
    const plannedAssignments = selectedAssignments.filter((a) => a.constructionDetailId);
    const commonValue = (
      getter: (a: ProductionMachineAssignment) => string | undefined,
      assignments = plannedAssignments,
    ): string => {
      if (assignments.length === 0) return '';
      const values = new Set(assignments.map((a) => getter(a) ?? ''));
      return values.size === 1 ? [...values][0] : '';
    };
    const construction = commonValue((a) => a.constructionDetailId, selectedAssignments);
    /** The operator list every planned selected machine shares; empty when they differ. */
    const commonList = (getter: (a: ProductionMachineAssignment) => string[] | undefined): string[] => {
      const key = commonValue((a) => operatorSetKey(getter(a)));
      return key ? key.split(';') : [];
    };
    const multiTask = commonList((a) => a.assignedOperatorIds);
    const taskLists = Object.fromEntries(
      TASK_ROWS.map(({ family }) => [family, commonList((a) => a[TASK_OPERATOR_FIELDS[family]])]),
    ) as TaskOperatorLists;
    // Intentional selection → form sync (see comment above); the fields stay user-editable after.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBulkConstructionId(construction);
    setAppliedConstructionId(construction);
    setAssignType(assignTypeFor(plannedAssignments));
    setBulkMultiTaskIds(multiTask);
    setAppliedMultiTaskIds(multiTask);
    setBulkTaskIds(taskLists);
    setAppliedTaskIds(taskLists);
    setBulkDoffPriority(sharedValue(selectedAssignments.map((a) => a.doffPriority)));
    setBulkMinRemain(sharedValue(selectedAssignments.map((a) => a.minRemainForDoffPriority)));
    const groupName = commonValue((a) => a.groupName, selectedAssignments);
    setBulkGroupName(groupName);
    setAppliedGroupName(groupName);
    // Deliberately NOT depending on setup.assignments: this should only resync when the SELECTION
    // itself changes, not every time any field gets applied — otherwise applying just one of the
    // pending fields (e.g. Doffing) would also silently wipe out the user's still-unapplied
    // picks in the other three, since this would re-read their "actual" (unchanged) values from
    // setup.assignments and stomp over the pending dropdown state. Explicit apply/unplan handlers
    // update applied*/bulk* state themselves for the field(s) they actually touch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMachineIds]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === plannedUtilizationPanelRef.current;
      setPlannedUtilizationFullscreen(active);
      if (!active) setPlannedUtilizationOpen(false);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!plannedUtilizationOpen || plannedUtilizationFullscreen) return;
    const panel = plannedUtilizationPanelRef.current;
    if (!panel) return;
    const enterFullscreen = async () => {
      try {
        if (document.fullscreenElement && document.fullscreenElement !== panel) {
          await document.exitFullscreen();
        }
        await panel.requestFullscreen();
      } catch (err) {
        setPlannedUtilizationOpen(false);
        setActionError(err instanceof Error ? err.message : 'Unable to open planned utilization fullscreen view.');
      }
    };
    void enterFullscreen();
  }, [plannedUtilizationOpen, plannedUtilizationFullscreen]);


  const machineAppearance = (m: LayoutMachine): MachineAppearance => {
    const a = assignmentByMachine.get(m.id);
    const area = a?.constructionDetailId ? areaByConstructionId.get(a.constructionDetailId) : undefined;
    const slots = operatorSlotsForArea(area);
    // A Multi Task-only machine splits its body by operator; anything with Split Task operators by
    // activity slot.
    const multiTaskOnly = (a?.assignedOperatorIds?.length ?? 0) > 0 && taskOperatorIdsOf(a).length === 0;
    const handlers = multiTaskOnly ? a?.assignedOperatorIds ?? [] : slots.map((slot) => operatorForSlot(a, slot));
    const constructionColor = a?.constructionDetailId ? constructionFillMap.get(a.constructionDetailId) : undefined;
    const tooltip = [
      `Machine ${m.label}`,
      `Construction: ${a?.constructionDetailLabel ?? '—'}`,
      `Area: ${area ?? '—'}`,
      `Group: ${a?.groupName ?? '—'}`,
      `Doff Priority: ${doffPriorityText(a) === '—' ? 'follow setup' : doffPriorityText(a)}`,
      ...operatorAssignmentLines(a, (id) => operatorLabel(id)),
    ].join('\n');

    if (canvasView === 'operator') {
      // Border = Construction color whenever one is assigned, even before any operator is.
      if (handlers.every((id) => !id)) return { status: 'unplanned', borderColor: constructionColor, tooltip };
      return {
        fill: OPERATOR_VIEW_BASE_FILL,
        borderColor: constructionColor,
        segments: handlers.map((id) => (id ? operatorFillMap.get(id) ?? UNASSIGNED_FILL : UNASSIGNED_FILL)),
        tooltip,
      };
    }

    if (!a?.constructionDetailId) return { status: 'unplanned', tooltip };
    return {
      fill: constructionColor ?? UNASSIGNED_FILL,
      borderColor: 'rgba(226, 232, 240, 0.55)',
      tooltip,
    };
  };

  const constructionLabelById = new Map(
    setup.assignments
      .filter((a) => a.constructionDetailId)
      .map((a) => [a.constructionDetailId as string, a.constructionDetailLabel ?? (a.constructionDetailId as string)]),
  );

  // Legend: which machines each Construction / operator covers, so hovering an entry can
  // highlight exactly those machines on the canvas.
  const legendData = buildCanvasLegendData({
    machineIds: setup.layout.map((m) => m.id),
    assignmentByMachineId: assignmentByMachine,
    constructionColors: constructionFillMap,
    constructionLabel: (id) => constructionLabelById.get(id) ?? id,
    operators: setup.operators.map((o) => ({ id: o.id, label: o.label, color: operatorFillMap.get(o.id) ?? UNASSIGNED_FILL })),
    unassignedColor: UNASSIGNED_FILL,
  });
  const [legendHover, setLegendHover] = useState<LegendHover>(null);
  const highlightedMachineIds = legendData.highlightFor(legendHover);
  const canvasLegend = (
    <CanvasLegendPanel
      constructionEntries={legendData.constructionEntries}
      operatorEntries={legendData.operatorEntries.map((entry) => {
        const forecast = operatorUtilizationFor(entry.id)?.forecastUtilizationPercent;
        return forecast === undefined ? entry : { ...entry, detail: `${forecast.toFixed(1)}%` };
      })}
      groupEntries={legendData.groupEntries}
      initialTab={canvasView}
      onHover={setLegendHover}
      hints={{
        construction: 'Construction Detail View: body color = Construction. Hover an entry to highlight its machines.',
        group: "Machines by Group Name. Hover an entry to highlight that group's machines.",
        operator:
          'Operator View: machines with Split Task operators split the body Doffing | Loading | Fracture Repairing | Defect Repairing (CB/BU/SP/CH/CR) or Dies Change (WW/BA/CA), each colored by its first operator; Multi Task-only machines split it by their operators; gray = not assigned yet; border = Construction. Hover an entry to highlight its machines.',
      }}
    />
  );

  const canvasViewSelect = (
    <select
      className="input toolbar-view-select"
      value={canvasView}
      onChange={(e) => changeCanvasView(e.target.value as CanvasViewMode)}
      title="Color machines by Construction Detail or by assigned operators"
      aria-label="Canvas view"
    >
      <option value="construction">Construction Detail View</option>
      <option value="operator">Operator View</option>
    </select>
  );

  /** Applies a patch to the selected machines both locally (optimistic) and in Dataverse — every
   * bulk-assign action (Construction / per-activity operator / Unplan) goes through this. */
  const applyBulk = async (patch: Partial<ProductionMachineAssignment>, { plannedOnly = false } = {}) => {
    // Operator patches skip machines with no Construction — an operator on an unplanned machine is meaningless.
    const targetIds = plannedOnly
      ? selectedMachineIds.filter((id) => assignmentByMachine.get(id)?.constructionDetailId)
      : selectedMachineIds;
    if (targetIds.length === 0) return;
    const targetSet = new Set(targetIds);
    onLocalChange({
      assignments: setup.assignments.map((a) => (targetSet.has(a.machineId) ? { ...a, ...patch } : a)),
    });
    setActionError(null);
    try {
      await updateMachineAssignments(
        setup.id,
        targetIds.map((machineId) => ({ machineId, patch })),
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to save assignment.');
    }
  };

  const resetOperatorFields = () => {
    setBulkMultiTaskIds([]);
    setAppliedMultiTaskIds([]);
    setBulkTaskIds(EMPTY_TASK_LISTS);
    setAppliedTaskIds(EMPTY_TASK_LISTS);
  };

  const unplanSelection = async () => {
    if (selectedMachineIds.length === 0) return;
    await applyBulk({
      constructionDetailId: undefined,
      constructionDetailLabel: undefined,
      ...CLEARED_TASK_OPERATORS,
      groupName: undefined,
      assignedOperatorIds: undefined,
      doffPriority: undefined,
      minRemainForDoffPriority: undefined,
    });
    setBulkDoffPriority(undefined);
    setBulkMinRemain(undefined);
    setBulkConstructionId('');
    setAppliedConstructionId('');
    setBulkGroupName('');
    setAppliedGroupName('');
    resetOperatorFields();
  };

  const buildBulkOperatorLabels = (prefix: string, count: number): string[] => {
    const safeCount = Number.isFinite(count) ? Math.max(1, Math.min(Math.floor(count), 500)) : 1;
    const trimmedPrefix = prefix.trim();
    const labelPrefix = trimmedPrefix
      ? trimmedPrefix
          .replace(/\s+/g, '_')
          .replace(/^[a-z]/, (char) => char.toUpperCase())
      : 'Operator';
    return Array.from({ length: safeCount }, (_, index) => `${labelPrefix}_${String(index + 1).padStart(4, '0')}`);
  };

  const operatorNameExists = (label: string) =>
    setup.operators.some((o) => o.label.trim().toLowerCase() === label.trim().toLowerCase());

  const addOperator = async () => {
    const label = newOperatorName.trim();
    if (!label) return;
    if (operatorNameExists(label)) {
      setActionError(`Operator "${label}" already exists in this setup.`);
      return;
    }
    setAddingOperator(true);
    setActionError(null);
    try {
      const operator = await addProductionOperator(setup.id, label);
      onLocalChange({ operators: [...setup.operators, operator] });
      onOperatorCountChange(1);
      setNewOperatorName('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add operator.');
    } finally {
      setAddingOperator(false);
    }
  };

  const addBulkOperators = async () => {
    const prefix = bulkOperatorPrefix.trim();
    if (!prefix) return;
    const labels = buildBulkOperatorLabels(prefix, bulkOperatorCount).filter((label) => !operatorNameExists(label));
    if (labels.length === 0) {
      setActionError('All generated operator names already exist in this setup — try a different prefix.');
      return;
    }
    setAddingBulkOperators(true);
    setActionError(null);
    try {
      const created = [] as typeof setup.operators;
      for (const label of labels) {
        const operator = await addProductionOperator(setup.id, label);
        created.push(operator);
      }
      onLocalChange({ operators: [...setup.operators, ...created] });
      onOperatorCountChange(created.length);
      setBulkOperatorCount(20);
      setBulkOperatorPrefix('Opr');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add operators.');
    } finally {
      setAddingBulkOperators(false);
    }
  };

  const removeOperator = async (id: string) => {
    setActionError(null);
    try {
      await removeProductionOperator(setup.id, id);
      onLocalChange({
        operators: setup.operators.filter((o) => o.id !== id),
        assignments: setup.assignments.map((a) => ({
          ...a,
          ...Object.fromEntries(Object.values(TASK_OPERATOR_FIELDS).map((field) => [field, withoutOperator(a[field], id)])),
          assignedOperatorIds: withoutOperator(a.assignedOperatorIds, id),
        })),
      });
      const withoutInLists = (lists: TaskOperatorLists) =>
        Object.fromEntries(Object.entries(lists).map(([family, ids]) => [family, ids.filter((listId) => listId !== id)])) as TaskOperatorLists;
      setBulkMultiTaskIds((prev) => prev.filter((listId) => listId !== id));
      setAppliedMultiTaskIds((prev) => prev.filter((listId) => listId !== id));
      setBulkTaskIds(withoutInLists);
      setAppliedTaskIds(withoutInLists);
      onOperatorCountChange(-1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove operator.');
    }
  };

  const applyConstruction = () => {
    const product = products.find((p) => p.mpp_wl_productsid === bulkConstructionId);
    if (!product) return;
    applyBulk({ constructionDetailId: product.mpp_wl_productsid, constructionDetailLabel: product.mpp_constructiondetailcode });
    setAppliedConstructionId(bulkConstructionId);
  };

  /** Sets the selection's Multi Task operators. Removing ([]) clears every selected machine;
   * assigning skips unplanned ones. */
  const applyMultiTaskOperators = (operatorIds: string[]) => {
    void applyBulk({ assignedOperatorIds: operatorIds.length > 0 ? operatorIds : undefined }, { plannedOnly: operatorIds.length > 0 });
    setBulkMultiTaskIds(operatorIds);
    setAppliedMultiTaskIds(operatorIds);
  };

  /** Sets one activity's Split Task operators on the selection, same rules as Multi Task. */
  const applyTaskOperators = (family: ProductionActivityFamily, operatorIds: string[]) => {
    void applyBulk({ [TASK_OPERATOR_FIELDS[family]]: operatorIds.length > 0 ? operatorIds : undefined }, { plannedOnly: operatorIds.length > 0 });
    setBulkTaskIds((prev) => ({ ...prev, [family]: operatorIds }));
    setAppliedTaskIds((prev) => ({ ...prev, [family]: operatorIds }));
  };

  /** undefined for both = follow the setup's Doff Priority again. */
  const applyMachineDoffPriority = (doffPriority: boolean | undefined, minRemain: number | undefined) => {
    void applyBulk({ doffPriority, minRemainForDoffPriority: minRemain });
    setBulkDoffPriority(doffPriority);
    setBulkMinRemain(minRemain);
  };

  const applyGroupName = (groupName: string) => {
    void applyBulk({ groupName: groupName.trim() || undefined });
    setBulkGroupName(groupName.trim());
    setAppliedGroupName(groupName.trim());
  };

  const removeConstruction = () => {
    void applyBulk({ constructionDetailId: undefined, constructionDetailLabel: undefined });
    setBulkConstructionId('');
    setAppliedConstructionId('');
  };

  const operatorLabelOrBlank = (id?: string) => (id ? setup.operators.find((o) => o.id === id)?.label ?? '' : '');
  const operatorLabelsOrBlank = (ids: string[] | undefined) => (ids ?? []).map((id) => operatorLabelOrBlank(id)).filter(Boolean).join(';');

  const exportCsv = () => {
    const headers = [
      'Machine',
      'Construction Detail',
      'Group Name',
      'Multi Task',
      'Doffing',
      'Loading',
      'FractureRepairing',
      'DiesChange',
      'DefectRepairing',
      'Doff Priority',
      'Min Remain Task',
    ];
    const rows = setup.layout.map((m) => {
      const a = assignmentByMachine.get(m.id);
      return [
        m.label,
        a?.constructionDetailLabel ?? '',
        a?.groupName ?? '',
        operatorLabelsOrBlank(a?.assignedOperatorIds),
        ...TASK_ROWS.map(({ family }) => operatorLabelsOrBlank(a?.[TASK_OPERATOR_FIELDS[family]])),
        a?.doffPriority === undefined ? '' : a.doffPriority ? 'Yes' : 'No',
        a?.minRemainForDoffPriority ?? '',
      ];
    });
    downloadCsv(`${setup.name.replace(/[^a-z0-9]+/gi, '_') || 'production-setup'}.csv`, headers, rows);
  };

  /** Re-applies an edited export back onto this setup's assignments — matched by Machine label
   * (must exist in this setup's layout), Construction Detail label (looked up against the live
   * WL_Products list) and operator label (looked up against this setup's own operator list). A
   * blank cell clears that field; an unrecognized Machine/Construction/Operator name is reported
   * instead of silently guessed at. */
  const importCsv = async (file: File) => {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      setImportMessage('CSV is empty or has no data rows.');
      return;
    }
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const colIndex = {
      machine: header.indexOf('machine'),
      construction: header.indexOf('construction detail'),
      doffing: header.indexOf('doffing'),
      loading: header.indexOf('loading'),
      fracture: header.indexOf('fracturerepairing'),
      diesChange: header.indexOf('dieschange'),
      defectRepairing: header.indexOf('defectrepairing'),
      groupName: header.indexOf('group name'),
      // "Operators" is what exports made before Multi Task / Split Task called this column.
      multiTask: header.indexOf('multi task') !== -1 ? header.indexOf('multi task') : header.indexOf('operators'),
      doffPriority: header.indexOf('doff priority'),
      minRemain: header.indexOf('min remain task'),
    };
    if (colIndex.machine === -1) {
      setImportMessage('CSV must have a "Machine" column.');
      return;
    }
    const machineIdByLabel = new Map(setup.layout.map((m) => [m.label, m.id]));
    const productByLabel = new Map(products.map((p) => [p.mpp_constructiondetailcode?.trim(), p]));
    const operatorIdByLabel = new Map(setup.operators.map((o) => [o.label.trim(), o.id]));
    const errors: string[] = [];
    const patchByMachineId = new Map<string, Partial<ProductionMachineAssignment>>();

    rows.slice(1).forEach((cols, i) => {
      const rowNum = i + 2;
      const machineLabel = cols[colIndex.machine]?.trim();
      if (!machineLabel) return;
      const machineId = machineIdByLabel.get(machineLabel);
      if (!machineId) {
        errors.push(`Row ${rowNum}: machine "${machineLabel}" is not in this setup's layout.`);
        return;
      }
      const patch: Partial<ProductionMachineAssignment> = {};
      if (colIndex.construction !== -1) {
        const label = cols[colIndex.construction]?.trim();
        if (!label) {
          patch.constructionDetailId = undefined;
          patch.constructionDetailLabel = undefined;
        } else {
          const product = productByLabel.get(label);
          if (!product) {
            errors.push(`Row ${rowNum}: Construction Detail "${label}" not found in WL_Products.`);
          } else {
            patch.constructionDetailId = product.mpp_wl_productsid;
            patch.constructionDetailLabel = product.mpp_constructiondetailcode;
          }
        }
      }
      if (colIndex.groupName !== -1) patch.groupName = cols[colIndex.groupName]?.trim() || undefined;
      if (colIndex.doffPriority !== -1) {
        const value = (cols[colIndex.doffPriority] ?? '').trim().toLowerCase();
        if (!value) patch.doffPriority = undefined;
        else if (value === 'yes' || value === 'no') patch.doffPriority = value === 'yes';
        else errors.push(`Row ${rowNum}: Doff Priority "${cols[colIndex.doffPriority]}" must be Yes, No or blank.`);
      }
      if (colIndex.minRemain !== -1) {
        const value = (cols[colIndex.minRemain] ?? '').trim();
        const parsed = Number(value);
        if (!value) patch.minRemainForDoffPriority = undefined;
        else if (Number.isFinite(parsed) && parsed >= 0) patch.minRemainForDoffPriority = parsed;
        else errors.push(`Row ${rowNum}: Min Remain Task "${value}" must be a number of minutes or blank.`);
      }
      /** A `;`-separated operator list cell; blank clears it. */
      const operatorList = (idx: number, colName: string): string[] | undefined => {
        const ids: string[] = [];
        (cols[idx] ?? '').split(';').map((label) => label.trim()).filter(Boolean).forEach((label) => {
          const operatorId = operatorIdByLabel.get(label);
          if (operatorId) ids.push(operatorId);
          else errors.push(`Row ${rowNum}: operator "${label}" (${colName}) is not in this setup — add that operator first.`);
        });
        return ids.length > 0 ? [...new Set(ids)] : undefined;
      };
      if (colIndex.multiTask !== -1) patch.assignedOperatorIds = operatorList(colIndex.multiTask, 'Multi Task');
      const operatorColumns: [TaskOperatorField, number, string][] = [
        ['doffingOperatorIds', colIndex.doffing, 'Doffing'],
        ['loadingOperatorIds', colIndex.loading, 'Loading'],
        ['fractureRepairingOperatorIds', colIndex.fracture, 'FractureRepairing'],
        ['diesChangeOperatorIds', colIndex.diesChange, 'DiesChange'],
        ['defectRepairingOperatorIds', colIndex.defectRepairing, 'DefectRepairing'],
      ];
      operatorColumns.forEach(([field, idx, colName]) => {
        if (idx !== -1) patch[field] = operatorList(idx, colName);
      });
      // An operator is either Multi Task or Split Task on a machine — Multi Task wins.
      const merged = { ...assignmentByMachine.get(machineId), ...patch } as ProductionMachineAssignment;
      const multiTask = new Set(merged.assignedOperatorIds ?? []);
      operatorColumns.forEach(([field, , colName]) => {
        const clash = (merged[field] ?? []).filter((id) => multiTask.has(id));
        if (clash.length === 0) return;
        errors.push(
          `Row ${rowNum}: ${clash.map((id) => operatorLabelOrBlank(id)).join(', ')} is already Multi Task on this machine — removed from ${colName}.`,
        );
        const remaining = (merged[field] ?? []).filter((id) => !multiTask.has(id));
        patch[field] = remaining.length > 0 ? remaining : undefined;
      });
      patchByMachineId.set(machineId, patch);
    });

    onLocalChange({
      assignments: setup.assignments.map((a) => (patchByMachineId.has(a.machineId) ? { ...a, ...patchByMachineId.get(a.machineId) } : a)),
    });
    setActionError(null);
    const changes = Array.from(patchByMachineId.entries()).map(([machineId, patch]) => ({ machineId, patch }));
    if (changes.length === 0) {
      setImportMessage(
        errors.length > 0
          ? `Import finished with ${errors.length} issue(s): ${errors.slice(0, 5).join(' ')}${errors.length > 5 ? ' …' : ''}`
          : 'Import did not contain any valid machine assignments.',
      );
      return;
    }
    setImportProgress({ done: 0, total: changes.length });
    setImportMessage(`Importing assignments: 0/${changes.length}`);
    let saveError: string | null = null;
    try {
      await updateMachineAssignments(setup.id, changes, (done, total) => {
        setImportProgress({ done, total });
        setImportMessage(`Importing assignments: ${done}/${total}`);
      });
    } catch (err) {
      saveError = err instanceof Error ? err.message : 'Failed to save imported assignments.';
      setActionError(saveError);
    } finally {
      setImportProgress(null);
    }
    if (saveError) {
      setImportMessage(`Import stopped after a save error: ${saveError}`);
    } else {
      setImportMessage(
        errors.length > 0
          ? `Import finished with ${errors.length} issue(s): ${errors.slice(0, 5).join(' ')}${errors.length > 5 ? ' …' : ''}`
          : `Successfully imported ${changes.length} row(s).`,
      );
    }
  };

  const persistHeader = useDebouncedCallback((patch: Partial<ProductionSetup>) => {
    updateProductionSetupHeader(setup.id, patch).catch((err) => setActionError(err instanceof Error ? err.message : 'Failed to save setting.'));
  }, 600);

  const onHeaderChange = (patch: Partial<ProductionSetup>) => {
    onLocalChange(patch);
    persistHeader(patch);
  };

  const canRun = setup.operators.length > 0 && setup.assignments.some((a) => a.constructionDetailId);

  const occupationFor = (machineIds: string[]): SelectionOccupation | null =>
    resolvedConstructions && machineIds.length > 0
      ? calculateSelectionOccupation(setup, resolvedConstructions, machineIds)
      : null;
  const selectionOccupation = useMemo(
    () => occupationFor(selectedMachineIds),
    // occupationFor only reads these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setup, resolvedConstructions, selectedMachineIds],
  );
  const formatOccupation = (row: SelectionOccupation['allTask']) =>
    `${row.forecastUtilizationPercent.toFixed(2)}% (ideal ${row.utilizationPercent.toFixed(2)}%)`;
  const selectBoxDetails = (machineIds: string[]): string[] => {
    const occupation = occupationFor(machineIds);
    if (!occupation) return plannedUtilizationLoading ? ['Man occupation: loading…'] : [];
    if (occupation.plannedMachineCount === 0) return ['No Construction assigned yet'];
    return [
      `All Task: ${formatOccupation(occupation.allTask)}`,
      ...occupation.activities
        .filter((row) => row.plannedMinutes > 0)
        .map((row) => `· ${row.label}: ${formatOccupation(row)}`),
    ];
  };
  const occupationStatus = (percent: number) =>
    percent > 100 ? 'overload' : percent > (plannedUtilization?.targetPercent ?? 85) ? 'above-target' : 'under-target';

  const constructionDirty = bulkConstructionId !== appliedConstructionId;
  const multiTaskDirty = operatorSetKey(bulkMultiTaskIds) !== operatorSetKey(appliedMultiTaskIds);
  const taskDirty = (family: ProductionActivityFamily) => operatorSetKey(bulkTaskIds[family]) !== operatorSetKey(appliedTaskIds[family]);
  const groupNameDirty = bulkGroupName.trim() !== appliedGroupName;
  const selectedAssignmentsNow = selectedMachineIds.map((id) => assignmentByMachine.get(id));
  const appliedDoffPriority = sharedValue(selectedAssignmentsNow.map((a) => a?.doffPriority));
  const appliedMinRemain = sharedValue(selectedAssignmentsNow.map((a) => a?.minRemainForDoffPriority));
  const doffPriorityDirty = bulkDoffPriority !== appliedDoffPriority || bulkMinRemain !== appliedMinRemain;
  const effectiveDoffPriority = bulkDoffPriority ?? setup.doffPriority;

  // An operator is Multi Task or Split Task on a machine, never both: whoever is one of them on any
  // planned selected machine (or picked for it below) is left out of the other type's dropdowns.
  const plannedSelection = selectedAssignmentsNow.filter((a): a is ProductionMachineAssignment => !!a?.constructionDetailId);
  const selectionMultiTaskIds = new Set([...plannedSelection.flatMap((a) => a.assignedOperatorIds ?? []), ...bulkMultiTaskIds]);
  const selectionTaskIds = new Set([...plannedSelection.flatMap((a) => taskOperatorIdsOf(a)), ...Object.values(bulkTaskIds).flat()]);
  const operatorNames = (ids: string[]) => ids.map((id) => operatorLabel(id)).join(', ');
  /** The other Assign Type's operators on this selection — still working there, just not shown. */
  const otherTypeSummary = (() => {
    if (assignType === 'multi') {
      const parts = TASK_ROWS.flatMap(({ family }) => {
        const ids = [...new Set(plannedSelection.flatMap((a) => a[TASK_OPERATOR_FIELDS[family]] ?? []))];
        return ids.length > 0 ? [`${TASK_OPERATOR_LABELS[family]}: ${operatorNames(ids)}`] : [];
      });
      return parts.length > 0 ? `Also Split Task on this selection — ${parts.join('; ')}` : null;
    }
    const ids = [...new Set(plannedSelection.flatMap((a) => a.assignedOperatorIds ?? []))];
    return ids.length > 0 ? `Also Multi Task on this selection: ${operatorNames(ids)}` : null;
  })();

  const removeButton = (title: string, onClick: () => void) => (
    <Button
      variant="ghost"
      className="production-assign-remove"
      onClick={onClick}
      disabled={selectedMachineIds.length === 0}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
      </svg>
    </Button>
  );

  /** One bordered "pick several operators, then Apply" box: title (with the selection's man
   * occupation for that work), the picker row, then the picked operators as chips. */
  const operatorListRow = ({
    key,
    title,
    occupation,
    ids,
    setIds,
    excluded,
    placeholder,
    dirty,
    applyTitle,
    removeTitle,
    onApply,
  }: {
    key: string;
    title: string;
    occupation: SelectionOccupation['allTask'] | undefined;
    ids: string[];
    setIds: (ids: string[]) => void;
    excluded: Set<string>;
    placeholder: string;
    dirty: boolean;
    applyTitle: string;
    removeTitle: string;
    onApply: (ids: string[]) => void;
  }) => (
    <div key={key} className="production-assign-task">
      <div className="production-assign-task-header">
        <span>{title}</span>
        {occupation && occupation.plannedMinutes > 0 && selectionOccupation && (
          <span
            className="production-assign-task-occupation"
            title={`Man occupation of 1 operator doing this on the selection: ${occupation.plannedMinutes.toFixed(1)} min ideal demand of ${selectionOccupation.availableMinutes.toFixed(1)} min net available`}
          >
            <span className={`planned-utilization-status planned-utilization-status-${occupationStatus(occupation.forecastUtilizationPercent)}`}>
              {occupation.forecastUtilizationPercent.toFixed(2)}%
            </span>
            <span className="selection-occupation-ideal">ideal {occupation.utilizationPercent.toFixed(2)}%</span>
          </span>
        )}
      </div>
      <div className="production-assign-row">
        <SearchableSelect
          value=""
          onChange={(id) => {
            if (id && !ids.includes(id)) setIds([...ids, id]);
          }}
          placeholder={placeholder}
          searchPlaceholder="Search operator…"
          options={operatorOptions.filter((option) => !ids.includes(option.value) && !excluded.has(option.value))}
        />
        <Button
          variant="secondary"
          className={dirty ? 'btn-pending' : ''}
          onClick={() => onApply(ids)}
          disabled={selectedMachineIds.length === 0}
          title={applyTitle}
        >
          Apply
        </Button>
        {removeButton(removeTitle, () => onApply([]))}
      </div>
      {ids.length > 0 && (
        <div className="production-operator-chips">
          {ids.map((id) => (
            <span key={id} className="production-operator-chip">
              {operatorLabel(id)}
              <button type="button" onClick={() => setIds(ids.filter((listId) => listId !== id))} title="Remove from this list">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  const operatorRows =
    assignType === 'multi'
      ? operatorListRow({
          key: 'multi',
          title: 'Multi Task',
          occupation: selectionOccupation?.allTask,
          ids: bulkMultiTaskIds,
          setIds: setBulkMultiTaskIds,
          excluded: selectionTaskIds,
          placeholder: 'Add operator',
          dirty: multiTaskDirty,
          applyTitle: 'Apply these operators to the selection — any of them may do any task on these machines',
          removeTitle: 'Remove all Multi Task operators from selection',
          onApply: applyMultiTaskOperators,
        })
      : TASK_ROWS.map(({ family }) =>
          operatorListRow({
            key: family,
            title: TASK_OPERATOR_LABELS[family],
            occupation: selectionOccupation?.activities.find((row) => row.key === family),
            ids: bulkTaskIds[family],
            setIds: (ids) => setBulkTaskIds((prev) => ({ ...prev, [family]: ids })),
            excluded: selectionMultiTaskIds,
            placeholder: 'Add operator',
            dirty: taskDirty(family),
            applyTitle: `Apply these ${TASK_OPERATOR_LABELS[family]} operators to the selection`,
            removeTitle: `Remove ${TASK_OPERATOR_LABELS[family]} operators from selection`,
            onApply: (ids) => applyTaskOperators(family, ids),
          }),
        );

  const assignSelectionCard = (
    <Card
      title={`Assign Selection (${selectedMachineIds.length} machine(s) selected)`}
      actions={
        <Button variant="danger" onClick={unplanSelection} disabled={selectedMachineIds.length === 0}>
          Unplan Selection
        </Button>
      }
    >
      <div className="production-assign-row">
        <SearchableSelect
          value={bulkConstructionId}
          onChange={setBulkConstructionId}
          disabled={loadingProducts}
          placeholder={loadingProducts ? 'Loading…' : 'Select Construction Detail'}
          searchPlaceholder="Search Construction Detail…"
          options={products.map((p) => ({ value: p.mpp_wl_productsid, label: p.mpp_constructiondetailcode ?? p.mpp_wl_productsid }))}
        />
        <Button
          variant="secondary"
          className={constructionDirty ? 'btn-pending' : ''}
          onClick={applyConstruction}
          disabled={selectedMachineIds.length === 0 || !bulkConstructionId}
          title="Apply Construction Detail to selection"
        >
          Apply
        </Button>
        {removeButton('Remove Construction Detail from selection', removeConstruction)}
      </div>
      <div className="production-assign-row">
        <input
          className="input"
          placeholder="Group Name"
          value={bulkGroupName}
          onChange={(e) => setBulkGroupName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && selectedMachineIds.length > 0) applyGroupName(bulkGroupName);
          }}
        />
        <Button
          variant="secondary"
          className={groupNameDirty ? 'btn-pending' : ''}
          onClick={() => applyGroupName(bulkGroupName)}
          disabled={selectedMachineIds.length === 0}
          title="Apply group name to selection"
        >
          Apply
        </Button>
        {removeButton('Remove group name from selection', () => applyGroupName(''))}
      </div>
      <div
        className="production-assign-tabs"
        role="tablist"
        aria-label="Assign Type"
        title="Multi Task: operators who may do every task on these machines. Split Task: operators per activity. Switching only changes which fields show — operators of the other type stay assigned."
      >
        {ASSIGN_TYPE_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={assignType === tab.value}
            className={assignType === tab.value ? 'active' : ''}
            onClick={() => setAssignType(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {selectionOccupation && selectionOccupation.machineCount > 0 && (
        <p className="production-assign-scope" title={selectionOccupation.constructionLabels.join(', ')}>
          {selectionOccupation.plannedMachineCount === 0
            ? 'Apply a Construction Detail to see man occupation (1 operator).'
            : `Man occupation (1 operator) · ${selectionOccupation.plannedMachineCount}/${selectionOccupation.machineCount} planned · ${selectionOccupation.constructionLabels.length} Construction`}
        </p>
      )}
      {operatorRows}
      {otherTypeSummary && <p className="data-manager-hint">{otherTypeSummary}</p>}
      <div className="production-assign-row production-assign-doff">
        <span className="production-assign-doff-label" title={DOFF_PRIORITY_TOOLTIP}>
          Doff Priority
        </span>
        <Toggle checked={effectiveDoffPriority} onChange={setBulkDoffPriority} ariaLabel="Doff Priority for selection" />
        <input
          className="input"
          type="number"
          min={0}
          placeholder={`${setup.minRemainForDoffPriority} (setup)`}
          value={bulkMinRemain ?? ''}
          disabled={!effectiveDoffPriority}
          title="Min Remain Task for Doff Priority (min) — blank follows the setup"
          aria-label="Min Remain Task for Doff Priority (min)"
          onChange={(e) => {
            const parsed = parseFloat(e.target.value);
            setBulkMinRemain(Number.isFinite(parsed) ? Math.max(0, parsed) : undefined);
          }}
        />
        <Button
          variant="secondary"
          className={doffPriorityDirty ? 'btn-pending' : ''}
          onClick={() => applyMachineDoffPriority(bulkDoffPriority, bulkMinRemain)}
          disabled={selectedMachineIds.length === 0}
          title="Apply Doff Priority to selection"
        >
          Apply
        </Button>
        {removeButton("Follow the setup's Doff Priority again", () => applyMachineDoffPriority(undefined, undefined))}
      </div>
      {selectedMachineIds.length > 0 && bulkDoffPriority === undefined && bulkMinRemain === undefined && (
        <p className="data-manager-hint">
          Doff Priority follows the setup ({setup.doffPriority ? `Yes, ${setup.minRemainForDoffPriority} min` : 'No'}).
        </p>
      )}
    </Card>
  );

  return (
    <>
      {actionError && <div className="production-run-warnings">{actionError}</div>}
      <Card
        title="Shift & Movement Settings"
        actions={
          <Button variant="primary" onClick={onRun} disabled={!canRun || resolving || loadingProducts}>
            {loadingProducts ? 'Loading WL_Products…' : resolving ? 'Preparing…' : '▶ Run Simulation'}
          </Button>
        }
      >
        <div className="grid-2">
          <Field label="Task Priority">
            <SelectInput value={setup.taskPriority} options={TASK_PRIORITY_OPTIONS} onChange={(v) => onHeaderChange({ taskPriority: v })} />
          </Field>
          <Field label="Shift Time (min)">
            <NumberInput value={setup.shiftTime} onChange={(v) => onHeaderChange({ shiftTime: v })} />
          </Field>
          <Field label="Lunch Time (min)">
            <NumberInput value={setup.lunchTime} onChange={(v) => onHeaderChange({ lunchTime: v })} />
          </Field>
          <Field label="Lunch starts at minute">
            <NumberInput value={setup.lunchStartAt} min={0} onChange={(v) => onHeaderChange({ lunchStartAt: v })} />
          </Field>
          <Field label="Meeting Time (min)">
            <NumberInput value={setup.meetingTime} onChange={(v) => onHeaderChange({ meetingTime: v })} />
          </Field>
          <Field label="Meeting starts at minute">
            <NumberInput value={setup.meetingStartAt} min={0} onChange={(v) => onHeaderChange({ meetingStartAt: v })} />
          </Field>
          <Field label="RPC %" tooltip="Rest & Personal Care allowance: added on top of every activity's time when it's actually serviced (shown as its own segment in the timeline), e.g. 12% turns a 10-minute activity into 11.2 minutes.">
            <NumberInput value={setup.rpc ?? 12} min={0} onChange={(v) => onHeaderChange({ rpc: v })} />
          </Field>
          <Field label="Doff Priority" tooltip={DOFF_PRIORITY_TOOLTIP}>
            <Toggle checked={setup.doffPriority} onChange={(v) => onHeaderChange({ doffPriority: v })} ariaLabel="Doff Priority" />
          </Field>
          <Field label="Min Remain Task for Doff Priority (min)">
            <NumberInput
              value={setup.minRemainForDoffPriority}
              min={0}
              readOnly={!setup.doffPriority}
              onChange={(v) => onHeaderChange({ minRemainForDoffPriority: Number.isFinite(v) ? v : 0 })}
            />
          </Field>
          <Field label="Walking Speed (m/min)">
            <NumberInput value={setup.movement.walkingSpeed} min={0} onChange={(v) => onHeaderChange({ movement: { ...setup.movement, walkingSpeed: v } })} />
          </Field>
        </div>
        {!canRun && <p className="data-manager-hint">Add at least 1 operator and assign a Construction Detail to at least 1 machine before running the simulation.</p>}
      </Card>

      <Card
        title="Operators"
        actions={
          <div className="production-csv-actions">
            <Button
              variant="secondary"
              onClick={() => setStartTimesOpen(true)}
              title="Custom Lunch / Meeting start per operator"
              aria-label="Custom Lunch / Meeting start per operator"
            >
              ⚙️
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPlannedUtilizationOpen(true)}
              title="Show planned man occupation in fullscreen"
              aria-label="Show planned man occupation in fullscreen"
            >
              📊
            </Button>
          </div>
        }
      >
        {startTimesOpen && (
          <OperatorStartTimesDialog
            setup={setup}
            onSaved={(operators) => onLocalChange({ operators })}
            onClose={() => setStartTimesOpen(false)}
          />
        )}
        <div className="production-operator-add">
          <input
            className="input"
            placeholder="Operator name, e.g. Operator 1"
            value={newOperatorName}
            onChange={(e) => setNewOperatorName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addOperator()}
            disabled={addingOperator || addingBulkOperators}
          />
          <Button
            variant="secondary"
            onClick={addOperator}
            disabled={addingOperator || addingBulkOperators || !newOperatorName.trim() || operatorNameExists(newOperatorName)}
            title={operatorNameExists(newOperatorName) ? `Operator "${newOperatorName.trim()}" already exists` : undefined}
          >
            {addingOperator ? 'Adding…' : '+ Add Operator'}
          </Button>
        </div>
        <div className="production-operator-add" style={{ marginTop: 10 }}>
          <input
            className="input"
            type="number"
            min={1}
            max={500}
            value={bulkOperatorCount}
            onChange={(e) => setBulkOperatorCount(Math.max(1, Number(e.target.value) || 1))}
            disabled={addingOperator || addingBulkOperators}
          />
          <input
            className="input"
            placeholder="Prefix, e.g. Opr"
            value={bulkOperatorPrefix}
            onChange={(e) => setBulkOperatorPrefix(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addBulkOperators()}
            disabled={addingOperator || addingBulkOperators}
          />
          <Button
            variant="secondary"
            onClick={addBulkOperators}
            disabled={addingOperator || addingBulkOperators || !bulkOperatorPrefix.trim()}
          >
            {addingBulkOperators ? 'Creating…' : `+ Add ${bulkOperatorCount} Operators`}
          </Button>
        </div>
        <div className="production-operator-chips">
          {setup.operators.length === 0 && <p className="data-manager-hint">No operators yet.</p>}
          {setup.operators.map((o) => (
            <span key={o.id} className="production-operator-chip" title={operatorIdealDemandTooltip(o.id)}>
              {operatorForecastLabel(o.id, o.label)}
              <button type="button" onClick={() => removeOperator(o.id)} title="Remove operator">
                ×
              </button>
            </span>
          ))}
        </div>
      </Card>

      <p className="data-manager-hint">Shift+click or shift+drag to select multiple machines, then assign them in the "Assign Selection" panel below (or in the panel that appears on the canvas in Fullscreen).</p>
      <LayoutBuilder
        layout={setup.layout}
        readOnly
        selectMachineGroups={false}
        onSelectionChange={setSelectedMachineIds}
        selectBoxDetails={selectBoxDetails}
        machineAppearance={machineAppearance}
        toolbarStart={canvasViewSelect}
        selectionPanel={assignSelectionCard}
        canvasOverlay={canvasLegend}
        highlightedMachineIds={highlightedMachineIds}
        onChange={() => {}}
        operatorStart={setup.operatorStart ?? null}
        walls={setup.walls ?? []}
        remarks={setup.remarks ?? []}
      />
      {plannedUtilizationOpen && (
        <div
          ref={plannedUtilizationPanelRef}
          className={`production-planned-utilization-fullscreen${
            plannedUtilizationFullscreen ? ' is-fullscreen' : ''
          }`}
        >
          <PlannedUtilizationCard
            utilization={plannedUtilization}
            errors={plannedUtilizationErrors}
            loading={plannedUtilizationLoading}
            onClose={() => {
              if (document.fullscreenElement === plannedUtilizationPanelRef.current) {
                void document.exitFullscreen();
              } else {
                setPlannedUtilizationOpen(false);
              }
            }}
          />
        </div>
      )}

      <Card
        title="Machine Assignments"
        actions={
          <div className="production-csv-actions">
            <MachineAssignmentsSearch value={assignmentsSearch} onChange={setAssignmentsSearch} />
            <MachineAssignmentsGroupBySelect value={assignmentsGroupBy} onChange={setAssignmentsGroupBy} />
            <input
              ref={importInputRef}
              type="file"
              accept=".csv,text/csv"
              className="production-csv-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && !importProgress) void importCsv(file);
                e.target.value = '';
              }}
            />
            <Button variant="ghost" onClick={() => importInputRef.current?.click()} disabled={importProgress !== null}>
              {importProgress ? `Importing… ${importProgress.done}/${importProgress.total}` : 'Import CSV'}
            </Button>
            <Button variant="secondary" onClick={exportCsv}>
              Export CSV
            </Button>
          </div>
        }
      >
        {importProgress && (
          <>
            <p className="data-manager-hint" role="status" aria-live="polite">
              {importMessage}
            </p>
            <BlockingProgressOverlay title="Importing CSV assignments…" done={importProgress.done} total={importProgress.total} />
          </>
        )}
        {!importProgress && importMessage && <p className="data-manager-hint">{importMessage}</p>}
        <MachineAssignmentsTable
          layout={setup.layout}
          assignments={setup.assignments}
          operatorLabel={operatorLabel}
          groupBy={assignmentsGroupBy}
          search={assignmentsSearch}
        />
      </Card>
    </>
  );
}

function PlannedUtilizationCard({
  utilization,
  errors,
  loading,
  onClose,
}: {
  utilization: PlannedUtilization | null;
  errors: string[];
  loading: boolean;
  onClose: () => void;
}) {
  type OperatorSortColumn = 'operator' | 'ideal' | 'forecast' | 'available' | 'utilization' | 'queue';
  type MachineSortColumn = 'machine' | 'construction' | 'activity' | 'operator' | 'utilization';
  type SortDirection = 'asc' | 'desc';
  type MachineRow = {
    machine: PlannedUtilization['machines'][number];
    contribution: PlannedUtilization['machines'][number]['contributions'][number] | null;
    index: number;
  };
  const formatMinutes = (minutes: number) => `${minutes.toFixed(1)} min`;
  const targetPercent = utilization?.targetPercent ?? 85;
  const [searchQuery, setSearchQuery] = useState('');
  const [operatorSort, setOperatorSort] = useState<{ column: OperatorSortColumn; direction: SortDirection }>({
    column: 'operator',
    direction: 'asc',
  });
  const [machineSort, setMachineSort] = useState<{ column: MachineSortColumn; direction: SortDirection }>({
    column: 'machine',
    direction: 'asc',
  });
  const statusFor = (percent: number) =>
    percent > 100 ? 'overload' : percent > targetPercent ? 'above-target' : 'under-target';
  const contributionSummary = (
    contributions: PlannedUtilization['operators'][number]['contributions'],
    availableMinutes: number,
  ) => {
    const grouped = new Map<
      string,
      { label: string; minutes: number; quantity: number; hasQuantity: boolean; machines: Set<string> }
    >();
    contributions.forEach((contribution) => {
      const current = grouped.get(contribution.activityKey) ?? {
        label: contribution.activityLabel,
        minutes: 0,
        quantity: 0,
        hasQuantity: false,
        machines: new Set<string>(),
      };
      current.minutes += contribution.plannedMinutes;
      current.machines.add(contribution.machineId);
      if (contribution.expectedQuantity !== undefined) {
        current.quantity += contribution.expectedQuantity;
        current.hasQuantity = true;
      }
      grouped.set(contribution.activityKey, current);
    });
    return [...grouped.values()]
      .map(
        (contribution) =>
          `${contribution.label}: ${formatMinutes(contribution.minutes)} (${availableMinutes > 0
            ? `${((contribution.minutes / availableMinutes) * 100).toFixed(1)}% utilization; `
            : ''}${contribution.machines.size} machine(s)${
            contribution.hasQuantity ? `; ${contribution.quantity.toFixed(1)} units` : ''
          })`,
      )
      .join(' · ');
  };
  const operatorById = new Map(utilization?.operators.map((operator) => [operator.operatorId, operator]) ?? []);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const matchesSearch = (values: (string | number | undefined)[]) =>
    !normalizedSearch || values.some((value) => String(value ?? '').toLowerCase().includes(normalizedSearch));
  const toggleOperatorSort = (column: OperatorSortColumn) => {
    setOperatorSort((current) =>
      current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    );
  };
  const toggleMachineSort = (column: MachineSortColumn) => {
    setMachineSort((current) =>
      current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    );
  };
  const compareValues = (left: string | number, right: string | number, direction: SortDirection) => {
    const comparison =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'asc' ? comparison : -comparison;
  };
  const sortIndicator = (column: OperatorSortColumn) =>
    operatorSort.column === column ? (operatorSort.direction === 'asc' ? ' ▲' : ' ▼') : '';
  const visibleOperators = [...(utilization?.operators ?? [])]
    .filter((operator) =>
      matchesSearch([
        operator.operatorLabel,
        ...operator.contributions.flatMap((contribution) => [
          contribution.machineLabel,
          contribution.constructionLabel,
          contribution.activityLabel,
        ]),
      ]),
    )
    .sort((left, right) => {
      const leftValue: string | number = {
        operator: left.operatorLabel,
        ideal: left.plannedMinutes,
        forecast: left.forecastServiceMinutes + left.forecastWalkingMinutes,
        available: left.availableMinutes,
        utilization: left.forecastUtilizationPercent,
        queue: left.forecastWaitingMinutes,
      }[operatorSort.column];
      const rightValue: string | number = {
        operator: right.operatorLabel,
        ideal: right.plannedMinutes,
        forecast: right.forecastServiceMinutes + right.forecastWalkingMinutes,
        available: right.availableMinutes,
        utilization: right.forecastUtilizationPercent,
        queue: right.forecastWaitingMinutes,
      }[operatorSort.column];
      return compareValues(leftValue, rightValue, operatorSort.direction);
    });
  const machineRows: MachineRow[] = (utilization?.machines ?? []).flatMap((machine) =>
    machine.contributions.length > 0
      ? machine.contributions.map((contribution, index) => ({ machine, contribution, index }))
      : [{ machine, contribution: null, index: 0 } as MachineRow],
  );
  const machineContributionUtilization = (contribution: MachineRow['contribution']) => {
    if (!contribution?.operatorId) return 0;
    const operator = operatorById.get(contribution.operatorId);
    return operator && operator.availableMinutes > 0
      ? (contribution.plannedMinutes / operator.availableMinutes) * 100
      : 0;
  };
  const visibleMachineRows = machineRows
    .filter(({ machine, contribution }) =>
      matchesSearch([
        machine.machineLabel,
        machine.constructionLabel,
        contribution?.activityLabel,
        contribution?.operatorId ? operatorById.get(contribution.operatorId)?.operatorLabel : 'Unassigned',
      ]),
    )
    .sort((left, right) => {
      const leftOperator = left.contribution?.operatorId
        ? operatorById.get(left.contribution.operatorId)?.operatorLabel ?? 'Unassigned'
        : 'Unassigned';
      const rightOperator = right.contribution?.operatorId
        ? operatorById.get(right.contribution.operatorId)?.operatorLabel ?? 'Unassigned'
        : 'Unassigned';
      const leftValue: string | number = {
        machine: left.machine.machineLabel,
        construction: left.machine.constructionLabel,
        activity: left.contribution?.activityLabel ?? 'No resolved activity demand',
        operator: leftOperator,
        utilization: machineContributionUtilization(left.contribution),
      }[machineSort.column];
      const rightValue: string | number = {
        machine: right.machine.machineLabel,
        construction: right.machine.constructionLabel,
        activity: right.contribution?.activityLabel ?? 'No resolved activity demand',
        operator: rightOperator,
        utilization: machineContributionUtilization(right.contribution),
      }[machineSort.column];
      return compareValues(leftValue, rightValue, machineSort.direction);
    });
  const machineSortIndicator = (column: MachineSortColumn) =>
    machineSort.column === column ? (machineSort.direction === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <Card
      title="Planned Man Occupation"
      subtitle="Ideal due-work plus a deterministic constrained forecast using machine stop time and estimated inter-machine walking"
      actions={
        <Button variant="ghost" onClick={onClose} title="Close planned man occupation" aria-label="Close planned man occupation">
          ✕
        </Button>
      }
    >
      {loading && <p className="data-manager-hint">Resolving Construction Details and activities…</p>}
      <input
        className="input planned-utilization-search"
        type="search"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder="Search operator, machine, Construction, or activity…"
        aria-label="Search planned man occupation"
      />
      {errors.length > 0 && (
        <div className="planned-utilization-warning">
          <strong>Some planned demand could not be resolved.</strong>
          <span>{errors.slice(0, 3).join(' ')}</span>
          {errors.length > 3 && <span>…and {errors.length - 3} more issue(s).</span>}
        </div>
      )}
      {!utilization ? (
        <p className="data-manager-hint">Assign a Construction Detail to see planned demand.</p>
      ) : (
        <>
          <div className="planned-utilization-summary">
            <span>Net operator availability: <strong>{formatMinutes(utilization.availableMinutes)}</strong> per shift</span>
            <span title="The ideal figure is the capacity requirement. The forecast accounts for stop-work downtime and estimated walking; exact random phase and dispatch queues remain visible in the actual run.">
              Ideal demand / forecast: <strong>capacity requirement / expected completed work</strong>
            </span>
            {utilization.unassignedMinutes > 0 && (
              <span className="planned-utilization-unassigned">
                Unassigned demand: <strong>{formatMinutes(utilization.unassignedMinutes)}</strong>
              </span>
            )}
          </div>
          <div className="planned-utilization-table-wrap">
            <table className="table planned-utilization-table">
              <thead>
                <tr>
                  {(
                    [
                      ['operator', 'Operator'],
                      ['ideal', 'Ideal demand'],
                      ['forecast', 'Forecast work'],
                      ['available', 'Net available'],
                      ['utilization', 'Man Occupation'],
                      ['queue', 'Forecast queue'],
                    ] as [OperatorSortColumn, string][]
                  ).map(([column, label]) => (
                    <th
                      key={column}
                      className="production-sortable-th"
                      onClick={() => toggleOperatorSort(column)}
                      title="Click to sort ascending/descending"
                    >
                      {label}{sortIndicator(column)}
                    </th>
                  ))}
                  <th>Ideal activity contribution</th>
                </tr>
              </thead>
              <tbody>
                {visibleOperators.map((operator) => (
                  <tr key={operator.operatorId}>
                    <td>{operator.operatorLabel}</td>
                    <td>{formatMinutes(operator.plannedMinutes)}</td>
                    <td>
                      {formatMinutes(operator.forecastServiceMinutes)} handling + {formatMinutes(operator.forecastWalkingMinutes)} walking
                    </td>
                    <td>{formatMinutes(operator.availableMinutes)}</td>
                    <td>
                      <span className={`planned-utilization-status planned-utilization-status-${statusFor(operator.forecastUtilizationPercent)}`}>
                        {operator.forecastUtilizationPercent.toFixed(1)}% Forecast Man Occupation
                      </span>
                      <div className="data-manager-hint">{operator.utilizationPercent.toFixed(1)}% ideal demand</div>
                    </td>
                    <td>
                      {formatMinutes(operator.forecastWaitingMinutes)}
                      {operator.forecastWaitingMinutes > 0 ? ' backlog' : ' expected'}
                    </td>
                    <td>
                      {operator.contributions.length === 0
                        ? '—'
                        : contributionSummary(operator.contributions, operator.availableMinutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {utilization.machines.length > 0 && (
            <div className="planned-utilization-table-wrap planned-utilization-machine-table">
              <table className="table">
                <thead>
                  <tr>
                    {(
                      [
                        ['machine', 'Machine'],
                        ['construction', 'Construction'],
                        ['activity', 'Activity'],
                        ['operator', 'Operator'],
                        ['utilization', 'Ideal utilization contribution'],
                      ] as [MachineSortColumn, string][]
                    ).map(([column, label]) => (
                      <th
                        key={column}
                        className="production-sortable-th"
                        onClick={() => toggleMachineSort(column)}
                        title="Click to sort ascending/descending"
                      >
                        {label}{machineSortIndicator(column)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleMachineRows.map(({ machine, contribution, index }) =>
                    contribution
                      ? (() => {
                          const operator = contribution.operatorId ? operatorById.get(contribution.operatorId) : undefined;
                          const contributionPercent =
                            operator && operator.availableMinutes > 0
                              ? (contribution.plannedMinutes / operator.availableMinutes) * 100
                              : null;
                          const quantity =
                            contribution.expectedQuantity === undefined
                              ? ''
                              : ` · ${contribution.expectedQuantity.toFixed(1)} units`;
                          return (
                            <tr key={`${machine.machineId}-${contribution.activityKey}-${index}`}>
                              <td>{machine.machineLabel}</td>
                              <td>{machine.constructionLabel}</td>
                              <td>{contribution.activityLabel}</td>
                              <td>{operator?.operatorLabel ?? 'Unassigned'}</td>
                              <td>
                                {formatMinutes(contribution.plannedMinutes)}
                                {contributionPercent === null ? ' · —' : ` · ${contributionPercent.toFixed(1)}% of operator shift`}
                                {quantity}
                              </td>
                            </tr>
                          );
                        })()
                      : (
                        <tr key={machine.machineId}>
                          <td>{machine.machineLabel}</td>
                          <td>{machine.constructionLabel}</td>
                          <td colSpan={3}>No resolved activity demand</td>
                        </tr>
                      )
                  )}
                </tbody>
              </table>
            </div>
          )}
          {utilization.unresolvedMachineIds.length > 0 && (
            <p className="planned-utilization-warning">
              {utilization.unresolvedMachineIds.length} assigned machine(s) are omitted until their Construction data resolves.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
