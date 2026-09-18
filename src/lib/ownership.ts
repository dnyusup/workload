import type { AuthUser } from '../context/AuthContext';

/** Shared ownership check for Layouts/Production Setups: prefer the stamped creator email
 * (mpp_creator_email, set at creation time) since it's an exact identity match; fall back to
 * Dataverse's own `createdbyname` for records created before that column existed, where email
 * was never recorded. */
export function isOwnedByCurrentUser(record: { createdByEmail: string; createdByName: string }, user: AuthUser): boolean {
  if (record.createdByEmail) return record.createdByEmail.trim().toLowerCase() === user.email.trim().toLowerCase();
  return record.createdByName.trim().toLowerCase() === user.displayName.trim().toLowerCase();
}
