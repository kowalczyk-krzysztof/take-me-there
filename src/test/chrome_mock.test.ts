import { describe, expect, it, vi } from 'vitest';
import { installChromeMock, MockStorageArea, uninstallChromeMock } from './chrome_mock';

describe('MockStorageArea fidelity', () => {
  it('stores a copy so later caller mutations cannot leak in', async () => {
    const area = new MockStorageArea('session');

    const record = { nested: { count: 1 } };
    await area.set({ tripRequest: record });
    record.nested.count = 99;
    expect(await area.get('tripRequest')).toEqual({ tripRequest: { nested: { count: 1 } } });
  });

  it('returns copies so reader mutations cannot leak back', async () => {
    const area = new MockStorageArea('local');
    await area.set({ settings: { imageOnly: false } });

    const first = await area.get('settings');
    (first['settings'] as { imageOnly: boolean }).imageOnly = true;
    expect(await area.get('settings')).toEqual({ settings: { imageOnly: false } });
  });

  it('dispatches asynchronously with changes only', async () => {
    const area = new MockStorageArea('session');

    const seen: unknown[][] = [];
    area.onChanged.addListener((...args: unknown[]) => {
      seen.push(args);
    });

    const pending = area.set({ k: { v: 1 } });
    expect(seen).toHaveLength(0);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0][0]).toEqual({ k: { oldValue: undefined, newValue: { v: 1 } } });
  });

  it('fans out to the global listener with the area name', async () => {
    const mock = installChromeMock();

    try {
      const global = vi.fn();
      (
        chrome.storage.onChanged as { addListener: (fn: (...args: unknown[]) => void) => void }
      ).addListener(global);
      await mock.session.set({ k: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(global).toHaveBeenCalledTimes(1);
      expect(global.mock.calls[0][1]).toBe('session');
    } finally {
      uninstallChromeMock();
    }
  });
});
