import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('idb-keyval', () => {
  const stores = new Map<string, Map<unknown, unknown>>();

  const area = (id: string): Map<unknown, unknown> => {
    let found = stores.get(id);

    if (!found) {
      found = new Map();
      stores.set(id, found);
    }

    return found;
  };

  return {
    createStore: (db: string, name: string): string => `${db}:${name}`,
    get: async (key: unknown, store: string): Promise<unknown> => area(store).get(key),
    set: async (key: unknown, value: unknown, store: string): Promise<void> => {
      area(store).set(key, value);
    },
    del: async (key: unknown, store: string): Promise<void> => {
      area(store).delete(key);
    },
    __reset: (): void => {
      stores.clear();
    },
    __size: (store: string): number => area(store).size,
  };
});

import * as idbKeyval from 'idb-keyval';
import { listPins, pinPlace } from './board_store';
import { clearAllKeys, loadKey, saveKey, setKeyMode } from './key_vault';
import { readMonthSpend, recordMonthSpend, resetMonthSpend } from './pricing';
import { clearCacheEntries, getCacheEntry, setCacheEntry, type CacheEntry } from './result_cache';
import { loadSettings } from './settings_store';
import { enqueueLocalCommand, handleStorageMessage } from './storage_service';
import { STORAGE_MESSAGE_SCOPE } from './storage_commands';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';
import { routeWorkerMessages } from './test/helpers';
import type { PlaceResult } from './types';

const resetIdb = (): void => {
  (idbKeyval as unknown as { __reset: () => void }).__reset();
};

const idbSize = (store: string): number =>
  (idbKeyval as unknown as { __size: (store: string) => number }).__size(store);

const PAGE_SENDER = { id: 'test', url: 'chrome-extension://test/sidepanel.html' };

const place = (name: string, country = 'Greece'): PlaceResult => ({
  identified: true,
  placeName: name,
  city: name,
  country,
  confidence: 0.9,
  oneLiner: `${name} overlooks the sea.`,
});

const entry = (name: string): CacheEntry => ({
  place: place(name),
  sources: [],
  usage: { inputTokens: 10, outputTokens: 5, searchCount: 0, flatFeesUsd: 0 },
});

let mock: ChromeMock;

beforeEach(() => {
  resetIdb();
  mock = installChromeMock();
  routeWorkerMessages(mock);
});

afterEach(() => {
  uninstallChromeMock();
});

describe('storage service protocol', () => {
  it('ignores foreign messages and rejects unknown senders', async () => {
    await expect(handleStorageMessage({ scope: 'other' }, PAGE_SENDER)).resolves.toBeUndefined();

    await expect(
      handleStorageMessage(
        { scope: STORAGE_MESSAGE_SCOPE, command: { kind: 'board.clear' } },
        {
          id: 'test',
          url: 'https://evil.example.com/',
        }
      )
    ).resolves.toEqual({ ok: false, error: 'rejected sender' });

    await expect(
      handleStorageMessage(
        { scope: STORAGE_MESSAGE_SCOPE, command: { kind: 'board.clear' } },
        {
          id: 'someone-else',
          url: 'chrome-extension://test/sidepanel.html',
        }
      )
    ).resolves.toEqual({ ok: false, error: 'rejected sender' });
  });

  it('rejects unknown commands and invalid payloads without poisoning the queue', async () => {
    await expect(
      handleStorageMessage(
        { scope: STORAGE_MESSAGE_SCOPE, command: { kind: 'board.explode' } },
        PAGE_SENDER
      )
    ).resolves.toEqual({ ok: false, error: 'unknown command' });

    await expect(
      handleStorageMessage(
        { scope: STORAGE_MESSAGE_SCOPE, command: { kind: 'board.add', pin: { nope: true } } },
        PAGE_SENDER
      )
    ).resolves.toEqual({ ok: false, error: 'invalid payload' });

    await expect(
      handleStorageMessage(
        { scope: STORAGE_MESSAGE_SCOPE, command: { kind: 'spend.record', amountUsd: NaN, at: 1 } },
        PAGE_SENDER
      )
    ).resolves.toEqual({ ok: false, error: 'invalid payload' });

    // The handler layer re-checks for in-worker callers that skip schemas.
    await expect(
      enqueueLocalCommand({ kind: 'spend.record', amountUsd: NaN, at: 1 })
    ).resolves.toEqual({ ok: false, error: 'invalid spend amount' });

    // The queue still serves after rejections.
    await pinPlace({ place: place('Oia'), sourceHost: 'example.com' });
    expect((await listPins()).map((pin) => pin.place.placeName)).toEqual(['Oia']);
  });
});

