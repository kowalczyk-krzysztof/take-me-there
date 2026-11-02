// Temporary host grants with a persistent, worker-owned journal.
import { sendCommand } from './storage_client';
import { createMutex } from './utils/mutex';

export const TEMP_GRANT_KEY = 'tempGrants';

export const TEMP_GRANT_TTL_MS = 10 * 60 * 1000;

export const GRANT_RETRY_ALARM = 'take-me-there-grant-reconcile';

export const GRANT_RETRY_DELAY_MS = 60 * 1000;

// Newly observed unjournaled origins wait out this quarantine before the
// sweep may revoke them: an in-flight acquisition journals within seconds,
// while a genuine leak is still cleaned shortly after.
export const GRANT_QUARANTINE_MS = 60 * 1000;

export const QUARANTINE_KEY = 'tempGrantQuarantine';

export interface GrantEntry {
  count: number;
  at: number;
}

type TempLedger = Record<string, GrantEntry>;

// One writer: every journal mutation and reconciliation serializes here so
// a read-modify-write can never interleave with another and drop a live borrower.
const journalMutex = createMutex();

// Retry eligibility per held-but-unjournaled origin. Persisted: workers die
// after 30 idle seconds, so memory alone would restart every quarantine.
type QuarantineMap = Record<string, number>;

const readQuarantine = async (): Promise<QuarantineMap> => {
  const stored = (await chrome.storage.local.get(QUARANTINE_KEY)) as Record<string, unknown>;

  const value = stored[QUARANTINE_KEY];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const quarantined: QuarantineMap = {};

  for (const [origin, eligibleAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof eligibleAt === 'number' && Number.isFinite(eligibleAt)) {
      quarantined[origin] = eligibleAt;
    }
  }

  return quarantined;
};

const writeQuarantine = async (quarantined: QuarantineMap): Promise<void> => {
  await chrome.storage.local.set({ [QUARANTINE_KEY]: quarantined });
};

// Standing manifest hosts are required access, never temporary grants.
const standingOrigins = (): Set<string> => {
  try {
    const manifest = (
      chrome as unknown as { runtime?: { getManifest?: () => unknown } }
    ).runtime?.getManifest?.() as { host_permissions?: unknown } | undefined;

    const hosts = manifest?.host_permissions;

    if (Array.isArray(hosts)) {
      const origins = hosts
        .filter((entry): entry is string => typeof entry === 'string')
        .map((pattern) => (pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern));

      if (origins.length > 0) {
        return new Set(origins);
      }
    }
  } catch {
    // Fall through to the known API host below.
  }

  return new Set(['https://api.meta.ai']);
};

const readLedger = async (): Promise<TempLedger> => {
  const stored = (await chrome.storage.local.get(TEMP_GRANT_KEY)) as Record<string, unknown>;

  const value = stored[TEMP_GRANT_KEY];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const ledger: TempLedger = {};

  for (const [origin, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const { count, at } = entry as { count?: unknown; at?: unknown };

    if (
      typeof count === 'number' &&
      Number.isFinite(count) &&
      typeof at === 'number' &&
      Number.isFinite(at)
    ) {
      ledger[origin] = { count, at };
    }
  }

  return ledger;
};

const writeLedger = async (ledger: TempLedger): Promise<void> => {
  await chrome.storage.local.set({ [TEMP_GRANT_KEY]: ledger });
};

const scheduleGrantRetry = (delayMs: number): void => {
  try {
    const alarms = (globalThis as { chrome?: unknown }).chrome as
      { alarms?: { create: (name: string, info: { when: number }) => void } } | undefined;

    alarms?.alarms?.create(GRANT_RETRY_ALARM, { when: Date.now() + Math.max(0, delayMs) });
  } catch {
    // No alarm surface (or a transient failure): the next worker pass retries.
  }
};

const clearGrantRetry = (): void => {
  try {
    const alarms = (globalThis as { chrome?: unknown }).chrome as
      { alarms?: { clear: (name: string) => void } } | undefined;

    alarms?.alarms?.clear(GRANT_RETRY_ALARM);
  } catch {
    // A stray alarm firing later is a harmless no-op reconcile.
  }
};

// True when no grant remains; unverifiable means retained, never assumed gone.
export const removeGrantVerified = async (origin: string): Promise<boolean> => {
  try {
    await chrome.permissions.remove({ origins: [`${origin}/*`] });
  } catch {
    // Removal is best effort; verification below decides.
  }

  try {
    return !(await chrome.permissions.contains({ origins: [`${origin}/*`] }));
  } catch {
    return false;
  }
};

// Worker side: journal a borrower. Throws on storage failure so the caller
// can release instead of leaking an unjournaled grant. A successful
// reservation establishes its own expiry wakeup, so an abandoned panel can
// never leave a lease without a scheduled cleanup.
export const addGrantJournal = (origin: string): Promise<void> =>
  journalMutex(async () => {
    const ledger = await readLedger();

    const existing = ledger[origin];

    ledger[origin] = { count: (existing?.count ?? 0) + 1, at: existing?.at ?? Date.now() };

    await writeLedger(ledger);
    await updateGrantAlarm(Date.now());
  });

// Worker side: cancel a speculative journal entry for a permission that was
// never granted (a denied prompt). No revocation: there is nothing to revoke.
export const cancelGrantJournal = (origin: string): Promise<void> =>
  journalMutex(async () => {
    const ledger = await readLedger();

    const existing = ledger[origin];

    if (!existing) {
      return;
    }

    const count = existing.count - 1;

    if (count > 0) {
      ledger[origin] = { count, at: existing.at };
    } else {
      delete ledger[origin];
    }

    await writeLedger(ledger);
  });

// Worker side: release a borrower, revoking at zero only after verification.
// Failed revocations keep a zero-count entry for later reconciliation.
export const releaseGrantJournal = (origin: string): Promise<void> =>
  journalMutex(async () => {
    const ledger = await readLedger();

    const existing = ledger[origin];

    if (!existing) {
      await removeGrantVerified(origin);

      return;
    }

    const count = existing.count - 1;

    if (count > 0) {
      ledger[origin] = { count, at: existing.at };

      await writeLedger(ledger);

      return;
    }

    if (await removeGrantVerified(origin)) {
      delete ledger[origin];
    } else {
      ledger[origin] = { count: 0, at: Date.now() };
    }

    await writeLedger(ledger);
  });

const mergeLegacySessionLedger = async (): Promise<void> => {
  let legacy: Record<string, unknown>;

  try {
    const stored = (await chrome.storage.session.get(TEMP_GRANT_KEY)) as Record<string, unknown>;

    const value = stored[TEMP_GRANT_KEY];

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }

    legacy = value as Record<string, unknown>;
  } catch {
    return;
  }

  try {
    const ledger = await readLedger();

    for (const [origin, at] of Object.entries(legacy)) {
      if (typeof at === 'number' && Number.isFinite(at) && !ledger[origin]) {
        ledger[origin] = { count: 1, at };
      }
    }

    await writeLedger(ledger);
    await chrome.storage.session.remove(TEMP_GRANT_KEY);
  } catch {
    // The session copy stays for the next pass.
  }
};

