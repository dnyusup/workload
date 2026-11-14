import { createContext, useContext } from 'react';

export type UserRole = 'admin' | 'contribute' | 'guest';

export interface AuthUser {
  email: string;
  displayName: string;
  /** 'guest' whenever the signed-in email has no row in WL_Users — matches the app's definition
   * of Guest as "not in the access table", rather than an explicit role value. */
  role: UserRole;
  /** Maximum number of Production Setups this user can create (applies to Contribute role). */
  maxSetup?: number;
  /** Whether a Guest user has any Production Setups shared to them. */
  hasSharedSetups?: boolean;
  /** Whether the user has access to WLM Agent features (stored in WL_users.mpp_aifeatures). */
  aiFeatures?: 'Yes' | 'No' | string;
}

/** Determines if the user is authorized to use WLM Agent (AI features).
 * Admins always have access; Contribute users only if aiFeatures === 'Yes'. */
export function canAccessAiFeatures(user?: AuthUser | null): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'contribute') {
    const val = (user.aiFeatures ?? '').toString().trim().toLowerCase();
    return val === 'yes' || val === 'true';
  }
  return false;
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
