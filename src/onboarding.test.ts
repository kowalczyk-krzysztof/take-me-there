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
import {
  clickEl,
  dispatchEl,
  readShell,
  settleWrite,
  setupPage,
  teardownPage,
  waitFor,
} from './test/helpers';

const SHELL = readShell('onboarding');

const fetchMock = vi.fn();

const setup = async (): Promise<ChromeMock> =>
  setupPage(SHELL, fetchMock, () => import('./onboarding'));

afterEach(teardownPage);

describe('onboarding', () => {
  it('renders copy and the key form', async () => {
    await setup();
    expect(document.querySelector('#title')?.textContent).toBe('appName');
    expect(document.querySelector('#howto')?.textContent).toBe('onboardingHowto');
    expect(document.querySelector('#key-host #key-later')?.textContent).toBe('onboardingKeyLater');
    expect((document.querySelector('.title-row img') as HTMLImageElement).getAttribute('src')).toBe(
      'icons/48.png'
    );
    expect(document.querySelector('#key-input')).not.toBeNull();
    expect(document.querySelector('#key-host button.primary')?.textContent).toBe('saveKeyButton');
  });

  it('announces key validation failures in the status region', async () => {
    await setup();
    fetchMock.mockResolvedValue(new Response('[]', { status: 401 }));
    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_bad';
    dispatchEl(
      document.querySelector('#key-host form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('keyErrorRejected');
    });
    expect(document.querySelector('#key-error')?.getAttribute('role')).toBe('alert');
  });

  it('reports the verified mode when the session-only move fails', async () => {
    const mock = await setup();

    const { persistKey, loadKey } = await settleWrite(import('./key_vault'));
    await settleWrite(persistKey('muse', 'LLM_x', false));

    mock.session.fault = (op) => {
      if (op === 'set') {
        throw new Error('quota');
      }
    };

    const box = document.querySelector('#session-only') as HTMLInputElement;
    box.checked = true;
    dispatchEl(box, new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('settingsSaveFailed');
    });
    expect((document.querySelector('#session-only') as HTMLInputElement).checked).toBe(false);

    mock.session.fault = () => undefined;

    expect(await settleWrite(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_x' });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
  });

  it('saves keys through validation', async () => {
    const mock = await setup();
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_new';
    dispatchEl(
      document.querySelector('#key-host form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeySaved');
    });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
  });

  it('confirms the saved key with replace and clear actions', async () => {
    const mock = await setup();
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_new';
    dispatchEl(
      document.querySelector('#key-host form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')?.textContent).toBe('keySavedStatus');
    });
    expect(document.querySelector('#key-host form')).toBeNull();
    expect(document.querySelector('#onboarding-next')?.textContent).toBe('onboardingNext');
    expect(document.querySelector('#key-storage-mode')?.textContent).toBe('keyStorageSaved');

    const toggle = document.querySelector('#session-only-saved') as HTMLInputElement;
    clickEl(toggle);

    await waitFor(() => {
      expect(document.querySelector('#key-storage-mode')?.textContent).toBe('keyStorageSession');
    });
    expect(document.querySelector('#key-host form')).toBeNull();

    const actions = [...document.querySelectorAll('#key-host .confirm-actions button')];
    expect(actions.map((button) => button.textContent)).toEqual([
      'keyReplaceButton',
      'clearKeyButton',
    ]);

    clickEl(actions[0] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#key-host #key-input')).not.toBeNull();
    });

    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_again';
    dispatchEl(
      document.querySelector('#key-host form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')).not.toBeNull();
    });

    const again = [...document.querySelectorAll('#key-host .confirm-actions button')];
    clickEl(again[1] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#key-host #key-input')).not.toBeNull();
    });
    expect(mock.local.data.has('apiKey:muse')).toBe(false);
  });
});
