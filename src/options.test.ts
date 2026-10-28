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

import { monthKey } from './pricing';
import type { ChromeMock } from './test/chrome_mock';
import { readShell, setupPage, teardownPage, waitFor } from './test/helpers';

const SHELL = readShell('options');

const fetchMock = vi.fn();

const setup = async (
  beforeImport?: (mock: ChromeMock) => void | Promise<void>
): Promise<ChromeMock> => setupPage(SHELL, fetchMock, () => import('./options'), beforeImport);

afterEach(teardownPage);

describe('options', () => {
  it('renders sections and the live cost total', async () => {
    await setup(async (mock) => {
      await mock.local.set({ costTotals: { [monthKey()]: 1.5 } });

      const chromeGlobal = globalThis as unknown as {
        chrome: { i18n: { getMessage: (key: string, subs?: string | string[]) => string } };
      };
      chromeGlobal.chrome.i18n.getMessage = (key: string, subs?: string | string[]) =>
        subs === undefined ? key : `${key}:${Array.isArray(subs) ? subs.join(',') : subs}`;
    });
    expect(document.querySelector('#key-heading')?.textContent).toBe('optionsKeyHeading');
    expect(document.querySelector('#privacy-body')?.textContent).toBe('optionsPrivacyBody');
    expect(document.querySelector('#reset-cost')?.textContent).toBe('resetCostButton');
    await waitFor(() => {
      expect(document.querySelector('#cost-line')?.textContent).toBe('optionsCostMonth:$1.50');
    });
  });

  it('resets the monthly total', async () => {
    const mock = await setup(async (inner) => {
      await inner.local.set({ costTotals: { [monthKey()]: 2 } });
    });
    (document.querySelector('#reset-cost') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusMonthlyReset');
    });
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: {} });
  });

  it('persists the image-only toggle', async () => {
    const mock = await setup();

    const box = document.querySelector('#image-only') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      const record = mock.local.data.get('settings') as {
        settings: { imageOnly: boolean };
      };
      expect(record.settings.imageOnly).toBe(true);
    });
  });

  it('persists the cheap-mode toggle', async () => {
    const mock = await setup();

    const box = document.querySelector('#skip-search') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      const record = mock.local.data.get('settings') as {
        settings: { skipWebSearch: boolean };
      };
      expect(record.settings.skipWebSearch).toBe(true);
    });
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

  it('tests the saved key and clears it', async () => {
    const mock = await setup();

    const { saveKey, loadKey } = await import('./key_vault');
    await saveKey('muse', 'LLM_x', false);
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    (document.querySelector('#test-key') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeyWorks');
    });
    (document.querySelector('#clear-key') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeyCleared');
    });
    expect(await loadKey('muse')).toEqual({ state: 'missing', orphaned: false });
    expect(mock.local.data.has('apiKey:muse')).toBe(false);
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
    expect(mock.session.data.has('apiKey:muse')).toBe(false);
  });

  it('clears all saved keys', async () => {
    await setup();

    const { saveKey, loadKey } = await import('./key_vault');
    await saveKey('muse', 'LLM_x', false);
    await saveKey('openai_compat', 'LLM_y', true);

    (document.querySelector('#clear-all-keys') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeyCleared');
    });

    expect((await loadKey('muse')).state).toBe('missing');
    expect((await loadKey('openai_compat')).state).toBe('missing');
  });

  it('shows clear failures instead of claiming success', async () => {
    const mock = await setup();

    const { saveKey, loadKey } = await import('./key_vault');
    await saveKey('muse', 'LLM_x', false);

    const fail = (): void => {
      throw new Error('quota');
    };
    mock.session.fault = fail;
    mock.local.fault = fail;

    (document.querySelector('#clear-key') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('settingsSaveFailed');
    });

    mock.session.fault = () => undefined;
    mock.local.fault = () => undefined;

    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_x' });
  });

  it('labels the provider radio group and the server fieldset', async () => {
    await setup();
    expect(document.querySelector('#provider-group')?.getAttribute('aria-labelledby')).toBe(
      'provider-heading'
    );
    expect(document.querySelector('#compat-fields legend')?.textContent).toBe('compatLegend');
  });

  it('saves a custom server after the origin grant', async () => {
    const mock = await setup();

    const permsRequest = vi.fn().mockResolvedValue(true);
    (chrome as unknown as { permissions: unknown }).permissions = { request: permsRequest };

    const compat = document.querySelector('#provider-compat') as HTMLInputElement;
    compat.checked = true;
    compat.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('#compat-fields')?.hasAttribute('hidden')).toBe(false);
    (document.querySelector('#compat-base-url') as HTMLInputElement).value =
      'https://llm.example.com/v1/';
    (document.querySelector('#compat-model') as HTMLInputElement).value = 'test-model';
    (document.querySelector('#compat-structured') as HTMLSelectElement).value = 'json_schema';
    (document.querySelector('#compat-input-rate') as HTMLInputElement).value = '1.5';
    (document.querySelector('#compat-save') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#compat-error')?.textContent).toBe(
        'compatHostWarning(llm.example.com)'
      );
    });
    expect(document.querySelector('#compat-save')?.textContent).toBe('compatSaveAnyway');
    expect(permsRequest).not.toHaveBeenCalled();
    expect(mock.local.data.get('settings')).toBeUndefined();
    (document.querySelector('#compat-save') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusProviderSaved');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://llm.example.com/*'] });
    expect(mock.local.data.get('settings')).toEqual({
      v: 1,
      settings: {
        activeProviderId: 'openai_compat',
        openaiCompat: {
          baseURL: 'https://llm.example.com/v1',
          model: 'test-model',
          structuredOutput: 'json_schema',
          inputRatePerM: 1.5,
        },
        imageOnly: false,
        sessionOnly: false,
        skipWebSearch: false,
      },
    });
  });

  it('rejects bad server URLs, models, rates, and denials', async () => {
    const mock = await setup();
    const permsRequest = vi.fn().mockResolvedValue(false);
    (chrome as unknown as { permissions: unknown }).permissions = { request: permsRequest };
    const compat = document.querySelector('#provider-compat') as HTMLInputElement;
    compat.checked = true;
    compat.dispatchEvent(new Event('change', { bubbles: true }));
    const save = document.querySelector('#compat-save') as HTMLButtonElement;
    const baseUrl = document.querySelector('#compat-base-url') as HTMLInputElement;
    const model = document.querySelector('#compat-model') as HTMLInputElement;
    const error = () => document.querySelector('#compat-error')?.textContent;
    baseUrl.value = 'https://remote.example.com:81/x';
    save.click();
    await waitFor(() => {
      expect(error()).toBe('providerErrorModel');
    });
    baseUrl.value = 'not a url';
    model.value = 'm';
    save.click();
    await waitFor(() => {
      expect(error()).toBe('providerErrorUrl');
    });
    baseUrl.value = 'http://remote.example.com/v1';
    save.click();
    await waitFor(() => {
      expect(error()).toBe('providerErrorUrl');
    });
    baseUrl.value = 'http://localhost:11434/v1';
    (document.querySelector('#compat-input-rate') as HTMLInputElement).value = '-2';
    save.click();
    await waitFor(() => {
      expect(error()).toBe('providerErrorRates');
    });
    (document.querySelector('#compat-input-rate') as HTMLInputElement).value = '';
    save.click();
    await waitFor(() => {
      expect(error()).toBe('compatHostWarning(localhost:11434)');
    });
    save.click();
    await waitFor(() => {
      expect(error()).toBe('providerErrorDenied');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['http://localhost:11434/*'] });
    expect(mock.local.data.get('settings')).toBeUndefined();
  });

  it('switches back to Muse immediately', async () => {
    const mock = await setup(async (inner) => {
      await inner.local.set({
        settings: {
          activeProviderId: 'openai_compat',
          openaiCompat: {
            baseURL: 'https://llm.example.com/v1',
            model: 'm',
            structuredOutput: 'json_object',
          },
          imageOnly: false,
          sessionOnly: false,
        },
      });
    });
    await waitFor(() => {
      expect((document.querySelector('#provider-compat') as HTMLInputElement).checked).toBe(true);
    });
    expect(document.querySelector('#compat-fields')?.hasAttribute('hidden')).toBe(false);
    expect((document.querySelector('#compat-base-url') as HTMLInputElement).value).toBe(
      'https://llm.example.com/v1'
    );
    const muse = document.querySelector('#provider-muse') as HTMLInputElement;
    muse.checked = true;
    muse.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusProviderSaved');
    });
    expect(document.querySelector('#compat-fields')?.hasAttribute('hidden')).toBe(true);
    const stored = mock.local.data.get('settings') as {
      settings: { activeProviderId: string };
    };
    expect(stored.settings.activeProviderId).toBe('muse');
  });

  it('saves an HTTP loopback server after the origin grant', async () => {
    await setup();

    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsContains = vi.fn().mockResolvedValue(false);
    (chrome as unknown as { permissions: unknown }).permissions = {
      contains: permsContains,
      request: permsRequest,
    };

    const compat = document.querySelector('#provider-compat') as HTMLInputElement;
    compat.checked = true;
    compat.dispatchEvent(new Event('change', { bubbles: true }));
    (document.querySelector('#compat-base-url') as HTMLInputElement).value =
      'http://127.0.0.1:11434/v1';
    (document.querySelector('#compat-model') as HTMLInputElement).value = 'local-model';
    const save = document.querySelector('#compat-save') as HTMLButtonElement;
    save.click();
    await waitFor(() => {
      expect(document.querySelector('#compat-error')?.textContent).toBe(
        'compatHostWarning(127.0.0.1:11434)'
      );
    });
    save.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusProviderSaved');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['http://127.0.0.1:11434/*'] });
  });

  it('removes the owned grant when the save fails', async () => {
    const mock = await setup();

    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsContains = vi.fn().mockResolvedValue(false);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      contains: permsContains,
      request: permsRequest,
      remove: permsRemove,
    };

    mock.local.fault = (op, keys) => {
      if (op === 'set' && keys.includes('settings')) {
        throw new Error('quota');
      }
    };

    const compat = document.querySelector('#provider-compat') as HTMLInputElement;
    compat.checked = true;
    compat.dispatchEvent(new Event('change', { bubbles: true }));
    (document.querySelector('#compat-base-url') as HTMLInputElement).value =
      'https://llm.example.com/v1';
    (document.querySelector('#compat-model') as HTMLInputElement).value = 'test-model';
    const save = document.querySelector('#compat-save') as HTMLButtonElement;
    save.click();
    await waitFor(() => {
      expect(document.querySelector('#compat-error')?.textContent).toContain('compatHostWarning');
    });
    save.click();
    await waitFor(() => {
      expect(document.querySelector('#compat-error')?.textContent).toBe('settingsSaveFailed');
    });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://llm.example.com/*'] });
    expect(mock.local.data.get('settings')).toBeUndefined();

    mock.local.fault = () => undefined;
  });

  it('removes the obsolete grant after a host change', async () => {
    await setup(async (inner) => {
      await inner.local.set({
        settings: {
          v: 1,
          settings: {
            activeProviderId: 'openai_compat',
            openaiCompat: {
              baseURL: 'https://old.example.com/v1',
              model: 'm',
              structuredOutput: 'json_object',
            },
            imageOnly: false,
            sessionOnly: false,
            skipWebSearch: false,
          },
        },
      });
    });

    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsContains = vi.fn().mockImplementation(async (query: { origins: string[] }) => {
      return query.origins[0] === 'https://old.example.com/*';
    });
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      contains: permsContains,
      request: permsRequest,
      remove: permsRemove,
    };

    (document.querySelector('#compat-base-url') as HTMLInputElement).value =
      'https://new.example.com/v1';
    const save = document.querySelector('#compat-save') as HTMLButtonElement;
    save.click();
    await waitFor(() => {
      expect(document.querySelector('#compat-error')?.textContent).toContain('compatHostWarning');
    });
    save.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusProviderSaved');
    });
    expect(permsRemove).toHaveBeenCalledTimes(1);
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://old.example.com/*'] });
  });

  it('removes the custom grant when switching back to Muse', async () => {
    await setup(async (inner) => {
      await inner.local.set({
        settings: {
          v: 1,
          settings: {
            activeProviderId: 'openai_compat',
            openaiCompat: {
              baseURL: 'https://llm.example.com/v1',
              model: 'm',
              structuredOutput: 'json_object',
            },
            imageOnly: false,
            sessionOnly: false,
            skipWebSearch: false,
          },
        },
      });
    });

    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = { remove: permsRemove };

    const muse = document.querySelector('#provider-muse') as HTMLInputElement;
    muse.checked = true;
    muse.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusProviderSaved');
    });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://llm.example.com/*'] });
  });
});