// Never throws. Clears the alarm only when no journal entry or quarantined origin remains.
const updateGrantAlarm = async (now: number): Promise<void> => {
  let delay: number | null = null;

  try {
    const ledger = await readLedger();

    for (const entry of Object.values(ledger)) {
      const candidate =
        entry.count > 0 ? Math.max(0, entry.at + TEMP_GRANT_TTL_MS - now) : GRANT_RETRY_DELAY_MS;

      delay = delay === null ? candidate : Math.min(delay, candidate);
    }
  } catch {
    scheduleGrantRetry(GRANT_RETRY_DELAY_MS);

    return;
  }

  let quarantined: QuarantineMap;

  try {
    quarantined = await readQuarantine();
  } catch {
    scheduleGrantRetry(GRANT_RETRY_DELAY_MS);

    return;
  }

  for (const eligibleAt of Object.values(quarantined)) {
    const candidate = Math.max(0, eligibleAt - now);

    delay = delay === null ? candidate : Math.min(delay, candidate);
  }

  if (delay === null) {
    clearGrantRetry();

    return;
  }

  scheduleGrantRetry(delay);
};

const reconcileInner = async (now: number): Promise<void> => {
  await mergeLegacySessionLedger();

  const ledger = await readLedger();

  for (const [origin, entry] of Object.entries(ledger)) {
    if (entry.count > 0 && now - entry.at <= TEMP_GRANT_TTL_MS) {
      continue;
    }

    if (await removeGrantVerified(origin)) {
      delete ledger[origin];
    } else {
      ledger[origin] = { count: 0, at: entry.at };
    }
  }

  await writeLedger(ledger);

  let held: string[] = [];

  try {
    const all = await chrome.permissions.getAll();

    held = (all.origins ?? []).filter((pattern) => pattern.startsWith('https://'));
  } catch {
    return;
  }

  const quarantined = await readQuarantine();
  const standing = standingOrigins();
  const heldOrigins = new Set<string>();

  for (const pattern of held) {
    const origin = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
    heldOrigins.add(origin);

    if (standing.has(origin)) {
      delete quarantined[origin];

      continue;
    }

    if (ledger[origin]) {
      delete quarantined[origin];

      continue;
    }

    const eligibleAt = quarantined[origin];

    if (eligibleAt === undefined) {
      quarantined[origin] = now + GRANT_QUARANTINE_MS;

      continue;
    }

    if (now < eligibleAt) {
      continue;
    }

    if (await removeGrantVerified(origin)) {
      delete quarantined[origin];
    } else {
      quarantined[origin] = now + GRANT_RETRY_DELAY_MS;
    }
  }

  for (const origin of Object.keys(quarantined)) {
    if (!heldOrigins.has(origin)) {
      delete quarantined[origin];
    }
  }

  await writeQuarantine(quarantined);
};

// Never throws: cleanup must not break the run that triggered it. Fresh
// entries may belong to a live panel; anything held but unjournaled past
// quarantine is a leak, since this extension keeps no standing grants.
export const reconcileTempGrants = (now: number = Date.now()): Promise<void> =>
  journalMutex(async () => {
    try {
      await reconcileInner(now);
    } catch {
      // Storage is down; the alarm retries.
      scheduleGrantRetry(GRANT_RETRY_DELAY_MS);

      return;
    }

    await updateGrantAlarm(now);
  });

export type HostAccessDecision = 'granted' | 'denied' | 'error';

// Panel side: call with no preceding awaits from the click handler so the
// browser prompt carries a fresh user gesture.
export const requestHostAccess = async (origin: string): Promise<HostAccessDecision> => {
  try {
    return (await chrome.permissions.request({ origins: [`${origin}/*`] })) ? 'granted' : 'denied';
  } catch {
    return 'error';
  }
};

export const addHostGrant = async (origin: string): Promise<void> => {
  await sendCommand<void>({ kind: 'grant.add', origin });
};

// Panel side: release a borrower; the worker retains failures for reconcile.
export const releaseHostAccess = async (origin: string): Promise<void> => {
  await sendCommand<void>({ kind: 'grant.release', origin });
};

export const cancelHostGrant = async (origin: string): Promise<void> => {
  await sendCommand<void>({ kind: 'grant.cancel', origin });
};
