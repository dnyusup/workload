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

export const LINK_SHARE_MARKER = '*';

/** Checks whether "Anyone with the link (Read-Only)" sharing is enabled in `sharedEmail`. */
export function isLinkSharingEnabled(sharedEmail?: string): boolean {
  if (!sharedEmail) return false;
  return sharedEmail
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .includes(LINK_SHARE_MARKER);
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
    .filter((e) => Boolean(e) && e !== LINK_SHARE_MARKER);
  return emails.includes(userEmail);
}

export type SharedRole = 'read' | 'edit';

export interface SharedUserEntry {
  email: string;
  role: SharedRole;
}

/** Parses shared emails and roles into an array of { email, role }.
 * Default role is 'read' for any entry missing a role. */
export function parseSharedUsers(
  sharedEmail?: string,
  sharedRole?: string,
): SharedUserEntry[] {
  if (!sharedEmail) return [];
  const emails = sharedEmail
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) return [];

  const rawRole = (sharedRole ?? '').trim().toLowerCase();

  // Support "email:role" pairs e.g. "a@b.com:edit;c@d.com:read"
  const mapFromPairs = new Map<string, SharedRole>();
  if (rawRole.includes(':')) {
    rawRole.split(/[,;\s]+/).forEach((part) => {
      const [mail, r] = part.split(':');
      if (mail && r) {
        mapFromPairs.set(mail.trim().toLowerCase(), r.trim().toLowerCase() === 'edit' ? 'edit' : 'read');
      }
    });
  }

  // Support parallel semicolon/comma separated roles e.g. "read;edit"
  const roleList = rawRole.split(/[,;\s]+/).map((r) => r.trim().toLowerCase());

  return emails
    .map((email, index): SharedUserEntry => {
      if (mapFromPairs.has(email)) {
        return { email, role: mapFromPairs.get(email)! };
      }
      if (roleList[index] === 'edit' || roleList[index] === 'read') {
        return { email, role: roleList[index] as SharedRole };
      }
      if (rawRole === 'edit') {
        return { email, role: 'edit' };
      }
      return { email, role: 'read' };
    })
    .filter((entry) => entry.email !== LINK_SHARE_MARKER);
}

/** Serializes shared user entries back into parallel strings for Dataverse */
export function serializeSharedUsers(
  users: SharedUserEntry[],
  linkEnabled = false,
): { sharedEmail: string; sharedRole: string } {
  const cleanUsers = users.filter((u) => {
    const email = u.email.trim().toLowerCase();
    return Boolean(email) && email !== LINK_SHARE_MARKER;
  });
  const entries = linkEnabled
    ? [...cleanUsers, { email: LINK_SHARE_MARKER, role: 'read' as SharedRole }]
    : cleanUsers;
  if (entries.length === 0) return { sharedEmail: '', sharedRole: '' };
  const sharedEmail = entries.map((u) => u.email.trim().toLowerCase()).join(';');
  const sharedRole = entries.map((u) => u.role).join(';');
  return { sharedEmail, sharedRole };
}

/** Returns the shared role of the current user ('read' | 'edit' | null). */
export function getSharedRoleForCurrentUser(
  record: { sharedEmail?: string; sharedRole?: string; createdByEmail?: string; createdByName?: string },
  user: AuthUser,
): SharedRole | null {
  if (!isSharedWithCurrentUser(record, user)) return null;
  const userEmail = (user.email ?? '').trim().toLowerCase();
  const sharedUsers = parseSharedUsers(record.sharedEmail, record.sharedRole);
  const match = sharedUsers.find((u) => u.email === userEmail);
  return match?.role ?? 'read';
}

/** Checks whether the current user can edit the setup.
 * True if Admin, Owner, or shared user with 'edit' role.
 * Guest users can NEVER edit any setup. */
export function canEditSetup(
  record: { sharedEmail?: string; sharedRole?: string; createdByEmail?: string; createdByName?: string },
  user: AuthUser,
): boolean {
  if (user.role === 'guest') return false;
  if (user.role === 'admin') return true;
  if (isOwnedByCurrentUser(record, user)) return true;
  const sharedRole = getSharedRoleForCurrentUser(record, user);
  return sharedRole === 'edit';
}

/** Checks whether the current user can open a Production Setup via direct share link.
 * Allowed when link sharing ('*') is enabled, or user is admin, owner, or explicitly shared. */
export function canViewViaShareLink(
  record: { sharedEmail?: string; sharedRole?: string; createdByEmail?: string; createdByName?: string },
  user: AuthUser,
): boolean {
  if (isLinkSharingEnabled(record.sharedEmail)) return true;
  if (user.role === 'admin') return true;
  if (isOwnedByCurrentUser(record, user)) return true;
  return isSharedWithCurrentUser(record, user);
}

