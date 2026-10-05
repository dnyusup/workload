import { useState } from 'react';

/** "101–200 of 4,123 · ‹ Page [2] of 42 ›" for a paged table (see usePagedRows). */
export function TablePager({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
  label = 'rows',
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  label?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const commit = () => {
    if (draft === null) return;
    const value = Number(draft);
    if (Number.isFinite(value)) onPageChange(value);
    setDraft(null);
  };
  return (
    <div className="table-pager">
      <span className="table-pager-range">
        {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()} {label}
      </span>
      {pageCount > 1 && (
        <div className="table-pager-nav">
          <button type="button" onClick={() => onPageChange(1)} disabled={page <= 1} aria-label="First page" title="First page">
            «
          </button>
          <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page" title="Previous page">
            ‹
          </button>
          <span className="table-pager-page">
            Page
            <input
              className="input table-pager-input"
              type="number"
              min={1}
              max={pageCount}
              value={draft ?? String(page)}
              aria-label="Page number"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setDraft(null);
              }}
            />
            of {pageCount.toLocaleString()}
          </span>
          <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount} aria-label="Next page" title="Next page">
            ›
          </button>
          <button type="button" onClick={() => onPageChange(pageCount)} disabled={page >= pageCount} aria-label="Last page" title="Last page">
            »
          </button>
        </div>
      )}
    </div>
  );
}
