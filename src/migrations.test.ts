import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUpdateMigrations } from './migrations';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

const LEGACY_SETTINGS = {
  activeProviderId: 'muse',
  openaiCompat: { baseURL: '', model: '', structuredOutput: 'json_object' },
  imageOnly: false,
  sessionOnly: false,
};

const LEGACY_PIN = {
  place: {
    identified: true,
    placeName: 'Oia',
    city: 'Oia',
    country: 'Greece',
    confidence: 0.9,
    oneLiner: 'Blue domes.',
  },
  sourceHost: 'example.com',
  addedAt: 42,
};

describe('runUpdateMigrations', () => {
  it('wraps legacy bare records in versioned envelopes', async () => {
    await mock.local.set({
      settings: LEGACY_SETTINGS,
      tripBoard: [LEGACY_PIN],
      costTotals: { '2026-03': 1.5 },
    });
    await runUpdateMigrations();
    expect(mock.local.data.get('settings')).toEqual({ v: 1, settings: LEGACY_SETTINGS });
    expect(mock.local.data.get('tripBoard')).toEqual({ v: 1, pins: [LEGACY_PIN] });
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: { '2026-03': 1.5 } });
  });

  it('leaves versioned records, garbage, and absent keys alone', async () => {
    await mock.local.set({
      settings: { v: 1, settings: LEGACY_SETTINGS },
      tripBoard: 'garbage',
      costTotals: [1, 2],
    });
    await runUpdateMigrations();
    expect(mock.local.data.get('settings')).toEqual({ v: 1, settings: LEGACY_SETTINGS });
    expect(mock.local.data.get('tripBoard')).toBe('garbage');
    expect(mock.local.data.get('costTotals')).toEqual([1, 2]);
    await runUpdateMigrations();
    expect(mock.local.data.get('settings')).toEqual({ v: 1, settings: LEGACY_SETTINGS });
  });

  it('isolates a failing store so the others still migrate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await mock.local.set({
        settings: LEGACY_SETTINGS,
        tripBoard: [LEGACY_PIN],
        costTotals: { '2026-03': 1.5 },
      });

      const realSet = mock.local.set.bind(mock.local);

      const fail = vi
        .spyOn(mock.local, 'set')
        .mockImplementation(async (items: Record<string, unknown>) => {
          if ('tripBoard' in items) {
            throw new Error('quota');
          }

          return realSet(items);
        });

      try {
        await runUpdateMigrations();
      } finally {
        fail.mockRestore();
      }
      expect(mock.local.data.get('settings')).toEqual({ v: 1, settings: LEGACY_SETTINGS });
      expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: { '2026-03': 1.5 } });
      expect(mock.local.data.get('tripBoard')).toEqual([LEGACY_PIN]);
      expect(warn).toHaveBeenCalledWith('migration board failed', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('purges legacy local cache records and preserves everything else', async () => {
    await mock.local.set({
      settings: LEGACY_SETTINGS,
      tripBoard: [LEGACY_PIN],
      costTotals: { '2026-03': 1.5 },
      'vault:muse': { iv: 'x', ciphertext: 'y' },
      cacheKeys: ['a', 'b'],
      'cache:a': { v: 1, entry: { guide: 'stale' } },
      'cache:b': { v: 1, entry: { guide: 'stale' } },
    });

    const results = await runUpdateMigrations();

    expect(results.find((result) => result.name === 'cache')).toEqual({ name: 'cache', ok: true });
    expect(mock.local.data.has('cache:a')).toBe(false);
    expect(mock.local.data.has('cache:b')).toBe(false);
    expect(mock.local.data.has('cacheKeys')).toBe(false);
    expect(mock.local.data.get('settings')).toEqual({ v: 1, settings: LEGACY_SETTINGS });
    expect(mock.local.data.get('tripBoard')).toEqual({ v: 1, pins: [LEGACY_PIN] });
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: { '2026-03': 1.5 } });
    expect(mock.local.data.get('vault:muse')).toEqual({ iv: 'x', ciphertext: 'y' });
  });

  it('reports a failed cache purge and retries it next run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await mock.local.set({ 'cache:a': { v: 1, entry: { guide: 'stale' } }, cacheKeys: ['a'] });
      mock.local.fault = (op) => {
        if (op === 'remove') {
          throw new Error('quota');
        }
      };

      const failed = await runUpdateMigrations();
      expect(failed.find((result) => result.name === 'cache')).toMatchObject({
        name: 'cache',
        ok: false,
      });
      expect(mock.local.data.has('cache:a')).toBe(true);

      mock.local.fault = () => undefined;

      const retried = await runUpdateMigrations();
      expect(retried.find((result) => result.name === 'cache')).toEqual({
        name: 'cache',
        ok: true,
      });
      expect(mock.local.data.has('cache:a')).toBe(false);
    } finally {
      warn.mockRestore();
      mock.local.fault = () => undefined;
    }
  });
});
