import { useEffect, useMemo, useState } from 'react';
import { Mpp_wl_productsesService } from '../../generated/services/Mpp_wl_productsesService';
import { Mpp_wl_activitiesService } from '../../generated/services/Mpp_wl_activitiesService';
import { Mpp_wl_outputmodelsesService } from '../../generated/services/Mpp_wl_outputmodelsesService';
import type { Mpp_wl_activities } from '../../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../../generated/models/Mpp_wl_productsesModel';
import type { Mpp_wl_outputmodelses } from '../../generated/models/Mpp_wl_outputmodelsesModel';
import { useAppConfig } from '../../context/appConfig';
import { fetchAllPages } from '../../lib/dataversePaging';
import { loadDefaultLayoutsOrNone, loadDefaultValuesOrBuiltIn } from '../../lib/defaultValuesStore';
import { loadSavedLayouts } from '../../lib/savedLayoutsStore';
import { applyFrequencyModeToConfig, buildConstructionConfig, withOptimizedAssignment } from '../../lib/constructionConfig';
import { loadFrequencyCatalog, lookupHistoricalFrequency, computeFrequencyDateRange, type HistoricalFrequencyMap } from '../../lib/frequencyCatalog';
import type { AppConfig, FrequencyMode } from '../../types';
import { Card } from '../ui/Card';
import { SearchableSelect } from '../ui/SearchableSelect';
import { DateInput } from '../ui/Field';
import { OutputModelDetailDialog } from '../data/OutputModelDetailDialog';
import { OUTPUT_MODEL_LIST_SELECT } from '../../lib/outputModelColumns';

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

type FilterKey = 'area' | 'mach' | 'product';

const FILTERS: { key: FilterKey; label: string; pick: (p: Mpp_wl_productses) => string }[] = [
  { key: 'area', label: 'Area', pick: (p) => (p.mpp_area ?? '').trim() },
  { key: 'mach', label: 'Mach', pick: (p) => (p.mpp_machinecode ?? '').trim() },
  { key: 'product', label: 'Product', pick: (p) => (p.mpp_productspecification ?? '').trim() },
];

