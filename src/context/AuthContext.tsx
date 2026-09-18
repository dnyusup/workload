import { createContext, useContext, useMemo, useState, useEffect, useCallback, type ReactNode } from 'react';
import { Office365UsersService } from '../generated/services/Office365UsersService';
import { Mpp_wl_usersesService } from '../generated/services/Mpp_wl_usersesService';
import { fetchAllPages } from '../lib/dataversePaging';

export type UserRole = 'admin' | 'contribute' | 'guest';

export interface AuthUser {
  email: string;
  displayName: string;
  /** 'guest' whenever the signed-in email has no row in WL_Users — matches the app's definition
   * of Guest as "not in the access table", rather than an explicit role value. */
  role: UserRole;
}

interface AuthContextValue {
  user: AuthUser;
  loading: boolean;
  error: string | null;
  /** Re-fetches WL_Users — call after adding/editing/removing a row in Manage Users so role
   * changes (including to the current user themself) take effect without a full page reload. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const UNKNOWN_USER: AuthUser = { email: '', displayName: 'Unknown User', role: 'guest' };

function roleFromRow(raw: string | undefined): UserRole | null {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'admin') return 'admin';
  if (normalized === 'contribute') return 'contribute';
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser>(UNKNOWN_USER);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const profileResult = await Office365UsersService.MyProfile();
      const email = (profileResult.data?.Mail ?? profileResult.data?.UserPrincipalName ?? '').trim();
      const displayName = profileResult.data?.DisplayName?.trim() || email || 'Unknown User';
      if (!email) {
        setUser({ email: '', displayName, role: 'guest' });
        return;
      }
      const rows = await fetchAllPages(Mpp_wl_usersesService.getAll, {});
      const match = rows.find((row) => (row.mpp_email ?? '').trim().toLowerCase() === email.toLowerCase());
      const role = roleFromRow(match?.mpp_role) ?? 'guest';
      setUser({ email, displayName, role });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to determine the current user — access defaults to Guest.');
      setUser(UNKNOWN_USER);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo(() => ({ user, loading, error, refresh }), [user, loading, error, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
