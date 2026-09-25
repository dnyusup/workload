import { useEffect, useMemo, useRef, useState } from 'react';
import type { LegendEntry, LegendHover, LegendTab } from '../../lib/canvasLegend';

const DEFAULT_PANEL_WIDTH = 280;
const MIN_PANEL_WIDTH = 220;
/** Space kept free between the panel's right edge and the canvas's right edge. */
const CANVAS_EDGE_MARGIN = 16;

/** Collapsible legend pinned to the canvas's top-left corner: a small toggle button opens a
 * searchable list of Construction or operator colors. Hovering an entry reports it through
 * `onHover` so the canvas can highlight the machines it covers. */
export function CanvasLegendPanel({
  constructionEntries,
  operatorEntries,
  initialTab,
  onHover,
  hints,
}: {
  constructionEntries: LegendEntry[];
  operatorEntries: LegendEntry[];
  /** Tab shown each time the panel is opened (e.g. the current canvas view). */
  initialTab: LegendTab;
  onHover: (hovered: LegendHover) => void;
  /** Short explanation shown under the list for each tab. */
  hints?: Partial<Record<LegendTab, string>>;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<LegendTab>(initialTab);
  const [query, setQuery] = useState('');
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const rootRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number; maxWidth: number } | null>(null);

  const entries = tab === 'construction' ? constructionEntries : operatorEntries;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((entry) => entry.label.toLowerCase().includes(q)) : entries;
  }, [entries, query]);

  // Every open starts fresh: the canvas view's tab, no search, default width.
  const close = () => {
    setOpen(false);
    setQuery('');
    setWidth(DEFAULT_PANEL_WIDTH);
    onHover(null);
  };

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setTab(initialTab);
    setWidth(DEFAULT_PANEL_WIDTH);
    setQuery('');
    setOpen(true);
  };

  // Any pointer-down outside the legend hides it. Capture phase, because the canvas stops
  // propagation of its own machine clicks before they could bubble up to the document.
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Cap at the canvas's width so the panel can't be dragged past its right edge.
    const canvas = rootRef.current?.closest('[data-canvas-overlay]')?.parentElement;
    const rootLeft = rootRef.current?.getBoundingClientRect().left ?? 0;
    const canvasRight = canvas?.getBoundingClientRect().right ?? window.innerWidth;
    resizeRef.current = {
      startX: e.clientX,
      startWidth: width,
      maxWidth: Math.max(MIN_PANEL_WIDTH, canvasRight - rootLeft - CANVAS_EDGE_MARGIN),
    };
  };
  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    setWidth(Math.min(drag.maxWidth, Math.max(MIN_PANEL_WIDTH, drag.startWidth + e.clientX - drag.startX)));
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    resizeRef.current = null;
  };

  const switchTab = (next: LegendTab) => {
    setTab(next);
    setQuery('');
    onHover(null);
  };

  return (
    <div className="canvas-legend" ref={rootRef}>
      <button
        type="button"
        className={`canvas-legend-toggle${open ? ' is-open' : ''}`}
        onClick={toggle}
        title={open ? 'Hide legend' : 'Show legend'}
        aria-label={open ? 'Hide legend' : 'Show legend'}
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="5" height="4" rx="1" />
          <rect x="3" y="10" width="5" height="4" rx="1" />
          <rect x="3" y="16" width="5" height="4" rx="1" />
          <path d="M11 6h10M11 12h10M11 18h10" />
        </svg>
      </button>
      {open && (
        <div className="canvas-legend-panel" role="dialog" aria-label="Legend" style={{ width }}>
          <div
            className="canvas-legend-resize"
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            title="Drag to resize"
            aria-hidden="true"
          />
          <div className="canvas-legend-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'construction'}
              className={tab === 'construction' ? 'active' : ''}
              onClick={() => switchTab('construction')}
            >
              Construction ({constructionEntries.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'operator'}
              className={tab === 'operator' ? 'active' : ''}
              onClick={() => switchTab('operator')}
            >
              Operator ({operatorEntries.length})
            </button>
          </div>
          <input
            className="input input-sm canvas-legend-search"
            placeholder={tab === 'construction' ? 'Cari Construction…' : 'Cari Operator…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="canvas-legend-list" onMouseLeave={() => onHover(null)}>
            {filtered.length === 0 && <li className="canvas-legend-empty">Tidak ada hasil</li>}
            {filtered.map((entry) => (
              <li
                key={entry.id}
                className="canvas-legend-item"
                onMouseEnter={() => onHover({ tab, id: entry.id })}
                title={entry.label}
              >
                <span className="canvas-legend-swatch" style={{ background: entry.color }} />
                <span className="canvas-legend-label">{entry.label}</span>
                {entry.detail && <span className="canvas-legend-detail">{entry.detail}</span>}
                <span className="canvas-legend-count" title={`${entry.count} machine(s)`}>
                  {entry.count}
                </span>
              </li>
            ))}
          </ul>
          {hints?.[tab] && <p className="canvas-legend-hint">{hints[tab]}</p>}
        </div>
      )}
    </div>
  );
}
