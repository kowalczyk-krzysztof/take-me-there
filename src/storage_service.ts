// Worker-owned single writer: commands execute one at a time (page-local mutexes
// cannot coordinate two windows), and a failed command never breaks the queue.
import { encryptKeyRecord, vaultStorageKey } from './key_vault';
import { monthKey, readTotals, writeTotals } from './pricing';
import {
  CACHE_ENTRY_VERSION,
  CACHE_INDEX_KEY,
  CACHE_MAX_BYTES,
  CACHE_SLOTS,
  CACHE_TTL_MS,
  cacheKeyFor,
  readCacheIndex,
  unwrapRecord,
  type CacheEntry,
  type CacheRecord,
} from './result_cache';
import { readSettingsStrict, writeSettingsRecord } from './settings_store';
import { addGrantJournal, reconcileTempGrants, releaseGrantJournal } from './grants';
import { runUpdateMigrations } from './migrations';
import {
  COMMAND_SCHEMAS,
  STORAGE_MESSAGE_SCOPE,
  commandPayload,
  isExtensionPageSender,
  type CommandResult,
  type StorageCommand,
  type StorageMessage,
} from './storage_commands';

const invalid = (error: string): CommandResult => ({ ok: false, error });

const isGrantableOrigin = (origin: string): boolean => {
  if (!origin.startsWith('https://')) {
    return false;
  }

  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
};

// The bundled Chrome types omit the documented get(null) whole-area
// form; the cast recovers it.
const getAllSession = async (): Promise<Record<string, unknown>> =>
  (await chrome.storage.session.get(null as unknown as string)) as unknown as Record<
    string,
    unknown
  >;

const spendRecord = async (amountUsd: number, at: number): Promise<number> => {
  if (!Number.isFinite(amountUsd)) {
    throw new Error('invalid spend amount');
  }

  if (!Number.isFinite(at)) {
    throw new Error('invalid spend timestamp');
  }

  const totals = await readTotals();

  const key = monthKey(new Date(at));

  const next = (typeof totals[key] === 'number' ? totals[key] : 0) + amountUsd;
  totals[key] = next;
  await writeTotals(totals);

  return next;
};

const cacheExpired = (record: CacheRecord, ttlMs: number): boolean =>
  Date.now() - record.createdAt > ttlMs;

const readCacheTtlMs = async (): Promise<number> => {
  try {
    return (await readSettingsStrict()).settings.cacheTtlDays * 24 * 60 * 60 * 1000;
  } catch {
    return CACHE_TTL_MS;
  }
};

const cacheGet = async (hash: string): Promise<CacheEntry | undefined> => {
  const name = cacheKeyFor(hash);

  const stored = (await chrome.storage.session.get(name)) as Record<string, unknown>;

  const record = unwrapRecord(stored[name]);

  if (!record) {
    return undefined;
  }

  if (cacheExpired(record, await readCacheTtlMs())) {
    await chrome.storage.session.remove(name);

    return undefined;
  }

  const index = (await readCacheIndex()).filter((key) => key !== hash);
  index.unshift(hash);

  await chrome.storage.session.set({ [CACHE_INDEX_KEY]: index.slice(0, CACHE_SLOTS) });

  return record.entry;
};

const cacheSet = async (hash: string, entry: CacheEntry): Promise<void> => {
  await chrome.storage.session.set({
    [cacheKeyFor(hash)]: { v: CACHE_ENTRY_VERSION, entry, createdAt: Date.now() },
  });

  await enforceCachePolicy(hash);
};

