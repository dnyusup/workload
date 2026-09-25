import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';

export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 32;

/** One zoom level shared by every timeline (Operator + Machine, in every simulator view), driven
 * by a single zoom bar. 1 = the whole shift fits the list's width ("fit to shift"); higher values
 * widen every track by that factor inside each list's horizontal scroll. */
let currentZoom = MIN_TIMELINE_ZOOM;
const listeners = new Set<() => void>();
/** Each scrolling list records which time sits in its middle just before the zoom changes. */
const beforeZoomChange = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setTimelineZoom(next: number) {
  const clamped = Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, next));
  if (clamped === currentZoom) return;
  beforeZoomChange.forEach((capture) => capture());
  currentZoom = clamped;
  listeners.forEach((listener) => listener());
}

/** Zoom level + setters for the zoom bar. */
export function useTimelineZoom() {
  const zoom = useSyncExternalStore(subscribe, () => currentZoom);
  return { zoom, setZoom: setTimelineZoom, fitToShift: () => setTimelineZoom(MIN_TIMELINE_ZOOM) };
}

/** For one scrolling timeline list: put `scrollRef` + `scrollStyle` (+ the `timeline-zoom-scroll`
 * class) on the element that scrolls. Zooming keeps whatever time was in the middle of this list's
 * view in the middle. */
export function useTimelineZoomScroll() {
  const zoom = useSyncExternalStore(subscribe, () => currentZoom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const centerRatioRef = useRef<number | null>(null);

  useEffect(() => {
    const capture = () => {
      const el = scrollRef.current;
      if (el && el.scrollWidth > 0) centerRatioRef.current = (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth;
    };
    beforeZoomChange.add(capture);
    return () => {
      beforeZoomChange.delete(capture);
    };
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const ratio = centerRatioRef.current;
    centerRatioRef.current = null;
    if (!el || ratio === null) return;
    el.scrollLeft = Math.max(0, ratio * el.scrollWidth - el.clientWidth / 2);
  }, [zoom]);

  const scrollStyle = { '--timeline-zoom': zoom } as CSSProperties;
  return { zoom, scrollRef, scrollStyle };
}
