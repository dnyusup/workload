import { useEffect, useMemo, useState } from 'react';
import { Mpp_wl_productsesService } from '../../generated/services/Mpp_wl_productsesService';
import { Mpp_wl_activitiesService } from '../../generated/services/Mpp_wl_activitiesService';
import type { Mpp_wl_activities } from '../../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../../generated/models/Mpp_wl_productsesModel';
import { useAppConfig } from '../../context/appConfig';
import { fetchAllPages } from '../../lib/dataversePaging';
import { buildActivitiesFromRows, isLoadingTaskRow, mapProductToSpec } from '../../lib/productCatalog';
import { deriveMachineSpec, ensureCoreActivities } from '../../lib/calculations';
import {
  previewAssignedMachineIds,
  recommendedMachineCountForForecast,
} from '../../lib/singleOperatorUtilization';
import type { AppConfig } from '../../types';
import { Card } from '../ui/Card';
import { SearchableSelect } from '../ui/SearchableSelect';

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

  const selectedProduct = useMemo(
    () => products.find((p) => p.mpp_wl_productsid === config.selectedProductId) ?? null,
    [products, config.selectedProductId],
  );

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
    }));
    return { filterOptions, constructionOptions };
  }, [products, filters, selectedProduct]);

  const handleSelect = async (productId: string) => {
    const product = products.find((p) => p.mpp_wl_productsid === productId);
    if (!product) return;
    setApplying(true);
    onApplyingChange?.(true);
    setError(null);
    try {
      const newSpec = mapProductToSpec(product);
      const derived = deriveMachineSpec(newSpec);
      const construction = product.mpp_constructioncode?.trim();

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

      const built = buildActivitiesFromRows(activityRows, product, derived.spoolWeight, newSpec.fracturePerTon);
      const activities = ensureCoreActivities(built.activities, derived.spoolWeight, newSpec.fracturePerTon);
      if (built.errors.length > 0) {
        setError(built.errors.join(' '));
      }

      const nextConfig = {
        ...config,
        spec: newSpec,
        activities,
        selectedProductId: product.mpp_wl_productsid,
        selectedConstructionDetail: product.mpp_constructiondetailcode,
        loadingActivityRows: activityRows.filter(isLoadingTaskRow),
        initialMachineConditions: undefined,
      };
      const recommendedMachineCount = recommendedMachineCountForForecast(nextConfig);
      const appliedConfig: AppConfig = {
        ...nextConfig,
        operator: { ...nextConfig.operator, machHandled: recommendedMachineCount },
        assignedMachineIds: previewAssignedMachineIds(nextConfig, recommendedMachineCount),
      };
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
              searchPlaceholder={`Cari ${label}…`}
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
            searchPlaceholder="Cari Construction Detail…"
            options={constructionOptions}
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
      {error && <p className="construction-selector-error">{error}</p>}
    </Card>
  );
}