describe('storage service concurrency', () => {
  it('keeps every pin when two panels add concurrently', async () => {
    const [a, b] = await Promise.all([
      pinPlace({ place: place('Oia'), sourceHost: 'a.example.com' }),
      pinPlace({ place: place('Fira'), sourceHost: 'b.example.com' }),
    ]);

    expect(a.status).toBe('pinned');
    expect(b.status).toBe('pinned');
    expect((await listPins()).map((pin) => pin.place.placeName).sort()).toEqual(['Fira', 'Oia']);
  });

  it('sums concurrent spend records without lost updates', async () => {
    const date = new Date('2026-03-15T12:00:00Z');

    await Promise.all(Array.from({ length: 20 }, () => recordMonthSpend(1, date)));

    expect(await readMonthSpend(date)).toBe(20);
  });

  it('serializes an increment racing a reset to a valid outcome', async () => {
    const date = new Date('2026-03-15T12:00:00Z');

    await Promise.all([recordMonthSpend(5, date), resetMonthSpend(date)]);

    expect([0, 5]).toContain(await readMonthSpend(date));
  });

  it('converges when a migration races a write', async () => {
    await mock.local.set({
      tripBoard: [{ place: place('Oia'), sourceHost: 'example.com', addedAt: 1 }],
    });

    const [migration, added] = await Promise.all([
      handleStorageMessage(
        { scope: STORAGE_MESSAGE_SCOPE, command: { kind: 'migrate.run' } },
        PAGE_SENDER
      ),
      pinPlace({ place: place('Fira'), sourceHost: 'example.com' }),
    ]);

    expect(migration?.ok).toBe(true);
    expect(added.status).toBe('pinned');

    const stored = mock.local.data.get('tripBoard') as { v: number; pins: unknown[] };
    expect(stored.v).toBe(1);
    expect((await listPins()).map((pin) => pin.place.placeName).sort()).toEqual(['Fira', 'Oia']);
  });

  it('converges after a worker restart interrupts a migration', async () => {
    await mock.local.set({
      settings: { activeProviderId: 'muse' },
      tripBoard: [{ place: place('Oia'), sourceHost: 'example.com', addedAt: 1 }],
      costTotals: { '2026-03': 1.5 },
    });

    let sets = 0;
    mock.local.fault = (op) => {
      if (op === 'set') {
        sets += 1;

        if (sets === 1) {
          throw new Error('worker died');
        }
      }
    };

    // The faulted step logs its failure; capture the expected warning
    // instead of printing it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const partial = await handleStorageMessage(
        { scope: STORAGE_MESSAGE_SCOPE, command: { kind: 'migrate.run' } },
        PAGE_SENDER
      );
      expect(partial?.ok).toBe(true);

      const steps = (partial as { ok: true; value: Array<{ name: string; ok: boolean }> }).value;
      expect(steps.find((step) => step.name === 'settings')?.ok).toBe(false);
      expect(steps.find((step) => step.name === 'board')?.ok).toBe(true);

      // Restart: a fresh service instance holds no migration progress.
      mock.local.fault = () => undefined;
      vi.resetModules();
      const fresh = await import('./storage_service');

      const retried = await fresh.handleStorageMessage(
        { scope: STORAGE_MESSAGE_SCOPE, command: { kind: 'migrate.run' } },
        PAGE_SENDER
      );
      expect(retried?.ok).toBe(true);

      const done = (retried as { ok: true; value: Array<{ name: string; ok: boolean }> }).value;
      expect(done.every((step) => step.ok)).toBe(true);

      // The interrupted step logged once; the clean retry stays silent.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('migration settings failed', expect.any(Error));
    } finally {
      warn.mockRestore();
    }

    const settings = mock.local.data.get('settings') as { v: number };
    expect(settings.v).toBe(1);
    expect((await listPins()).map((pin) => pin.place.placeName)).toEqual(['Oia']);
    expect(await readMonthSpend(new Date('2026-03-15T12:00:00Z'))).toBe(1.5);
  });

  it('creates one wrapping key for simultaneous first saves', async () => {
    await Promise.all([saveKey('muse', 'LLM_key-a', false), saveKey('muse', 'LLM_key-b', false)]);

    const loaded = await loadKey('muse');
    expect(loaded.state).toBe('ok');
    expect(['LLM_key-a', 'LLM_key-b']).toContain(loaded.state === 'ok' ? loaded.key : 'missing');
    expect(idbSize('trip-vault:keys')).toBe(1);

    const names = [...mock.local.data.keys()].filter((key) => key.startsWith('apiKey:'));
    expect(names).toEqual(['apiKey:muse']);
  });

  it('clears every provider key from both areas', async () => {
    await saveKey('muse', 'LLM_key-a', false);
    await saveKey('openai_compat', 'LLM_key-b', true);

    const cleared = await clearAllKeys();
    expect(cleared.sort()).toEqual(['muse', 'openai_compat']);

    expect([...mock.local.data.keys()].filter((key) => key.startsWith('apiKey:'))).toEqual([]);
    expect([...mock.session.data.keys()].filter((key) => key.startsWith('apiKey:'))).toEqual([]);
    expect((await loadKey('muse')).state).toBe('missing');
    expect((await loadKey('openai_compat')).state).toBe('missing');
  });
});

