import { useEffect, useRef, useState } from 'react';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { AppConfig } from '../types';
import { loadOptimizeInputs, optimizeConfigFor, optimizedMachineCount, type OptimizeInputs } from '../lib/theoreticalOperators';

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
 * Optimize Man Occupation's # Assigned Machines for each Construction Detail id — the count the
 * Work Load Simulator would find when that Construction Detail is picked there. Worked out in the
 * background as ids appear and kept for the rest of the page's life, so switching setups only works
 * out the Construction Details not seen yet.
 */
export function useOptimizedMachineCounts(productIds: string[], products: Mpp_wl_productses[], base: AppConfig) {
  const [counts, setCounts] = useState<ReadonlyMap<string, OptimizedCount>>(() => new Map());
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
  useEffect(() => {
    const runner = runnerRef.current;
    if (!inputs || !runner || products.length === 0) return;
    const productById = new Map(products.map((product) => [product.mpp_wl_productsid, product]));
    const requestedIds = requested.current;
    const todo = idsKey.split('|').filter((id) => id && !requestedIds.has(id) && productById.has(id));
    todo.forEach((id) => requestedIds.add(id));
    const finished = new Set<string>();
    let alive = true;
    void (async () => {
      for (const id of todo) {
        if (!alive) return;
        const { config, hasDefaultLayout } = optimizeConfigFor(baseRef.current, productById.get(id)!, inputs);
        const machinesPerOperator = await runner.run(config);
        if (!alive) return;
        finished.add(id);
        setCounts((prev) => new Map(prev).set(id, { machinesPerOperator, hasDefaultLayout }));
      }
    })();
    return () => {
      alive = false;
      // Not finished yet: let the next run pick these up again.
      todo.forEach((id) => {
        if (!finished.has(id)) requestedIds.delete(id);
      });
    };
  }, [idsKey, inputs, products]);

  return { counts, error, loading: !inputs && !error };
}
