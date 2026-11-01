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
  imageOnly: false,
  sessionOnly: false,
};

describe('runUpdateMigrations', () => {
  it('wraps legacy bare records in versioned envelopes', async () => {
    await mock.local.set({
      settings: LEGACY_SETTINGS,
      costTotals: { '2026-03': 1.5 },
    });
    await runUpdateMigrations();
    expect(mock.local.data.get('settings')).toEqual({ v: 1, settings: LEGACY_SETTINGS });
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: { '2026-03': 1.5 } });
  });

  it('leaves versioned records, garbage, and absent keys alone', async () => {
    await mock.local.set({
      settings: { v: 1, settings: LEGACY_SETTINGS },
      costTotals: [1, 2],
    });
    await runUpdateMigrations();
    expect(mock.local.data.get('settings')).toEqual({ v: 1, settings: LEGACY_SETTINGS });
    expect(mock.local.data.get('costTotals')).toEqual([1, 2]);
    await runUpdateMigrations();
    expect(mock.local.data.get('settings')).toEqual({ v: 1, settings: LEGACY_SETTINGS });
  });

  it('isolates a failing store so the others still migrate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await mock.local.set({
        settings: LEGACY_SETTINGS,
        costTotals: { '2026-03': 1.5 },
      });

      const realSet = mock.local.set.bind(mock.local);

      const fail = vi
        .spyOn(mock.local, 'set')
        .mockImplementation(async (items: Record<string, unknown>) => {
          if ('costTotals' in items) {
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
      expect(mock.local.data.get('costTotals')).toEqual({ '2026-03': 1.5 });
      expect(warn).toHaveBeenCalledWith('migration spend failed', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('purges legacy local cache records and preserves everything else', async () => {
    await mock.local.set({
      settings: LEGACY_SETTINGS,
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
