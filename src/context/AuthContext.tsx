import { useMemo, useState, useEffect, useCallback, type ReactNode } from 'react';
import { Office365UsersService } from '../generated/services/Office365UsersService';
import { Mpp_wl_usersesService } from '../generated/services/Mpp_wl_usersesService';
import { fetchAllPages } from '../lib/dataversePaging';
import { AuthContext, type AuthUser, type UserRole } from './auth';

export type { AuthUser, UserRole } from './auth';

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

  // `loadUser` never sets state before its first await, so the initial load can run from the
  // mount effect directly; `refresh` (used after role changes) also clears any previous error.
  const loadUser = useCallback(async () => {
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

  const refresh = useCallback(async () => {
    setError(null);
    await loadUser();
  }, [loadUser]);

  // `loading` starts true, so the initial load doesn't need to set it again.
  useEffect(() => {
    // False positive: loadUser only sets state after its first await, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUser().finally(() => setLoading(false));
  }, [loadUser]);

  const value = useMemo(() => ({ user, loading, error, refresh }), [user, loading, error, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
