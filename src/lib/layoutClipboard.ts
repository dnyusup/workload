import type { LayoutMachine, LayoutWall, LayoutRemark } from '../types';

export const LAYOUT_CLIPBOARD_STORAGE_KEY = 'wl_layout_clipboard';

export type LayoutClipboardKind = 'machines' | 'wall' | 'remark';

export interface LayoutClipboardData {
  kind: LayoutClipboardKind;
  machines?: LayoutMachine[];
  wall?: LayoutWall;
  remark?: LayoutRemark;
  copiedAt: number;
}

/** Reads the shared cross-tab layout clipboard from localStorage. */
export function getLayoutClipboard(): LayoutClipboardData | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LAYOUT_CLIPBOARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LayoutClipboardData;
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.kind === 'machines' && Array.isArray(parsed.machines) && parsed.machines.length > 0) {
      return parsed;
    }
    if (parsed.kind === 'wall' && parsed.wall && typeof parsed.wall === 'object') {
      return parsed;
    }
    if (parsed.kind === 'remark' && parsed.remark && typeof parsed.remark === 'object') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Saves the layout clipboard to localStorage and broadcasts to other tabs. */
export function setLayoutClipboard(data: LayoutClipboardData): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAYOUT_CLIPBOARD_STORAGE_KEY, JSON.stringify(data));
    }
    // Also try writing to system clipboard if permitted
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(JSON.stringify({ __type: 'wl_layout_clipboard', ...data })).catch(() => {});
    }
  } catch (err) {
    console.warn('Failed to save layout clipboard:', err);
  }
}

/** Subscribes to cross-tab clipboard changes via storage and window focus events. */
export function subscribeLayoutClipboard(onChange: (data: LayoutClipboardData | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const storageHandler = (e: StorageEvent) => {
    if (e.key === LAYOUT_CLIPBOARD_STORAGE_KEY) {
      onChange(getLayoutClipboard());
    }
  };
  const focusHandler = () => {
    onChange(getLayoutClipboard());
  };

  window.addEventListener('storage', storageHandler);
  window.addEventListener('focus', focusHandler);

  return () => {
    window.removeEventListener('storage', storageHandler);
    window.removeEventListener('focus', focusHandler);
  };
}

