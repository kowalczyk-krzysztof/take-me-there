// Temporary host grants with a persistent, worker-owned journal. The panel
// requests access from a user gesture and journals it immediately; the
// worker serializes borrowers, revokes at zero, and sweeps strays.
import { sendCommand } from './storage_client';

export const TEMP_GRANT_KEY = 'tempGrants';

export const TEMP_GRANT_TTL_MS = 10 * 60 * 1000;

export interface GrantEntry {
  count: number;
  at: number;
}

type TempLedger = Record<string, GrantEntry>;

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
// can release instead of leaking an unjournaled grant.
export const addGrantJournal = async (origin: string): Promise<void> => {
  const ledger = await readLedger();

  const existing = ledger[origin];

  ledger[origin] = { count: (existing?.count ?? 0) + 1, at: existing?.at ?? Date.now() };

  await writeLedger(ledger);
};

// Worker side: release a borrower, revoking at zero only after verification.
// Failed revocations keep a zero-count entry for later reconciliation.
export const releaseGrantJournal = async (origin: string): Promise<void> => {
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
};

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

// Never throws: cleanup must not break the run that triggered it. Fresh
// entries may belong to a live panel and are left alone; anything held but
// unjournaled is a leak, since this extension keeps no standing grants.
export const reconcileTempGrants = async (now: number = Date.now()): Promise<void> => {
  try {
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

    for (const pattern of held) {
      const origin = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;

      if (!ledger[origin]) {
        await removeGrantVerified(origin);
      }
    }
  } catch {
    // Storage is down; the next reconcile retries.
  }
};

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

// Panel side: journal a freshly requested grant in the worker.
export const addHostGrant = async (origin: string): Promise<void> => {
  await sendCommand<void>({ kind: 'grant.add', origin });
};

// Panel side: release a borrower; the worker retains failures for reconcile.
export const releaseHostAccess = async (origin: string): Promise<void> => {
  await sendCommand<void>({ kind: 'grant.release', origin });
};
