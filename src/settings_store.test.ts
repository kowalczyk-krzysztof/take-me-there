import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, readSettingsStrict, type SettingsSnapshot } from './settings_store';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
};

const DEFAULTS = {
  imageOnly: false,
  sessionOnly: false,
  skipWebSearch: false,
  cacheTtlDays: 7,
};

describe('cacheTtlDays', () => {
  it('defaults to a week', async () => {
    expect((await loadSettings()).cacheTtlDays).toBe(7);
  });

  it('keeps valid choices and repairs anything else', async () => {
    for (const days of [1, 7, 30]) {
      await mock.local.set({ settings: { v: 1, settings: { cacheTtlDays: days } } });
      expect((await loadSettings()).cacheTtlDays).toBe(days);
    }

    for (const days of [0, 2, -7, '7', null, Number.NaN]) {
      await mock.local.set({ settings: { v: 1, settings: { cacheTtlDays: days } } });
      expect((await loadSettings()).cacheTtlDays).toBe(7);
    }
  });
});

describe('readSettingsStrict', () => {
  it('reports missing records with defaults', async () => {
    await expect(readSettingsStrict()).resolves.toEqual({
      settings: DEFAULTS,
      missing: true,
    });
  });

  it('normalizes stored records', async () => {
    await mock.local.set({
      settings: { v: 1, settings: { imageOnly: true, cacheTtlDays: 30 } },
    });

    await expect(readSettingsStrict()).resolves.toEqual({
      settings: { ...DEFAULTS, imageOnly: true, cacheTtlDays: 30 },
      missing: false,
    });
  });

  it('throws when storage fails', async () => {
    mock.local.fault = () => {
      throw new Error('locked');
    };

    await expect(readSettingsStrict()).rejects.toThrow('locked');
    expect(await loadSettings()).toEqual(DEFAULTS);

    mock.local.fault = () => undefined;
  });
});

describe('subscribeSettings', () => {
  const freshModule = async (): Promise<typeof import('./settings_store')> => {
    vi.resetModules();

    return import('./settings_store');
  };

  const last = (seen: SettingsSnapshot[]): SettingsSnapshot =>
    seen[seen.length - 1] as SettingsSnapshot;

  it('publishes the initial snapshot and later writes', async () => {
    const { subscribeSettings } = await freshModule();
    const seen: SettingsSnapshot[] = [];

    const off = subscribeSettings((snapshot) => {
      seen.push(snapshot);
    });

    await flush();

    expect(seen).toEqual([{ settings: DEFAULTS, failed: false }]);

    await mock.local.set({
      settings: { v: 1, settings: { imageOnly: true } },
    });

    await flush();

    expect(last(seen)).toEqual({
      settings: { ...DEFAULTS, imageOnly: true },
      failed: false,
    });

    off();
  });

  it('flags failed reads and recovers on refresh', async () => {
    const { refreshSettings, subscribeSettings } = await freshModule();
    const seen: SettingsSnapshot[] = [];

    const off = subscribeSettings((snapshot) => {
      seen.push(snapshot);
    });

    await flush();
    expect(last(seen).failed).toBe(false);

    mock.local.fault = () => {
      throw new Error('locked');
    };

    await refreshSettings();

    expect(last(seen).failed).toBe(true);
    expect(last(seen).settings).toEqual(seen[0]?.settings);

    mock.local.fault = () => undefined;

    await refreshSettings();

    expect(last(seen).failed).toBe(false);

    off();
  });

  it('stops notifying after unsubscribe', async () => {
    const { subscribeSettings } = await freshModule();
    const seen: SettingsSnapshot[] = [];

    const off = subscribeSettings((snapshot) => {
      seen.push(snapshot);
    });

    await flush();

    const count = seen.length;

    off();

    await mock.local.set({
      settings: { v: 1, settings: { imageOnly: true } },
    });

    await flush();

    expect(seen.length).toBe(count);
  });
});
