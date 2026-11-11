import { getContext } from '@microsoft/power-apps/app';

const SETUP_ID_PARAM = 'setupId';

// Matches `appId` and `environmentId` in power.config.json for fallback play URL construction
// when `context.app.appUrl` is unavailable inside an embedded Power Apps frame.
const FALLBACK_APP_ID = '0ee23515-9c40-4e3c-b3ad-7e1c92c1f885';
const FALLBACK_ENV_ID = 'aacac48e-e4d6-ed6c-baf2-cb1f68edc68a';

interface PowerAppsContextLike {
  app?: {
    appId?: string;
    environmentId?: string;
    appUrl?: string;
    queryParams?: Record<string, string>;
  };
}

let cachedContextPromise: Promise<PowerAppsContextLike | null> | null = null;

/** Checks whether the app is running inside an iframe (such as Power Apps Player). */
export function isRunningInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** Reads `setupId` case-insensitively from `window.location.search`. */
export function readSharedSetupIdFromWindowLocation(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of params.entries()) {
      if (key.toLowerCase() === SETUP_ID_PARAM.toLowerCase()) {
        const trimmed = value.trim();
        return trimmed || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readSetupIdFromParamsRecord(params?: Record<string, string>): string | null {
  if (!params || typeof params !== 'object') return null;
  for (const [key, value] of Object.entries(params)) {
    if (key.toLowerCase() === SETUP_ID_PARAM.toLowerCase() && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/** Resolves the Power Apps SDK context with a short timeout so standalone local runs never hang. */
export function resolvePowerAppsContext(): Promise<PowerAppsContextLike | null> {
  if (!cachedContextPromise) {
    const timeoutMs = isRunningInIframe() ? 1500 : 400;
    cachedContextPromise = Promise.race<PowerAppsContextLike | null>([
      Promise.resolve(getContext())
        .then((ctx) => ctx as PowerAppsContextLike)
        .catch(() => null),
      new Promise<null>((resolve) => {
        window.setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  }
  return cachedContextPromise;
}

/** Reads `setupId` from either `window.location.search` or Power Apps host `queryParams`. */
export async function readSharedSetupIdFromUrl(): Promise<string | null> {
  const fromWindow = readSharedSetupIdFromWindowLocation();
  if (fromWindow) return fromWindow;

  const ctx = await resolvePowerAppsContext();
  return readSetupIdFromParamsRecord(ctx?.app?.queryParams);
}

function setSetupIdOnUrl(rawUrl: string, setupId: string, clearOtherParams = false): string {
  const url = new URL(rawUrl);
  if (clearOtherParams) {
    url.search = '';
  } else {
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase() === SETUP_ID_PARAM.toLowerCase()) {
        url.searchParams.delete(key);
      }
    }
  }
  url.searchParams.set(SETUP_ID_PARAM, setupId);
  return url.toString();
}

function buildPlayUrl(envId: string, appId: string, setupId: string): string {
  const url = new URL(
    `https://apps.powerapps.com/play/e/${encodeURIComponent(envId)}/app/${encodeURIComponent(appId)}`,
  );
  url.searchParams.set(SETUP_ID_PARAM, setupId);
  return url.toString();
}

/** Synchronous best-effort share URL while Power Apps host context finishes resolving. */
export function getFallbackSetupShareUrl(setupId: string): string {
  if (isRunningInIframe()) {
    return buildPlayUrl(FALLBACK_ENV_ID, FALLBACK_APP_ID, setupId);
  }
  return setSetupIdOnUrl(window.location.href, setupId, true);
}

/** Builds a shareable URL that opens the specified Production Setup directly. */
export async function buildSetupShareUrl(setupId: string): Promise<string> {
  const ctx = await resolvePowerAppsContext();
  const appUrl = ctx?.app?.appUrl?.trim();
  if (appUrl) {
    try {
      return setSetupIdOnUrl(appUrl, setupId);
    } catch {
      // Fall through to structured URL builders if `appUrl` is not a full URL.
    }
  }

  const ctxAppId = ctx?.app?.appId?.trim();
  const ctxEnvId = ctx?.app?.environmentId?.trim();
  if ((ctxAppId && ctxEnvId) || isRunningInIframe()) {
    return buildPlayUrl(ctxEnvId || FALLBACK_ENV_ID, ctxAppId || FALLBACK_APP_ID, setupId);
  }

  return setSetupIdOnUrl(window.location.href, setupId, true);
}
