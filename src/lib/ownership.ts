import type { AuthUser } from '../context/AuthContext';

/** Shared ownership check for Layouts/Production Setups: prefer the stamped creator email
 * (mpp_creator_email, set at creation time) since it's an exact identity match; fall back to
 * Dataverse's own `createdbyname` for records created before that column existed, where email
 * was never recorded. */
export function isOwnedByCurrentUser(
  record: { createdByEmail?: string; createdByName?: string },
  user: AuthUser,
): boolean {
  if (record.createdByEmail) return record.createdByEmail.trim().toLowerCase() === user.email.trim().toLowerCase();
  return (record.createdByName ?? '').trim().toLowerCase() === user.displayName.trim().toLowerCase();
}

/** Checks whether a Production Setup is shared with the current user.
 * Looks up user's email in `sharedEmail` (semicolon/comma/space separated list of emails). */
export function isSharedWithCurrentUser(
  record: { sharedEmail?: string; createdByEmail?: string; createdByName?: string },
  user: AuthUser,
): boolean {
  if (!record.sharedEmail) return false;
  if (isOwnedByCurrentUser(record, user)) return false;
  const userEmail = (user.email ?? '').trim().toLowerCase();
  if (!userEmail) return false;
  const emails = record.sharedEmail
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return emails.includes(userEmail);
}

