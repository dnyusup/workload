import { useEffect, useMemo, useRef, useState } from 'react';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { AppConfig } from '../types';
import {
  loadOptimizeInputs,
  optimizeConfigFor,
  optimizedMachineCount,
  type OptimizeInputs,
  type SetupOperatorSettings,
} from '../lib/theoreticalOperators';

export interface OptimizedCount {
  machinesPerOperator: number;
  hasDefaultLayout: boolean;
}

/** Runs Optimize in a Web Worker when the browser allows one, else on the main thread (one per tick
 * so the page keeps painting). */
class OptimizeRunner {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, { config: AppConfig; resolve: (count: number) => void }>();

  constructor() {
    try {
      this.worker = new Worker(new URL('../workers/optimizeCount.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<{ id: number; count: number }>) => {
        this.pending.get(event.data.id)?.resolve(event.data.count);
        this.pending.delete(event.data.id);
      };
      this.worker.onerror = () => {
        // Can't run here: finish what's waiting on the main thread and stop using it.
        this.worker?.terminate();
        this.worker = null;
        const waiting = [...this.pending.values()];
        this.pending.clear();
        waiting.forEach(({ config, resolve }) => setTimeout(() => resolve(optimizedMachineCount(config)), 0));
      };
    } catch {
      this.worker = null;
    }
  }

  run(config: AppConfig): Promise<number> {
    if (!this.worker) return new Promise((resolve) => setTimeout(() => resolve(optimizedMachineCount(config)), 0));
    const id = (this.nextId += 1);
    return new Promise((resolve) => {
      this.pending.set(id, { config, resolve });
      this.worker!.postMessage({ id, config });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

/**
 * Optimize Man Occupation's # Assigned Machines for each Construction Detail id, with the Production
 * Setup's operator settings (Default Layout and Optimize Step-Up from Default Values). Worked out in
 * the background and kept per settings + Construction Detail for the rest of the page's life — a
 * changed setting works them out again, switching back (or between setups) reuses what's known.
 */
export function useOptimizedMachineCounts(
  productIds: string[],
  products: Mpp_wl_productses[],
  base: AppConfig,
  settings: SetupOperatorSettings | null,
) {
  /** Keyed `<settings>
<productId>`. */
  const [allCounts, setAllCounts] = useState<ReadonlyMap<string, OptimizedCount>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<OptimizeInputs | null>(null);
  const baseRef = useRef(base);
  const requested = useRef(new Set<string>());
  const runnerRef = useRef<OptimizeRunner | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadOptimizeInputs()
      .then((loaded) => {
        if (!cancelled) setInputs(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load Default Values / WL_Activities.');
      });
    const runner = new OptimizeRunner();
    runnerRef.current = runner;
    const requestedIds = requested.current;
    return () => {
      cancelled = true;
      runner.dispose();
      runnerRef.current = null;
      requestedIds.clear();
    };
  }, []);

  const idsKey = [...new Set(productIds)].sort().join('|');
  const settingsKey = settings ? JSON.stringify(settings) : '';
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  });
  useEffect(() => {
    const runner = runnerRef.current;
    const currentSettings = settingsRef.current;
    if (!inputs || !runner || products.length === 0 || !currentSettings) return;
    const productById = new Map(products.map((product) => [product.mpp_wl_productsid, product]));
    const requestedIds = requested.current;
    const keyOf = (id: string) => `${settingsKey}
${id}`;
    const todo = idsKey.split('|').filter((id) => id && !requestedIds.has(keyOf(id)) && productById.has(id));
    todo.forEach((id) => requestedIds.add(keyOf(id)));
    const finished = new Set<string>();
    let alive = true;
    void (async () => {
      for (const id of todo) {
        if (!alive) return;
        const { config, hasDefaultLayout } = optimizeConfigFor(baseRef.current, productById.get(id)!, inputs, currentSettings);
        const machinesPerOperator = await runner.run(config);
        if (!alive) return;
        finished.add(id);
        setAllCounts((prev) => new Map(prev).set(keyOf(id), { machinesPerOperator, hasDefaultLayout }));
      }
    })();
    return () => {
      alive = false;
      // Not finished yet: let the next run pick these up again.
      todo.forEach((id) => {
        if (!finished.has(id)) requestedIds.delete(keyOf(id));
      });
    };
  }, [idsKey, settingsKey, inputs, products]);

  /** This settings' counts, by Construction Detail id. */
  const counts = useMemo(() => {
    const prefix = `${settingsKey}
`;
    const current = new Map<string, OptimizedCount>();
    allCounts.forEach((count, key) => {
      if (key.startsWith(prefix)) current.set(key.slice(prefix.length), count);
    });
    return current as ReadonlyMap<string, OptimizedCount>;
  }, [allCounts, settingsKey]);

  return { counts, error, loading: !inputs && !error };
}
