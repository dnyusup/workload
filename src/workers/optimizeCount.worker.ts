import type { AppConfig } from '../types';
import { recommendedMachineCountForForecast } from '../lib/singleOperatorUtilization';

/** Optimize Man Occupation off the main thread (Production Setup's Theoretical Operator Required):
 * one config in, its machine count out (matched by id). */
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; config: AppConfig }>) => void) | null;
  postMessage: (message: unknown) => void;
};

worker.onmessage = (event) => {
  const { id, config } = event.data;
  let count = 0;
  try {
    count = recommendedMachineCountForForecast(config);
  } catch {
    count = 0;
  }
  worker.postMessage({ id, count });
};
