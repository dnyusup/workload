import { useEffect, useMemo, useState } from 'react';
import { Mpp_wl_productsesService } from '../../generated/services/Mpp_wl_productsesService';
import { Mpp_wl_activitiesService } from '../../generated/services/Mpp_wl_activitiesService';
import type { Mpp_wl_activities } from '../../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../../generated/models/Mpp_wl_productsesModel';
import { useAppConfig } from '../../context/AppConfigContext';
import { buildActivitiesFromRows, mapProductToSpec } from '../../lib/productCatalog';
import { deriveMachineSpec, ensureCoreActivities } from '../../lib/calculations';
import { Card } from '../ui/Card';
import { SearchableSelect } from '../ui/SearchableSelect';

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

export function ConstructionDetailSelector() {
  const { config, setConfig } = useAppConfig();
  const [products, setProducts] = useState<Mpp_wl_productses[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingProducts(true);
    Mpp_wl_productsesService.getAll({ orderBy: ['mpp_constructiondetailcode asc'] })
      .then((result) => {
        if (cancelled) return;
        if (result.success) {
          setProducts(result.data ?? []);
        } else {
          setError(result.error?.message ?? 'Failed to load Construction Detail list.');
        }
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

  const handleSelect = async (productId: string) => {
    const product = products.find((p) => p.mpp_wl_productsid === productId);
    if (!product) return;
    setApplying(true);
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

      setConfig((prev) => ({
        ...prev,
        spec: newSpec,
        activities,
        selectedProductId: product.mpp_wl_productsid,
        selectedConstructionDetail: product.mpp_constructiondetailcode,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activities for this Construction.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <Card className="construction-selector">
      <div className="construction-selector-row">
        <div className="field construction-selector-field">
          <span className="field-label">Construction Detail</span>
          <SearchableSelect
            value={config.selectedProductId ?? ''}
            onChange={handleSelect}
            disabled={loadingProducts || applying}
            placeholder={loadingProducts ? 'Loading products…' : 'Select Construction Detail'}
            searchPlaceholder="Cari Construction Detail…"
            options={products.map((p) => ({ value: p.mpp_wl_productsid, label: p.mpp_constructiondetailcode ?? p.mpp_wl_productsid }))}
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
