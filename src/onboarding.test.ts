import { afterEach, describe, expect, it, vi } from 'vitest';

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
  };
});

import type { ChromeMock } from './test/chrome_mock';
import { readShell, setupPage, teardownPage, waitFor } from './test/helpers';

const SHELL = readShell('onboarding');

const fetchMock = vi.fn();

const setup = async (): Promise<ChromeMock> =>
  setupPage(SHELL, fetchMock, () => import('./onboarding'));

afterEach(teardownPage);

describe('onboarding', () => {
  it('renders copy, shortcut fallback, and the key form', async () => {
    await setup();
    expect(document.querySelector('#title')?.textContent).toBe('appName');
    expect(document.querySelector('#howto')?.textContent).toBe('onboardingHowto');
    expect(document.querySelector('#try-hint')?.textContent).toBe('onboardingTryHint');
    await waitFor(() => {
      expect(document.querySelector('#shortcut-line')?.textContent).toBe('shortcutUnset');
    });
    expect(document.querySelector('#key-input')).not.toBeNull();
    expect(document.querySelector('#key-host button.primary')?.textContent).toBe('saveKeyButton');
  });

  it('announces key validation failures in the status region', async () => {
    await setup();
    fetchMock.mockResolvedValue(new Response('[]', { status: 401 }));
    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_bad';
    (document.querySelector('#key-host form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('keyErrorRejected');
    });
    expect(document.querySelector('#key-error')?.getAttribute('role')).toBe('alert');
  });

  it('reports the verified mode when the session-only move fails', async () => {
    const mock = await setup();

    const { saveKey, loadKey } = await import('./key_vault');
    await saveKey('muse', 'LLM_x', false);

    mock.session.fault = (op) => {
      if (op === 'set') {
        throw new Error('quota');
      }
    };

    const box = document.querySelector('#session-only') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('settingsSaveFailed');
    });
    expect((document.querySelector('#session-only') as HTMLInputElement).checked).toBe(false);

    mock.session.fault = () => undefined;

    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_x' });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
  });

  it('saves keys through validation', async () => {
    const mock = await setup();
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_new';
    (document.querySelector('#key-host form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeySaved');
    });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
  });
});
