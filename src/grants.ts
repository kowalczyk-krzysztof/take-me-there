// Temporary versus durable host permissions. Image byte-fetching borrows a
// per-origin grant for seconds; the configured custom provider owns its
// origin durably. Temp grants ledger in session storage so a worker
// restart can reconcile abandoned ones; durable origins derive from the
// saved settings and are never revoked by temp handling.
import { loadSettings } from './settings_store';

export const TEMP_GRANT_KEY = 'tempGrants';

// A byte fetch never holds a grant this long: older ledger entries belong
// to dead panels.
export const TEMP_GRANT_TTL_MS = 10 * 60 * 1000;

type TempLedger = Record<string, number>;

const readLedger = async (): Promise<TempLedger> => {
  try {
    const stored = (await chrome.storage.session.get(TEMP_GRANT_KEY)) as Record<string, unknown>;

    const value = stored[TEMP_GRANT_KEY];

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const ledger: TempLedger = {};

    for (const [origin, at] of Object.entries(value as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) {
        ledger[origin] = at;
      }
    }

    return ledger;
  } catch {
    return {};
  }
};

const writeLedger = async (ledger: TempLedger): Promise<void> => {
  try {
    await chrome.storage.session.set({ [TEMP_GRANT_KEY]: ledger });
  } catch {
    // Best effort: a lost ledger entry leaks at most one grant, which the
    // next startup reconcile still cannot see. The finally below revokes
    // directly, so the common path stays clean.
  }
};

// Origins the extension owns durably: the configured custom provider.
// Empty when settings are unreadable, which only ever skips revocation.
export const getDurableOrigins = async (): Promise<Set<string>> => {
  const origins = new Set<string>();

  try {
    const settings = await loadSettings();

    if (settings.activeProviderId === 'openai_compat' && settings.openaiCompat.baseURL) {
      try {
        origins.add(new URL(settings.openaiCompat.baseURL).origin);
      } catch {
        // Saved URLs were validated at save time; ignore garbage.
      }
    }
  } catch {
    // Settings unreadable: revoke nothing.
  }

  return origins;
};

const containsGrant = async (origin: string): Promise<boolean> => {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
};

export const removeGrant = async (origin: string): Promise<void> => {
  try {
    await chrome.permissions.remove({ origins: [`${origin}/*`] });
  } catch {
    // The grant is already gone; nothing to clean up.
  }
};

// One origin grant with guaranteed cleanup. Loopback http skips the grant
// entirely: the fetch goes direct instead. Pre-existing grants (durable
// provider origins, user approvals) are used but never revoked; only a
// grant this call created is removed after the task.
export const withTempGrant = async <T>(
  origin: string,
  loopback: boolean,
  task: () => Promise<T>
): Promise<{ granted: boolean; result?: T }> => {
  if (loopback) {
    return { granted: true, result: await task() };
  }

  if (await containsGrant(origin)) {
    return { granted: true, result: await task() };
  }

  let granted = false;

  try {
    granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    granted = false;
  }

  if (!granted) {
    return { granted: false };
  }

  const ledger = await readLedger();
  ledger[origin] = Date.now();
  await writeLedger(ledger);

  try {
    return { granted: true, result: await task() };
  } finally {
    const next = await readLedger();
    delete next[origin];
    await writeLedger(next);

    // Re-check at release: the origin may have become a configured
    // provider while the fetch ran, and durable grants are never revoked.
    const durable = await getDurableOrigins();

    if (!durable.has(origin)) {
      await removeGrant(origin);
    }
  }
};

// Worker startup sweep: revoke abandoned temp grants. Fresh entries may
// belong to a live panel and are left alone; durable origins are
// unledgered but never revoked.
export const reconcileTempGrants = async (now: number = Date.now()): Promise<void> => {
  const ledger = await readLedger();

  const stale = Object.entries(ledger).filter(([, at]) => now - at > TEMP_GRANT_TTL_MS);

  if (stale.length === 0) {
    return;
  }

  const durable = await getDurableOrigins();

  const next: TempLedger = { ...ledger };

  for (const [origin] of stale) {
    delete next[origin];

    if (!durable.has(origin)) {
      await removeGrant(origin);
    }
  }

  await writeLedger(next);
};
