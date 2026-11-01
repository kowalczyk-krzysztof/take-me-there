// Temp grants ledger in session storage so a restart can reconcile abandoned ones.
import { createMutex, type Mutex } from './utils/mutex';

export const TEMP_GRANT_KEY = 'tempGrants';

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
    // Best effort: the finally below still revokes directly.
  }
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

// Concurrent borrowers for one origin queue instead of racing, so the first finisher cannot revoke from under a live task.
const originMutexes = new Map<string, Mutex>();

const mutexForOrigin = (origin: string): Mutex => {
  const existing = originMutexes.get(origin);

  if (existing) {
    return existing;
  }

  const fresh = createMutex();
  originMutexes.set(origin, fresh);

  return fresh;
};

// Pre-existing approvals are used but never revoked; only created grants are removed.
export const withTempGrant = async <T>(
  origin: string,
  loopback: boolean,
  task: () => Promise<T>
): Promise<{ granted: boolean; result?: T }> => {
  if (loopback) {
    return { granted: true, result: await task() };
  }

  return mutexForOrigin(origin)(async () => {
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

      await removeGrant(origin);
    }
  });
};

// Fresh entries may belong to a live panel and are left alone.
export const reconcileTempGrants = async (now: number = Date.now()): Promise<void> => {
  const ledger = await readLedger();

  const stale = Object.entries(ledger).filter(([, at]) => now - at > TEMP_GRANT_TTL_MS);

  if (stale.length === 0) {
    return;
  }

  const next: TempLedger = { ...ledger };

  for (const [origin] of stale) {
    delete next[origin];
    await removeGrant(origin);
  }

  await writeLedger(next);
};
