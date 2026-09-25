import { useEffect, useRef, useState } from 'react';

/** Minimum height that makes the ref'd element reach the bottom of the window (minus
 * `bottomGap`). Used by the simulation dashboards: they normally match the canvas column's height,
 * which left empty space below them whenever the page is shorter than the window (e.g. browser
 * zoomed out). Re-measured on window resize (which includes browser zoom) and whenever the page
 * content changes size; undefined in the stacked single-column layout (≤ 900px), where the
 * dashboard simply flows below the canvas. */
export function useFillToWindowBottom<T extends HTMLElement>(bottomGap = 16) {
  const ref = useRef<T>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      if (window.matchMedia('(max-width: 900px)').matches) {
        setMinHeight(undefined);
        return;
      }
      const top = el.getBoundingClientRect().top + window.scrollY;
      setMinHeight(Math.max(0, Math.floor(window.innerHeight - top - bottomGap)));
    };
    // Fires once right away too, so the first measurement needs no extra call.
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [bottomGap]);

  return { ref, minHeight };
}