export function ConstructionDetailSelector({
  onApplyingChange,
  onApplied,
}: {
  onApplyingChange?: (applying: boolean) => void;
  onApplied?: (config: AppConfig) => void;
}) {
  const { config, setConfig } = useAppConfig();
  const [products, setProducts] = useState<Mpp_wl_productses[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputModelRows, setOutputModelRows] = useState<Mpp_wl_outputmodelses[]>([]);
  const [detailRow, setDetailRow] = useState<Mpp_wl_outputmodelses | null>(null);
  const [freqCatalog, setFreqCatalog] = useState<HistoricalFrequencyMap | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  const frequencyMode: FrequencyMode = config.frequencyMode ?? 'manual';

  useEffect(() => {
    let cancelled = false;
    loadFrequencyCatalog()
      .then(({ catalog }) => {
        if (!cancelled) setFreqCatalog(catalog);
      })
      .catch((err) => {
        console.warn('Background load of MES_Frequency catalog:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (config.frequencyMode === undefined || !config.frequencyStartDate || !config.frequencyEndDate) {
      void loadDefaultValuesOrBuiltIn().then((defaults) => {
        const defaultRange = computeFrequencyDateRange(
          defaults.frequencyDateRangeType,
          defaults.frequencyStartDate,
          defaults.frequencyEndDate,
        );
        setConfig((prev) => ({
          ...prev,
          frequencyMode: prev.frequencyMode ?? defaults.frequencyMode ?? 'manual',
          frequencyStartDate: prev.frequencyStartDate || defaultRange.startDate,
          frequencyEndDate: prev.frequencyEndDate || defaultRange.endDate,
        }));
      });
    }
  }, [config.frequencyMode, config.frequencyStartDate, config.frequencyEndDate, setConfig]);

  useEffect(() => {
    let cancelled = false;
    fetchAllPages(Mpp_wl_productsesService.getAll, { orderBy: ['mpp_constructiondetailcode asc'] })
      .then((data) => {
        if (!cancelled) setProducts(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load Construction Detail list.');
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Powers the "has a saved output model" eye icon on each Construction Detail option — not
  // critical to the page working, so a failure here is swallowed rather than shown as an error.
  useEffect(() => {
    let cancelled = false;
    fetchAllPages(Mpp_wl_outputmodelsesService.getAll, { select: OUTPUT_MODEL_LIST_SELECT, orderBy: ['mpp_updatedon desc'] })
      .then((data) => {
        if (!cancelled) setOutputModelRows(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Keyed by trimmed/lower-cased Construction Detail code; each list is already sorted newest
  // first (the fetch orders by mpp_updatedon desc), so [0] is the one shown in the detail popup.
  const outputModelsByConstruction = useMemo(() => {
    const map = new Map<string, Mpp_wl_outputmodelses[]>();
    for (const row of outputModelRows) {
      const code = row.mpp_constructiondetailcode?.trim().toLowerCase();
      if (!code) continue;
      const list = map.get(code);
      if (list) list.push(row);
      else map.set(code, [row]);
    }
    return map;
  }, [outputModelRows]);

  const handleViewOutputModel = (productId: string) => {
    const product = products.find((p) => p.mpp_wl_productsid === productId);
    const code = product?.mpp_constructiondetailcode?.trim().toLowerCase();
    const rows = code ? outputModelsByConstruction.get(code) : undefined;
    if (rows && rows.length > 0) setDetailRow(rows[0]);
  };

  const selectedProduct = useMemo(
    () => products.find((p) => p.mpp_wl_productsid === config.selectedProductId) ?? null,
    [products, config.selectedProductId],
  );

  const matchedHistorical = useMemo(() => {
    if (!selectedProduct) return null;
    return lookupHistoricalFrequency(
      freqCatalog,
      selectedProduct.mpp_machinecode,
      selectedProduct.mpp_productspecification,
      selectedProduct.mpp_laylength,
      selectedProduct.mpp_tensilegroup,
    );
  }, [selectedProduct, freqCatalog]);

  const handleFrequencyModeChange = async (newMode: FrequencyMode) => {
    if (newMode === frequencyMode) return;
    let catalog = freqCatalog;
    let startDate = config.frequencyStartDate;
    let endDate = config.frequencyEndDate;

    if (newMode === 'historical') {
      if (!startDate || !endDate) {
        const defaultRange = computeFrequencyDateRange();
        startDate = startDate || defaultRange.startDate;
        endDate = endDate || defaultRange.endDate;
      }
      setLoadingCatalog(true);
      try {
        const res = await loadFrequencyCatalog({
          startDate,
          endDate,
        });
        catalog = res.catalog;
        setFreqCatalog(catalog);
      } catch (err) {
        console.warn('Failed to load frequency catalog:', err);
      } finally {
        setLoadingCatalog(false);
      }
    }

    if (selectedProduct) {
      const updated = applyFrequencyModeToConfig({
        config: {
          ...config,
          frequencyMode: newMode,
          frequencyStartDate: startDate,
          frequencyEndDate: endDate,
        },
        product: selectedProduct,
        mode: newMode,
        catalog,
      });
      const optimized = withOptimizedAssignment(updated);
      setConfig(() => optimized);
      onApplied?.(optimized);
    } else {
      setConfig((prev) => ({
        ...prev,
        frequencyMode: newMode,
        frequencyStartDate: startDate,
        frequencyEndDate: endDate,
      }));
    }
  };

  const handleDateChange = async (field: 'frequencyStartDate' | 'frequencyEndDate', value: string) => {
    const nextStart = field === 'frequencyStartDate' ? value : (config.frequencyStartDate ?? '');
    const nextEnd = field === 'frequencyEndDate' ? value : (config.frequencyEndDate ?? '');

    setConfig((prev) => ({
      ...prev,
      [field]: value,
    }));

    if (
      frequencyMode === 'historical' &&
      nextStart &&
      nextEnd &&
      /^\d{4}-\d{2}-\d{2}$/.test(nextStart) &&
      /^\d{4}-\d{2}-\d{2}$/.test(nextEnd)
    ) {
      setLoadingCatalog(true);
      try {
        const res = await loadFrequencyCatalog({
          startDate: nextStart,
          endDate: nextEnd,
        });
        setFreqCatalog(res.catalog);
        if (selectedProduct) {
          setConfig((prev) => {
            const updated = applyFrequencyModeToConfig({
              config: {
                ...prev,
                frequencyStartDate: nextStart,
                frequencyEndDate: nextEnd,
              },
              product: selectedProduct,
              mode: 'historical',
              catalog: res.catalog,
            });
            const optimized = withOptimizedAssignment(updated);
            onApplied?.(optimized);
            return optimized;
          });
        }
      } catch (err) {
        console.warn('Failed to load frequency catalog for updated dates:', err);
      } finally {
        setLoadingCatalog(false);
      }
    }
  };

  const handleResetToDefaultRange = async () => {
    setLoadingCatalog(true);
    try {
      const defaults = await loadDefaultValuesOrBuiltIn();
      const defaultRange = computeFrequencyDateRange(
        defaults.frequencyDateRangeType,
        defaults.frequencyStartDate,
        defaults.frequencyEndDate,
      );
      const nextStart = defaultRange.startDate;
      const nextEnd = defaultRange.endDate;

      const res = await loadFrequencyCatalog({
        startDate: nextStart,
        endDate: nextEnd,
      });
      setFreqCatalog(res.catalog);

      setConfig((prev) => {
        const withDates: AppConfig = {
          ...prev,
          frequencyStartDate: nextStart,
          frequencyEndDate: nextEnd,
        };
        if (selectedProduct) {
          const updated = applyFrequencyModeToConfig({
            config: withDates,
            product: selectedProduct,
            mode: 'historical',
            catalog: res.catalog,
          });
          const optimized = withOptimizedAssignment(updated);
          onApplied?.(optimized);
          return optimized;
        }
        return withDates;
      });
    } catch (err) {
      console.warn('Failed to reset to default frequency range:', err);
    } finally {
      setLoadingCatalog(false);
    }
  };

  const [filters, setFilters] = useState<Record<FilterKey, string>>({ area: '', mach: '', product: '' });

  // Each filter's options are narrowed by the OTHER filters (so every filter affects every other
  // one), and the Construction Detail list by all three.
  const { filterOptions, constructionOptions } = useMemo(() => {
    const matches = (p: Mpp_wl_productses, skip: FilterKey | null) =>
      FILTERS.every(({ key, pick }) => key === skip || !filters[key] || pick(p) === filters[key]);
    const filterOptions = Object.fromEntries(
      FILTERS.map(({ key, pick }) => {
        const values = new Set(products.filter((p) => matches(p, key)).map(pick).filter(Boolean));
        // Keep the current value listed even if another filter has since ruled it out, so the
        // trigger still shows what's selected instead of silently falling back to the placeholder.
        if (filters[key]) values.add(filters[key]);
        const options = Array.from(values)
          .sort((a, b) => a.localeCompare(b))
          .map((v) => ({ value: v, label: v }));
        return [key, options];
      }),
    ) as Record<FilterKey, { value: string; label: string }[]>;
    const visible = products.filter((p) => matches(p, null));
    if (selectedProduct && !visible.includes(selectedProduct)) visible.unshift(selectedProduct);
    const constructionOptions = visible.map((p) => ({
      value: p.mpp_wl_productsid,
      label: p.mpp_constructiondetailcode ?? p.mpp_wl_productsid,
      hasIndicator: outputModelsByConstruction.has((p.mpp_constructiondetailcode ?? '').trim().toLowerCase()),
    }));
    return { filterOptions, constructionOptions };
  }, [products, filters, selectedProduct, outputModelsByConstruction]);

  const handleSelect = async (productId: string) => {
    const product = products.find((p) => p.mpp_wl_productsid === productId);
    if (!product) return;
    setApplying(true);
    onApplyingChange?.(true);
    setError(null);
    try {
      const construction = product.mpp_constructioncode?.trim();
      const defaultsPromise = loadDefaultValuesOrBuiltIn();
      // The Area's default layout (Setting → Default Layouts), if any — otherwise the current one stays.
      const area = product.mpp_area?.trim().toUpperCase() ?? '';
      const defaultLayoutPromise = loadDefaultLayoutsOrNone().then(async (layouts) => {
        const layoutId = layouts[area];
        if (!layoutId) return null;
        const saved = await loadSavedLayouts().catch(() => []);
        return saved.find((layout) => layout.id === layoutId) ?? null;
      });
      let activityRows: Mpp_wl_activities[] = [];
      if (construction) {
        const result = await Mpp_wl_activitiesService.getAll({
          filter: `mpp_constructiontype eq '${escapeODataString(construction)}'`,
        });
        if (result.success) {
          activityRows = result.data ?? [];
        } else {
          setError(result.error?.message ?? 'Failed to load activities for this Construction.');
        }
      }

      let catalog = freqCatalog;
      if (frequencyMode === 'historical') {
        try {
          const res = await loadFrequencyCatalog({
            startDate: config.frequencyStartDate,
            endDate: config.frequencyEndDate,
          });
          catalog = res.catalog;
          setFreqCatalog(catalog);
        } catch {
          // fallback to null
        }
      }

      const built = buildConstructionConfig({
        base: config,
        product,
        activityRows,
        defaults: await defaultsPromise,
        layout: await defaultLayoutPromise,
        frequencyMode,
        frequencyCatalog: catalog,
      });
      if (built.errors.length > 0) {
        setError(built.errors.join(' '));
      }
      const appliedConfig = withOptimizedAssignment(built.config);
      setConfig(() => appliedConfig);
      onApplied?.(appliedConfig);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activities for this Construction.');
    } finally {
      setApplying(false);
      onApplyingChange?.(false);
    }
  };

  return (
    <Card className="construction-selector">
      <div className="construction-selector-row">
        {FILTERS.map(({ key, label }) => (
          <div key={key} className="field construction-selector-filter">
            <span className="field-label">{label}</span>
            <SearchableSelect
              value={filters[key]}
              onChange={(value) => setFilters((prev) => ({ ...prev, [key]: value }))}
              disabled={loadingProducts || applying}
              placeholder="All"
              searchPlaceholder={`Search ${label}…`}
              options={filterOptions[key]}
            />
          </div>
        ))}
        <button
          type="button"
          className="btn btn-ghost construction-selector-clear"
          aria-label="Clear filters"
          title="Clear filters"
          disabled={loadingProducts || applying || FILTERS.every(({ key }) => !filters[key])}
          onClick={() => setFilters({ area: '', mach: '', product: '' })}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13 3H2l8 9.46V19l4 2v-8.54l.9-1.06" />
            <path d="m22 3-5 5M17 3l5 5" />
          </svg>
        </button>
        <div className="field construction-selector-field">
          <span className="field-label">Construction Detail</span>
          <SearchableSelect
            value={config.selectedProductId ?? ''}
            onChange={handleSelect}
            disabled={loadingProducts || applying}
            placeholder={loadingProducts ? 'Loading products…' : `Select Construction Detail (${constructionOptions.length})`}
            searchPlaceholder="Search Construction Detail…"
            options={constructionOptions}
            onOptionIndicatorClick={handleViewOutputModel}
            indicatorTitle="View saved output model"
          />
        </div>
        {selectedProduct && (
          <div className="construction-selector-meta">
            <span>Construction: {selectedProduct.mpp_constructioncode || '—'}</span>
            <span>Product: {selectedProduct.mpp_productspecification || '—'}</span>
            <span>
              POlength1/2/3: {selectedProduct.mpp_polength1 ?? '—'} / {selectedProduct.mpp_polength2 ?? '—'} /{' '}
              {selectedProduct.mpp_polength3 ?? '—'}
            </span>
          </div>
        )}
        {applying && <span className="construction-selector-status">Applying…</span>}
      </div>

      <div className="construction-selector-freq-bar">
        <div className="construction-selector-freq-control">
          <span className="field-label">Frequency Source:</span>
          <div className="segmented-control">
            <button
              type="button"
              className={`segmented-button ${frequencyMode === 'manual' ? 'active' : ''}`}
              onClick={() => void handleFrequencyModeChange('manual')}
              disabled={loadingProducts || applying || loadingCatalog}
            >
              Manual (WL_Products)
            </button>
            <button
              type="button"
              className={`segmented-button ${frequencyMode === 'historical' ? 'active' : ''}`}
              onClick={() => void handleFrequencyModeChange('historical')}
              disabled={loadingProducts || applying || loadingCatalog}
            >
              Historical (MES Data)
            </button>
          </div>

          {frequencyMode === 'historical' && (
            <div className="construction-selector-date-range">
              <span className="construction-selector-date-label">Range:</span>
              <DateInput
                value={config.frequencyStartDate ?? ''}
                onChange={(v) => void handleDateChange('frequencyStartDate', v)}
                disabled={loadingCatalog || applying}
                className="construction-selector-date-input"
              />
              <span className="construction-selector-date-sep">to</span>
              <DateInput
                value={config.frequencyEndDate ?? ''}
                onChange={(v) => void handleDateChange('frequencyEndDate', v)}
                disabled={loadingCatalog || applying}
                className="construction-selector-date-input"
              />
              <button
                type="button"
                className="construction-selector-date-reset"
                title="Reset to default date range from Settings"
                aria-label="Reset to default date range from Settings"
                disabled={loadingCatalog || applying}
                onClick={() => void handleResetToDefaultRange()}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            </div>
          )}

          {loadingCatalog && <span className="construction-selector-status">Loading MES Data…</span>}
        </div>

        {selectedProduct && (
          <div className="construction-selector-freq-info">
            {frequencyMode === 'manual' ? (
              <span className="badge badge-neutral" title="Using manual frequency values from WL_Products">
                Manual: Fr={config.spec.fracturePerTon} · Dies={config.spec.diesPerTon} · Def={config.spec.defectsPerTon}
              </span>
            ) : matchedHistorical ? (
              <span
                className="badge badge-success"
                title={`Found in MES Data (Ton Produced: ${matchedHistorical.tonProduced?.toLocaleString() ?? 0})`}
              >
                Historical (MES Data): Fr={config.spec.fracturePerTon} · Dies={config.spec.diesPerTon} · Def={config.spec.defectsPerTon}
              </span>
            ) : (
              <span
                className="badge badge-warning"
                title="Product not found in MES Data, automatically falling back to manual values from WL_Products"
              >
                ⚠️ Historical not found → Fallback to Manual: Fr={config.spec.fracturePerTon} · Dies={config.spec.diesPerTon} · Def={config.spec.defectsPerTon}
              </span>
            )}
          </div>
        )}
      </div>

      {error && <p className="construction-selector-error">{error}</p>}
      {detailRow && (
        <OutputModelDetailDialog row={detailRow} outputModelId={detailRow.mpp_wl_outputmodelsid} onClose={() => setDetailRow(null)} />
      )}
    </Card>
  );
}
