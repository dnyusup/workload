import { createContext, useContext } from 'react';

export type UserRole = 'admin' | 'contribute' | 'guest';

export interface AuthUser {
  email: string;
  displayName: string;
  /** 'guest' whenever the signed-in email has no row in WL_Users — matches the app's definition
   * of Guest as "not in the access table", rather than an explicit role value. */
  role: UserRole;
}

export interface AuthContextValue {
  user: AuthUser;
  loading: boolean;
  error: string | null;
  /** Re-fetches WL_Users — call after adding/editing/removing a row in Manage Users so role
   * changes (including to the current user themself) take effect without a full page reload. */
  refresh: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
