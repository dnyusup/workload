import type { Mpp_wl_activities } from '../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_outputmodelses } from '../generated/models/Mpp_wl_outputmodelsesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import { Mpp_wl_activitiesService } from '../generated/services/Mpp_wl_activitiesService';
import { Mpp_wl_outputmodelsesService } from '../generated/services/Mpp_wl_outputmodelsesService';
import type { AppConfig } from '../types';
import { areaUsesLayLength, deriveMachineSpec } from './calculations';
import { buildConstructionConfig } from './constructionConfig';
import { escapeODataString, fetchAllPages } from './dataversePaging';
import { loadDefaultLayouts, loadDefaultValues } from './defaultValuesStore';
import { buildOutputModelPayload, createOutputModel, percentageForDisplay, replaceOutputModel } from './outputModel';
import { loadSavedLayouts } from './savedLayoutsStore';
import { optimizeAndSimulate, type BatchSimulationResult } from './batchSimulationCore';
import { calculateSingleOperatorForecast } from './singleOperatorUtilization';

/** Every batch result is saved as this version of the Construction Detail, replacing it if it exists. */
const BATCH_VERSION = '0001';
/** Saves to WL_Outputmodels kept in flight while the next items simulate. */
const SAVE_CONCURRENCY = 4;

export interface BatchLogEntry {
  productId: string;
  constructionDetail: string;
  area: string;
  status: 'success' | 'failed' | 'cancelled';
  /** Success only: whether version 0001 was created or replaced. */
  action?: 'created' | 'replaced';
  machines?: number;
  forecastManOccupation?: number;
  actualManOccupation?: number;
  tonPerShift?: number;
  /** Why it failed, or a short note on success. */
  message: string;
  durationMs: number;
}

/** Runs the compute part in a Web Worker when the browser allows one, else on the main thread
 * (yielding between items so the progress bar still repaints). */
class SimulationRunner {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, (result: BatchSimulationResult) => void>();

