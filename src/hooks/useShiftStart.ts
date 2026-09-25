import { useSyncExternalStore } from 'react';
import { DEFAULT_SHIFT_START, isValidClock, parseClock } from '../lib/shiftClock';

const STORAGE_KEY = 'workload-shift-start';
const listeners = new Set<() => void>();

function read(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && isValidClock(stored) ? stored : DEFAULT_SHIFT_START;
  } catch {
    return DEFAULT_SHIFT_START;
  }
}

let current = read();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setShiftStart(value: string) {
  if (!isValidClock(value) || value === current) return;
  current = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Still applies for this session; just isn't remembered.
  }
  listeners.forEach((listener) => listener());
}

/** Shift start clock time ("HH:MM", 24-hour, default 07:00), shared by every simulator view —
 * the Play-bar field and the timelines it relabels stay in sync without prop drilling — and
 * remembered in this browser. */
export function useShiftStart() {
  const value = useSyncExternalStore(subscribe, () => current);
  return { shiftStart: value, shiftStartMin: parseClock(value), setShiftStart };
}
