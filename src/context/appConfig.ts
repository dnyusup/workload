import { createContext, useContext } from 'react';
import type { AppConfig } from '../types';

export interface AppConfigContextValue {
  config: AppConfig;
  setConfig: (updater: (prev: AppConfig) => AppConfig) => void;
  resetToDefault: () => void;
}

export const AppConfigContext = createContext<AppConfigContextValue | null>(null);

export function useAppConfig() {
  const ctx = useContext(AppConfigContext);
  if (!ctx) throw new Error('useAppConfig must be used within AppConfigProvider');
  return ctx;
}
