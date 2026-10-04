import type { AppConfig } from '../types';
import { optimizeAndSimulate } from '../lib/batchSimulationCore';

/** Batch Simulation's compute, off the main thread so the page stays responsive: one message per
 * item in, one result out (matched by id). */
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; config: AppConfig }>) => void) | null;
  postMessage: (message: unknown) => void;
};

worker.onmessage = (event) => {
  const { id, config } = event.data;
  try {
    worker.postMessage({ id, result: optimizeAndSimulate(config) });
  } catch (err) {
    worker.postMessage({ id, result: { ok: false, error: err instanceof Error ? err.message : 'Simulation failed.' } });
  }
};
