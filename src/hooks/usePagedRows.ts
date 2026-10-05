import { useMemo, useState } from 'react';

export const DEFAULT_PAGE_SIZE = 100;

/** One page of a (filtered, sorted) list — tables with thousands of rows of inputs render only this
 * many at a time. `resetKey` is whatever decides the list (search, filters, sort): when it changes
 * the page goes back to 1. A page past the end (rows deleted) falls back to the last one. */
export function usePagedRows<T>(rows: T[], resetKey: string, pageSize = DEFAULT_PAGE_SIZE) {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(state.key === resetKey ? state.page : 1, pageCount);
  const pageRows = useMemo(() => rows.slice((page - 1) * pageSize, page * pageSize), [rows, page, pageSize]);
  const setPage = (next: number) => setState({ key: resetKey, page: Math.max(1, Math.min(Math.floor(next), pageCount)) });
  return { page, pageCount, pageSize, total: rows.length, pageRows, setPage };
}