const enforceCachePolicy = async (fresh: string): Promise<void> => {
  const stored = await getAllSession();

  const ttlMs = await readCacheTtlMs();

  const index = (await readCacheIndex()).filter((key) => key !== fresh);
  index.unshift(fresh);

  const survivors: string[] = [];

  let bytes = 0;

  for (const key of index) {
    const name = cacheKeyFor(key);

    const record = unwrapRecord(stored[name]);

    if (!record || cacheExpired(record, ttlMs)) {
      if (name in stored) {
        await chrome.storage.session.remove(name);
      }

      continue;
    }

    bytes += JSON.stringify(stored[name])?.length ?? 0;

    if (survivors.length >= CACHE_SLOTS || bytes > CACHE_MAX_BYTES) {
      await chrome.storage.session.remove(name);

      continue;
    }

    survivors.push(key);
  }

  const known = new Set(survivors.map((key) => cacheKeyFor(key)));

  for (const name of Object.keys(stored)) {
    if (name.startsWith('cache:') && !known.has(name)) {
      await chrome.storage.session.remove(name);
    }
  }

  await chrome.storage.session.set({ [CACHE_INDEX_KEY]: survivors });
};

const cacheClear = async (): Promise<number> => {
  const stored = await getAllSession();

  const names = Object.keys(stored).filter((key) => key.startsWith('cache:'));

  await chrome.storage.session.remove([...names, CACHE_INDEX_KEY]);

  return names.length;
};

interface KeyPlacement {
  sessionHas: boolean;
  localHas: boolean;
}

const readPlacement = async (name: string): Promise<KeyPlacement> => {
  const fromSession = (await chrome.storage.session.get(name)) as Record<string, unknown>;

  const fromLocal = (await chrome.storage.local.get(name)) as Record<string, unknown>;

  return { sessionHas: fromSession[name] !== undefined, localHas: fromLocal[name] !== undefined };
};

const placementSatisfies = (
  placement: KeyPlacement,
  hasRecord: boolean,
  sessionOnly: boolean
): boolean => {
  if (!hasRecord) {
    return true;
  }

  return sessionOnly
    ? placement.sessionHas && !placement.localHas
    : placement.localHas && !placement.sessionHas;
};

// Move the ciphertext, verify the placement, then remove the old side; ciphertext is never deleted to satisfy a move.
const setKeyMode = async (providerId: string, sessionOnly: boolean): Promise<CommandResult> => {
  if (!providerId) {
    return invalid('unknown provider');
  }

  const name = vaultStorageKey(providerId);

  try {
    const fromSession = (await chrome.storage.session.get(name)) as Record<string, unknown>;

    const fromLocal = (await chrome.storage.local.get(name)) as Record<string, unknown>;

    const record = fromSession[name] ?? fromLocal[name];

    if (record !== undefined) {
      const target = sessionOnly ? chrome.storage.session : chrome.storage.local;

      const other = sessionOnly ? chrome.storage.local : chrome.storage.session;

      await target.set({ [name]: record });

      const placed = (await target.get(name)) as Record<string, unknown>;

      if (placed[name] === undefined) {
        throw new Error('key move failed verification');
      }

      await other.remove(name);

      const cleared = (await other.get(name)) as Record<string, unknown>;

      if (cleared[name] !== undefined) {
        throw new Error('key move failed verification');
      }
    }

    const current = (await readSettingsStrict()).settings;

    await writeSettingsRecord({ ...current, sessionOnly });

    const verified = (await readSettingsStrict()).settings;

    if (verified.sessionOnly !== sessionOnly) {
      throw new Error('settings write failed verification');
    }

    const placement = await readPlacement(name);

    const hasRecord = placement.sessionHas || placement.localHas;

    if (!placementSatisfies(placement, hasRecord, sessionOnly)) {
      throw new Error('key move failed verification');
    }

    return { ok: true, value: { sessionOnly } };
  } catch (err) {
    let actual = false;

    try {
      const placement = await readPlacement(name);

      const hasRecord = placement.sessionHas || placement.localHas;

      const settings = (await readSettingsStrict()).settings;

      actual = settings.sessionOnly === true && placementSatisfies(placement, hasRecord, true);
    } catch {
      actual = false;
    }

    const message = err instanceof Error ? err.message : 'key mode change failed';

    return { ok: false, error: message, value: { sessionOnly: actual } };
  }
};

