import type { IGetAllOptions } from '../generated/models/CommonModels';
import type { IOperationResult } from '@microsoft/power-apps/data';

/** Loops on `skipToken` until every page of a getAll() call is collected — a single request can
 * come back capped (Dataverse's own page-size limits), which matters once a table holds more rows
 * than one page (e.g. WL_ProductionSetupMachines at real-factory machine counts). Throws on the
 * first failed page so a partial/silently-truncated result is never mistaken for the full set. */
export async function fetchAllPages<T>(
  getAll: (options?: IGetAllOptions) => Promise<IOperationResult<T[]>>,
  options: IGetAllOptions = {},
): Promise<T[]> {
  const all: T[] = [];
  let skipToken: string | undefined;
  do {
    const result = await getAll({ ...options, maxPageSize: options.maxPageSize ?? 5000, skipToken });
    if (!result.success) {
      throw new Error(result.error?.message ?? 'Dataverse request failed');
    }
    all.push(...(result.data ?? []));
    skipToken = result.skipToken;
  } while (skipToken);
  return all;
}

export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Runs `worker` over every item with at most `concurrency` requests in flight at once, instead
 * of one-at-a-time — the generated Dataverse client has no batch endpoint, so bulk create/update/
 * delete (e.g. one row per machine in a Production Setup) means one HTTP call per row; fully
 * sequential, that's ~minutes for a few hundred rows since each call pays its own network
 * round-trip. A small concurrency pool (not "all at once", which risks throttling) cuts that by
 * roughly the pool size while still calling `onProgress` after each completion so the UI can show
 * real progress instead of looking hung. */
export async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const total = items.length;
  if (total === 0) return;
  let nextIndex = 0;
  let done = 0;
  const runOne = async () => {
    while (nextIndex < total) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
      done += 1;
      onProgress?.(done, total);
    }
  };
  const poolSize = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: poolSize }, runOne));
}
