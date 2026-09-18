import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface PanelPosition {
  left: number;
  width: number;
  top: number | null;
  bottom: number | null;
  /** Caps `.searchable-select-list`'s height to whatever room is actually available above/below
   * the trigger, so a long option list always scrolls fully into view instead of running off the
   * bottom of the screen (or, in a cramped side panel, visually crashing into the next field). */
  listMaxHeight: number;
}

/** Below this width, machine/operator labels like "Operator 0004" get chopped to "O.. 0004" — wide
 * enough for that not to happen, while still shrinking to the trigger's own width when it's
 * already wider than this (e.g. a full-row Construction Detail select). */
const MIN_PANEL_WIDTH = 240;
/** Search input + its margin + panel padding — subtracted from available vertical space to get
 * the room actually left for the scrollable option list itself. */
const PANEL_CHROME_HEIGHT = 54;
const MAX_LIST_HEIGHT = 280;
/** Absolute floor so the list never collapses to nothing — only bites in a genuinely tiny
 * viewport; every realistic case is sized from actual available space instead (see updatePosition). */
const MIN_LIST_HEIGHT_FLOOR = 60;
const VIEWPORT_MARGIN = 8;

/** A `<select>` replacement with a search box, for dropdowns that can grow into long lists (e.g.
 * Construction Detail from WL_Products, or Operators in a Production Setup with many machines) —
 * a plain native select has no filter, making the right option hard to find once the list grows.
 *
 * The option panel is rendered through a portal at `position: fixed`, computed from the trigger's
 * own bounding box, instead of being positioned relative to this component — an ordinary
 * `position: absolute` dropdown gets silently clipped by any scrollable ancestor with
 * `overflow: hidden/auto` (e.g. the Layout Builder's fullscreen side panel), which a portal avoids
 * entirely. It portals into `document.fullscreenElement` when one is active — the Fullscreen API
 * only paints that element's own subtree, so a portal to `document.body` would otherwise vanish
 * the moment fullscreen is entered. */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Cari…',
  disabled = false,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  const updatePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const fullPanelHeight = PANEL_CHROME_HEIGHT + MAX_LIST_HEIGHT;
    // Open downward whenever it can fit the full-size panel; only flip upward when downward can't
    // but upward can. If NEITHER side has room for the full panel (a genuinely cramped column,
    // e.g. three stacked operator selects in the Assign panel), pick whichever side has more room
    // and shrink the list to fit it exactly — that's the case the old logic got wrong: it kept
    // opening downward even when downward had less room than up, so the panel ran past the bottom
    // of the screen instead of flipping.
    let openUpward: boolean;
    if (spaceBelow >= fullPanelHeight) openUpward = false;
    else if (spaceAbove >= fullPanelHeight) openUpward = true;
    else openUpward = spaceAbove > spaceBelow;
    const available = openUpward ? spaceAbove : spaceBelow;
    // Deliberately NOT clamped up to a minimum bigger than `available` — doing that is exactly
    // what let the panel overflow past the viewport edge before, since it forced a taller list
    // than the space actually left for it.
    const listMaxHeight = Math.max(MIN_LIST_HEIGHT_FLOOR, Math.min(MAX_LIST_HEIGHT, available - PANEL_CHROME_HEIGHT));
    const width = Math.max(rect.width, MIN_PANEL_WIDTH);
    // A wider-than-trigger panel can overshoot the right edge of the screen — pin it to the
    // trigger's right edge instead of its left edge in that case, clamped so it never runs off
    // the left edge either.
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN));
    setPosition({
      left,
      width,
      top: openUpward ? null : rect.bottom + 4,
      bottom: openUpward ? window.innerHeight - rect.top + 4 : null,
      listMaxHeight,
    });
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    setQuery('');
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focusing the search box has to wait for the PORTALED panel to actually exist in the DOM —
  // `updatePosition()` above only sets `position` state, and the portal (with the input inside it)
  // only mounts once that state lands in a render, one tick after `open` first flips true. A
  // single requestAnimationFrame right after `open` changes fires too early for that portal render
  // to have happened yet, so the focus call was silently landing on nothing. Keying this off
  // `position` becoming non-null (rather than `open` alone) means the DOM node is guaranteed to
  // exist by the time this runs; the "already focused" guard stops it from re-stealing focus on
  // every later reposition (e.g. scrolling the page while the panel is open).
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedRef.current = false;
      return;
    }
    if (!position || focusedRef.current) return;
    focusedRef.current = true;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const portalTarget = open ? document.fullscreenElement ?? document.body : null;

  return (
    <div className={`searchable-select ${className}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="input searchable-select-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
      >
        <span className={selected ? 'searchable-select-value' : 'searchable-select-placeholder'}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="searchable-select-caret">▾</span>
      </button>
      {open && position && portalTarget &&
        createPortal(
          <div
            ref={panelRef}
            className="searchable-select-panel searchable-select-panel-portal"
            style={{
              position: 'fixed',
              left: position.left,
              width: position.width,
              top: position.top ?? 'auto',
              bottom: position.bottom ?? 'auto',
              right: 'auto',
            }}
          >
            <input
              ref={inputRef}
              className="input searchable-select-search"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setOpen(false);
                } else if (e.key === 'Enter' && filtered.length > 0) {
                  onChange(filtered[0].value);
                  setOpen(false);
                }
              }}
            />
            <div className="searchable-select-list" style={{ maxHeight: position.listMaxHeight }}>
              <button
                type="button"
                className={`searchable-select-option ${!value ? 'active' : ''}`}
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                {placeholder}
              </button>
              {filtered.length === 0 && <div className="searchable-select-empty">Tidak ada hasil</div>}
              {filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`searchable-select-option ${o.value === value ? 'active' : ''}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>,
          portalTarget,
        )}
    </div>
  );
}