describe('storage service key modes', () => {
  it('moves the key and verifies placement in both directions', async () => {
    await saveKey('muse', 'LLM_secret', false);

    const toSession = await setKeyMode('muse', true);
    expect(toSession).toEqual({ sessionOnly: true });
    expect(mock.session.data.has('apiKey:muse')).toBe(true);
    expect(mock.local.data.has('apiKey:muse')).toBe(false);
    expect((await loadSettings()).sessionOnly).toBe(true);
    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_secret' });

    const toLocal = await setKeyMode('muse', false);
    expect(toLocal).toEqual({ sessionOnly: false });
    expect(mock.session.data.has('apiKey:muse')).toBe(false);
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
    expect((await loadSettings()).sessionOnly).toBe(false);
    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_secret' });
  });

  it('flips the flag without a key and reports the verified mode', async () => {
    await expect(setKeyMode('muse', true)).resolves.toEqual({ sessionOnly: true });
    expect((await loadSettings()).sessionOnly).toBe(true);

    await expect(setKeyMode('muse', false)).resolves.toEqual({ sessionOnly: false });
    expect((await loadSettings()).sessionOnly).toBe(false);
  });

  it.each([
    ['session write', 'session', 'set', 1, true],
    ['session verify read', 'session', 'get', 2, true],
    ['local remove', 'local', 'remove', 1, true],
    ['settings write', 'local', 'set', 1, true],
    ['local write', 'local', 'set', 1, false],
    ['local verify read', 'local', 'get', 2, false],
    ['session remove', 'session', 'remove', 1, false],
    ['settings write persisted', 'local', 'set', 2, false],
  ])('reconciles after a failed %s moving to %s', async (_label, area, op, nth, want) => {
    await saveKey('muse', 'LLM_secret', !want);

    if (!want) {
      await mock.local.set({ settings: { v: 1, settings: { sessionOnly: true } } });
    }

    let calls = 0;
    mock[area as 'local' | 'session'].fault = (failedOp) => {
      if (failedOp === op) {
        calls += 1;

        if (calls === nth) {
          throw new Error('storage fault');
        }
      }
    };

    const result = await setKeyMode('muse', want);
    expect(result.error).toBeTruthy();

    mock.local.fault = () => undefined;
    mock.session.fault = () => undefined;

    // Ciphertext survives every failure: the key still decrypts.
    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_secret' });

    // The reported mode matches freshly read storage, never a guess.
    const sessionHas = mock.session.data.has('apiKey:muse');
    const localHas = mock.local.data.has('apiKey:muse');
    const settingsTrue = (await loadSettings()).sessionOnly === true;
    expect(result.sessionOnly).toBe(settingsTrue && sessionHas && !localHas);
  });
});