  constructor() {
    try {
      this.worker = new Worker(new URL('../workers/batchSimulation.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<{ id: number; result: BatchSimulationResult }>) => {
        this.pending.get(event.data.id)?.(event.data.result);
        this.pending.delete(event.data.id);
      };
      this.worker.onerror = () => {
        // The worker can't run here — finish what's waiting on the main thread and stop using it.
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  run(config: AppConfig): Promise<BatchSimulationResult> {
    if (!this.worker) {
      return new Promise((resolve) => setTimeout(() => resolve(optimizeAndSimulate(config)), 0));
    }
    const id = (this.nextId += 1);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker!.postMessage({ id, config });
      // If the worker died meanwhile, fall back for this item too.
      setTimeout(() => {
        if (!this.worker && this.pending.has(id)) {
          this.pending.delete(id);
          resolve(optimizeAndSimulate(config));
        }
      }, 0);
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}

function specProblems(product: Mpp_wl_productses): string[] {
  const missing: string[] = [];
  const positive = (value: unknown) => {
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
    return Number.isFinite(n) && n > 0;
  };
  if (!positive(product.mpp_speed)) missing.push('Speed');
  // Only Areas whose runtime comes from the twisting formula need a lay length (not WW, BA, CA, IS, IP, CH, CR).
  if (areaUsesLayLength(product.mpp_area ?? '') && !positive(product.mpp_laylength)) {
    missing.push('LayLength');
  }
  if (!positive(product.mpp_spoollength)) missing.push('SpoolLength');
  if (!positive(product.mpp_numberoffibers)) missing.push('NoOfWires');
  if (!positive(product.mpp_lineardensity)) missing.push('LinearDensity');
  return missing;
}

/**
 * Batch Simulation: for each Construction Detail, the Work Load Simulator setup from Default
 * Values and the Area's Default Layout, Optimize Man Occupation, one simulated shift, and the result
 * saved to WL_Outputmodels as version 0001 (replacing it when it exists). Each item's outcome —
 * success, or why it failed — is reported through onItemDone as soon as it's known.
 */
export async function runBatchSimulation({
  products,
  base,
  updatedBy,
  onItemDone,
  isCancelled,
}: {
  products: Mpp_wl_productses[];
  base: AppConfig;
  updatedBy: string;
  onItemDone: (entry: BatchLogEntry, index: number) => void;
  isCancelled: () => boolean;
}): Promise<BatchLogEntry[]> {
  if (!updatedBy.trim()) throw new Error('The signed-in email is unavailable, so results cannot be saved.');
  const [defaults, layoutIdsByArea, savedLayouts, outputRows] = await Promise.all([
    loadDefaultValues(),
    loadDefaultLayouts(),
    loadSavedLayouts(),
    fetchAllPages(Mpp_wl_outputmodelsesService.getAll, {
      select: ['mpp_wl_outputmodelsid', 'mpp_constructiondetailcode', 'mpp_version', 'mpp_versionremark'],
    }),
  ]);
  const layoutById = new Map(savedLayouts.map((layout) => [layout.id, layout]));
  const detailKey = (detail: string) => detail.trim().toLowerCase();
  const version0001 = new Map<string, Mpp_wl_outputmodelses>();
  outputRows.forEach((row) => {
    if ((row.mpp_version ?? '0001') === BATCH_VERSION && row.mpp_constructiondetailcode) {
      version0001.set(detailKey(row.mpp_constructiondetailcode), row);
    }
  });

  // Activities are per Construction — load each Construction once however many details share it.
  const activitiesByConstruction = new Map<string, Promise<{ rows: Mpp_wl_activities[]; error?: string }>>();
  const activitiesFor = (construction: string) => {
    let promise = activitiesByConstruction.get(construction);
    if (!promise) {
      promise = Mpp_wl_activitiesService.getAll({ filter: `mpp_constructiontype eq '${escapeODataString(construction)}'` }).then(
        (result) => (result.success ? { rows: result.data ?? [] } : { rows: [], error: result.error?.message ?? 'Request failed.' }),
        (err) => ({ rows: [], error: err instanceof Error ? err.message : 'Request failed.' }),
      );
      activitiesByConstruction.set(construction, promise);
    }
    return promise;
  };

  const runner = new SimulationRunner();
  const log: BatchLogEntry[] = new Array(products.length);
  const saves = new Set<Promise<void>>();
  /** Saves of one Construction Detail run one after another, so two never both create 0001. */
  const saveChainByDetail = new Map<string, Promise<void>>();

  const finish = (index: number, entry: BatchLogEntry) => {
    log[index] = entry;
    onItemDone(entry, index);
  };

  try {
    for (let index = 0; index < products.length; index += 1) {
      const product = products[index];
      const started = performance.now();
      const constructionDetail = product.mpp_constructiondetailcode?.trim() ?? '';
      const area = product.mpp_area?.trim().toUpperCase() ?? '';
      const fail = (message: string) =>
        finish(index, { productId: product.mpp_wl_productsid, constructionDetail, area, status: 'failed', message, durationMs: performance.now() - started });

      if (isCancelled()) {
        finish(index, { productId: product.mpp_wl_productsid, constructionDetail, area, status: 'cancelled', message: 'Batch cancelled before this item.', durationMs: 0 });
        continue;
      }
      if (!constructionDetail) {
        fail('Construction Detail is empty.');
        continue;
      }
      const construction = product.mpp_constructioncode?.trim();
      if (!construction) {
        fail('Construction is empty, so its activities can\'t be found in WL_Activities.');
        continue;
      }
      if (!area) {
        fail('Area is empty.');
        continue;
      }
      const layoutId = layoutIdsByArea[area];
      if (!layoutId) {
        fail(`No default layout for Area ${area} (Setting → Default Layouts).`);
        continue;
      }
      const layout = layoutById.get(layoutId);
      if (!layout) {
        fail(`The default layout for Area ${area} no longer exists in WL_Layouts.`);
        continue;
      }
      if (layout.machines.length === 0) {
        fail(`The default layout for Area ${area} ("${layout.name}") has no machines.`);
        continue;
      }
      const missingSpec = specProblems(product);
      if (missingSpec.length > 0) {
        fail(`Missing or zero in WL_Products: ${missingSpec.join(', ')}.`);
        continue;
      }
      const activities = await activitiesFor(construction);
      if (activities.error) {
        fail(`Failed to load WL_Activities: ${activities.error}`);
        continue;
      }
      if (activities.rows.length === 0) {
        fail(`No activities in WL_Activities for Construction ${construction}.`);
        continue;
      }
      const built = buildConstructionConfig({ base, product, activityRows: activities.rows, defaults, layout });
      if (built.errors.length > 0) {
        fail(built.errors.join(' '));
        continue;
      }
      const runtime = deriveMachineSpec(built.config.spec).runtimePerSpool;
      if (!Number.isFinite(runtime) || runtime <= 0) {
        fail('Runtime per spool can\'t be worked out from the spec (check Speed, LayLength, SpoolLength).');
        continue;
      }

      const result = await runner.run(built.config);
      if (!result.ok) {
        fail(result.error);
        continue;
      }

      const key = detailKey(constructionDetail);
      const save = (saveChainByDetail.get(key) ?? Promise.resolve()).then(async () => {
        try {
          const payload = buildOutputModelPayload(result.config, result.state, product, updatedBy, { version: BATCH_VERSION });
          const existing = version0001.get(key);
          let action: BatchLogEntry['action'];
          if (existing) {
            await replaceOutputModel(existing.mpp_wl_outputmodelsid, {
              ...payload,
              mpp_version: BATCH_VERSION,
              mpp_versionremark: existing.mpp_versionremark,
            });
            action = 'replaced';
          } else {
            version0001.set(key, await createOutputModel(payload));
            action = 'created';
          }
          const forecast = calculateSingleOperatorForecast(result.config);
          finish(index, {
            productId: product.mpp_wl_productsid,
            constructionDetail,
            area,
            status: 'success',
            action,
            machines: result.state.metrics.assignedMachineCount,
            forecastManOccupation: forecast.forecastUtilizationPercent,
            actualManOccupation: percentageForDisplay(payload.mpp_actualmanoccupation),
            tonPerShift: payload.mpp_tonspershift,
            message: action === 'replaced' ? 'Version 0001 replaced.' : 'Version 0001 created.',
            durationMs: performance.now() - started,
          });
        } catch (err) {
          fail(`Simulated, but saving to WL_Outputmodels failed: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      });
      saveChainByDetail.set(key, save);
      saves.add(save);
      void save.finally(() => saves.delete(save));
      if (saves.size >= SAVE_CONCURRENCY) await Promise.race(saves);
    }
    await Promise.all(saves);
  } finally {
    runner.dispose();
  }
  return log;
}
