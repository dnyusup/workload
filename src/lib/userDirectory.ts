import { Office365UsersService } from '../generated/services/Office365UsersService';

/** email (lowercased) → resolved display name — module-level so every page that lists
 * Layouts/Production Setups shares one cache instead of re-querying Graph for the same person. */
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

/** `createdbyname` on WL_Layouts/WL_ProductionSetups comes back blank for records created through
 * this Code App's Dataverse connection (the connection's own identity has no resolvable name), even
 * though `mpp_creator_email` is stamped correctly — so the display name has to be looked up
 * separately via the Office365Users connector's people search, keyed by that email. */
async function fetchDisplayName(email: string): Promise<string> {
  try {
    const result = await Office365UsersService.SearchUser(email, 5);
    const match = (result.success ? result.data ?? [] : []).find(
      (person) => (person.Mail ?? person.UserPrincipalName ?? '').trim().toLowerCase() === email,
    );
    return match?.DisplayName?.trim() || email;
  } catch {
    return email;
  }
}

export async function resolveDisplayName(email: string | undefined): Promise<string> {
  const key = (email ?? '').trim().toLowerCase();
  if (!key) return '';
  if (cache.has(key)) return cache.get(key)!;
  let promise = inFlight.get(key);
  if (!promise) {
    promise = fetchDisplayName(key).then((name) => {
      cache.set(key, name);
      inFlight.delete(key);
      return name;
    });
    inFlight.set(key, promise);
  }
  return promise;
}

/** Resolves every distinct email in one batch (in parallel, deduped) — for a list page's
 * "By {creator}" line, called once per load rather than once per row. */
export async function resolveDisplayNames(emails: (string | undefined)[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(emails.map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean)));
  const out = new Map<string, string>();
  await Promise.all(
    unique.map(async (email) => {
      out.set(email, await resolveDisplayName(email));
    }),
  );
  return out;
}