describe('storage service cache commands', () => {
  it('round-trips entries through the service', async () => {
    await setCacheEntry('hash0', entry('Oia'));

    const found = await getCacheEntry('hash0');
    expect(found?.place.placeName).toBe('Oia');

    expect(await getCacheEntry('missing')).toBeUndefined();
  });

  it('rejects entries that violate the schema without storing them', async () => {
    const big = entry('Oia');
    big.place.oneLiner = 'x'.repeat(500);
    await setCacheEntry('big', big);

    expect(await getCacheEntry('big')).toBeUndefined();
    expect(mock.session.data.has('cache:big')).toBe(false);
  });

  it('rejects corrupt stored records without replacing them', async () => {
    const corrupt = {
      v: 2,
      createdAt: Date.now(),
      entry: { ...entry('Oia'), place: 42 },
    };
    await mock.session.set({ 'cache:bad': corrupt });

    expect(await getCacheEntry('bad')).toBeUndefined();
    expect(mock.session.data.get('cache:bad')).toEqual(corrupt);
  });

  it('evicts least-recently-used entries past the slot cap', async () => {
    for (let n = 0; n < 11; n += 1) {
      await setCacheEntry(`max${n}`, entry(`Place${n}`));
    }

    expect(await getCacheEntry('max0')).toBeUndefined();
    expect((await getCacheEntry('max1'))?.place.placeName).toBe('Place1');
    expect((await getCacheEntry('max10'))?.place.placeName).toBe('Place10');
  });

  it('sweeps expired and orphaned records on write', async () => {
    await mock.session.set({
      'cache:old': {
        v: 2,
        createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        entry: entry('Old'),
      },
      'cache:orphan': { v: 2, createdAt: Date.now(), entry: entry('Orphan') },
      cacheKeys: ['old'],
    });

    await setCacheEntry('fresh', entry('Fresh'));

    expect(mock.session.data.has('cache:old')).toBe(false);
    expect(mock.session.data.has('cache:orphan')).toBe(false);
    expect((await getCacheEntry('fresh'))?.place.placeName).toBe('Fresh');
  });

  it('expires cached entries per the retention setting', async () => {
    await mock.local.set({ settings: { v: 1, settings: { cacheTtlDays: 1 } } });
    await mock.session.set({
      'cache:old': {
        v: 2,
        createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
        entry: entry('Old'),
      },
      'cache:fresh': { v: 2, createdAt: Date.now(), entry: entry('Fresh') },
      cacheKeys: ['old', 'fresh'],
    });

    expect(await getCacheEntry('old')).toBeUndefined();
    expect(mock.session.data.has('cache:old')).toBe(false);
    expect((await getCacheEntry('fresh'))?.place.placeName).toBe('Fresh');
  });

  it('keeps entries within a longer retention', async () => {
    await mock.local.set({ settings: { v: 1, settings: { cacheTtlDays: 30 } } });
    await mock.session.set({
      'cache:aged': {
        v: 2,
        createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
        entry: entry('Aged'),
      },
      cacheKeys: ['aged'],
    });

    expect((await getCacheEntry('aged'))?.place.placeName).toBe('Aged');
  });

  it('tolerates storage faults without breaking callers', async () => {
    mock.session.fault = (op) => {
      if (op === 'get' || op === 'set') {
        throw new Error('unavailable');
      }
    };

    try {
      expect(await getCacheEntry('hash0')).toBeUndefined();
      await expect(setCacheEntry('hash0', entry('Oia'))).resolves.toBeUndefined();
    } finally {
      mock.session.fault = () => undefined;
    }
  });

  it('reports failed clears instead of claiming success', async () => {
    await setCacheEntry('hash0', entry('Oia'));

    mock.session.fault = (op) => {
      if (op === 'remove') {
        throw new Error('unavailable');
      }
    };

    try {
      await expect(clearCacheEntries()).rejects.toThrow();
    } finally {
      mock.session.fault = () => undefined;
    }

    expect((await getCacheEntry('hash0'))?.place.placeName).toBe('Oia');
  });
});
