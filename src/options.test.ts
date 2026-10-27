// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

const SHELL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../public/options.html'),
  'utf8',
);

const mountShell = (): void => {
  const body = SHELL.split(/<body[^>]*>/)[1]?.split('</body>')[0] ?? '';
  document.body.innerHTML = body;
};

const waitFor = async (fn: () => void, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};

const fetchMock = vi.fn();

const setup = async (
  beforeImport?: (mock: ChromeMock) => void | Promise<void>,
): Promise<ChromeMock> => {
  vi.resetModules();
  const mock = installChromeMock();
  if (beforeImport) {
    await beforeImport(mock);
  }
  mountShell();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  await import('./options');
  return mock;
};

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
  vi.unstubAllGlobals();
});

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
      expect(document.querySelector('#cost-line')?.textContent).toBe(
        'optionsCostMonth:$1.50',
      );
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
    expect(mock.local.data.get('costTotals')).toEqual({});
  });

  it('persists the image-only toggle', async () => {
    const mock = await setup();
    const box = document.querySelector('#image-only') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect((mock.local.data.get('settings') as { imageOnly: boolean }).imageOnly).toBe(true);
    });
  });

  it('persists the prefer-on-device toggle', async () => {
    const mock = await setup();
    const box = document.querySelector('#prefer-on-device') as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(
        (mock.local.data.get('settings') as { preferOnDevice: boolean }).preferOnDevice,
      ).toBe(true);
    });
  });

  it('saves keys through validation', async () => {
    const mock = await setup();
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_new';
    (document.querySelector('#key-host form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeySaved');
    });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
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
      expect(document.querySelector('#status-region')?.textContent).toBe('statusProviderSaved');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://llm.example.com/*'] });
    expect(mock.local.data.get('settings')).toEqual({
      activeProviderId: 'openai_compat',
      openaiCompat: {
        baseURL: 'https://llm.example.com/v1',
        model: 'test-model',
        structuredOutput: 'json_schema',
        inputRatePerM: 1.5,
      },
      imageOnly: false,
      sessionOnly: false,
      preferOnDevice: false,
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
      expect(
        (document.querySelector('#provider-compat') as HTMLInputElement).checked,
      ).toBe(true);
    });
    expect(document.querySelector('#compat-fields')?.hasAttribute('hidden')).toBe(false);
    expect((document.querySelector('#compat-base-url') as HTMLInputElement).value).toBe(
      'https://llm.example.com/v1',
    );
    const muse = document.querySelector('#provider-muse') as HTMLInputElement;
    muse.checked = true;
    muse.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusProviderSaved');
    });
    expect(document.querySelector('#compat-fields')?.hasAttribute('hidden')).toBe(true);
    expect((mock.local.data.get('settings') as { activeProviderId: string }).activeProviderId).toBe(
      'muse',
    );
  });
});