const execute = async (command: StorageCommand): Promise<CommandResult> => {
  switch (command.kind) {
    case 'spend.record':
      return { ok: true, value: await spendRecord(command.amountUsd, command.at) };

    case 'cache.get':
      return { ok: true, value: (await cacheGet(command.hash)) ?? undefined };

    case 'cache.set':
      await cacheSet(command.hash, command.entry);

      return { ok: true, value: undefined };

    case 'cache.clear':
      return { ok: true, value: await cacheClear() };

    case 'settings.patch': {
      const ttl = command.patch.cacheTtlDays;

      if (ttl !== undefined && ttl !== 1 && ttl !== 7 && ttl !== 30) {
        return invalid('invalid retention');
      }

      const current = (await readSettingsStrict()).settings;

      await writeSettingsRecord({ ...current, ...command.patch });

      return { ok: true, value: undefined };
    }

    case 'key.persist': {
      if (!command.providerId) {
        return invalid('unknown provider');
      }

      if (!command.key) {
        return invalid('cannot save an empty key');
      }

      const current = (await readSettingsStrict()).settings;

      const record = await encryptKeyRecord(command.key);

      const name = vaultStorageKey(command.providerId);

      if (command.sessionOnly) {
        await chrome.storage.session.set({ [name]: record });
        await chrome.storage.local.remove(name);
      } else {
        await chrome.storage.local.set({ [name]: record });
        await chrome.storage.session.remove(name);
      }

      const placement = await readPlacement(name);

      if (
        !placementSatisfies(
          placement,
          placement.sessionHas || placement.localHas,
          command.sessionOnly
        )
      ) {
        return invalid('key save failed verification');
      }

      const next = { ...current, sessionOnly: command.sessionOnly };

      await writeSettingsRecord(next);

      const verified = (await readSettingsStrict()).settings;

      if (verified.sessionOnly !== command.sessionOnly) {
        return invalid('key save failed verification');
      }

      return { ok: true, value: next };
    }

    case 'key.clear': {
      if (!command.providerId) {
        return invalid('unknown provider');
      }

      const name = vaultStorageKey(command.providerId);
      await chrome.storage.session.remove(name);
      await chrome.storage.local.remove(name);

      return { ok: true, value: undefined };
    }

    case 'key.setMode':
      return setKeyMode(command.providerId, command.sessionOnly);

    case 'grant.add': {
      if (!isGrantableOrigin(command.origin)) {
        return invalid('invalid origin');
      }

      await addGrantJournal(command.origin);

      return { ok: true, value: undefined };
    }

    case 'grant.release': {
      if (!isGrantableOrigin(command.origin)) {
        return invalid('invalid origin');
      }

      await releaseGrantJournal(command.origin);
      await reconcileTempGrants();

      return { ok: true, value: undefined };
    }

    case 'migrate.run':
      return { ok: true, value: await runUpdateMigrations() };

    default:
      return invalid('unknown command');
  }
};

let queueTail: Promise<void> = Promise.resolve();

const enqueue = (command: StorageCommand): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve) => {
    queueTail = queueTail.then(async () => {
      try {
        resolve(await execute(command));
      } catch (err) {
        resolve(invalid(err instanceof Error ? err.message : 'command failed'));
      }
    });
  });

// Same queue, so a page command can never interleave mid-migration.
export const enqueueLocalCommand = (command: StorageCommand): Promise<CommandResult> =>
  enqueue(command);

// Returns undefined for foreign messages so other listeners can claim them.
export const handleStorageMessage = async (
  message: unknown,
  sender: chrome.runtime.MessageSender
): Promise<CommandResult | undefined> => {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const envelope = message as Partial<StorageMessage>;

  if (envelope.scope !== STORAGE_MESSAGE_SCOPE || !envelope.command) {
    return undefined;
  }

  if (!isExtensionPageSender(sender)) {
    return invalid('rejected sender');
  }

  const command = envelope.command as Partial<StorageCommand>;

  const schema = command.kind !== undefined ? COMMAND_SCHEMAS[command.kind] : undefined;

  if (!schema) {
    return invalid('unknown command');
  }

  const parsed = schema.safeParse(commandPayload(envelope.command));

  if (!parsed.success) {
    return invalid('invalid payload');
  }

  return enqueue({ ...envelope.command, ...(parsed.data as object) } as StorageCommand);
};
