import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings } from './settings_store';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

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
