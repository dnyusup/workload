import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** Delays invoking `callback` until `delayMs` has passed with no further calls — for persisting
 * to Dataverse only after the user pauses (e.g. dragging a machine, typing a name), instead of
 * firing a write request on every single intermediate event. */
export function useDebouncedCallback<A extends unknown[]>(callback: (...args: A) => void, delayMs: number) {
  const callbackRef = useRef(callback);
  // Keep the latest callback without writing a ref during render; a layout effect runs before
  // any timer set by this render could possibly fire.
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  return useCallback(
    (...args: A) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => callbackRef.current(...args), delayMs);
    },
    [delayMs],
  );
}
