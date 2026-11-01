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
import {
  clickEl,
  dispatchEl,
  readShell,
  settleWrite,
  setupPage,
  teardownPage,
  waitFor,
} from './test/helpers';

const SHELL = readShell('options');

const fetchMock = vi.fn();

// React drops change events after a programmatic value set, so bypass its
// tracker the way a real user pick does.
const pickRetention = (select: HTMLSelectElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
  dispatchEl(select, new Event('change', { bubbles: true }));
};

const setup = async (
  beforeImport?: (mock: ChromeMock) => void | Promise<void>
): Promise<ChromeMock> => setupPage(SHELL, fetchMock, () => import('./options'), beforeImport);

afterEach(teardownPage);

describe('options', () => {
  it('renders sections and the live cost total', async () => {
    await setup(async (mock) => {
      await settleWrite(mock.local.set({ costTotals: { [monthKey()]: 1.5 } }));

      const chromeGlobal = globalThis as unknown as {
        chrome: { i18n: { getMessage: (key: string, subs?: string | string[]) => string } };
      };
      chromeGlobal.chrome.i18n.getMessage = (key: string, subs?: string | string[]) =>
        subs === undefined ? key : `${key}:${Array.isArray(subs) ? subs.join(',') : subs}`;
    });
    expect(document.querySelector('#key-heading')?.textContent).toBe('optionsKeyHeading');
    expect(document.querySelector('#privacy-body')?.textContent).toBe('optionsPrivacyBody');
    await waitFor(() => {
      expect(document.querySelector('#cost-line')?.textContent).toBe('optionsCostMonth:$1.50');
    });
  });

  it('persists the image-only toggle', async () => {
    const mock = await setup();

    const box = document.querySelector('#image-only') as HTMLInputElement;
    clickEl(box);
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
    clickEl(box);
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
    dispatchEl(
      document.querySelector('#key-host form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeySaved');
    });
    expect(document.querySelector('#status-region')?.hasAttribute('hidden')).toBe(false);
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
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

  it('tests the saved key and clears it', async () => {
    const mock = await setup();

    const { persistKey, loadKey } = await settleWrite(import('./key_vault'));
    await settleWrite(persistKey('muse', 'LLM_x', false));
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    clickEl(document.querySelector('#test-key') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeyWorks');
    });
    clickEl(document.querySelector('#clear-key') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeyCleared');
    });
    expect(await settleWrite(loadKey('muse'))).toEqual({ state: 'missing', orphaned: false });
    expect(mock.local.data.has('apiKey:muse')).toBe(false);
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
    expect(mock.session.data.has('apiKey:muse')).toBe(false);
  });

  it('shows clear failures instead of claiming success', async () => {
    const mock = await setup();

    const { persistKey, loadKey } = await settleWrite(import('./key_vault'));
    await settleWrite(persistKey('muse', 'LLM_x', false));

    const fail = (): void => {
      throw new Error('quota');
    };
    mock.session.fault = fail;
    mock.local.fault = fail;

    clickEl(document.querySelector('#clear-key') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('settingsSaveFailed');
    });

    mock.session.fault = () => undefined;
    mock.local.fault = () => undefined;

    expect(await settleWrite(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_x' });
  });

  it('changes retention and clears cached results', async () => {
    const mock = await setup(async (inner) => {
      await settleWrite(
        inner.session.set({
          'cache:a': {
            v: 2,
            createdAt: Date.now(),
            entry: { place: null, guide: '# A', sources: [], usage: null, searchedWeb: false },
          },
          cacheKeys: ['a'],
        })
      );
    });

    await waitFor(() => {
      expect(document.querySelector('#cost-line')?.textContent).toContain('optionsCostMonth');
    });

    const retention = document.querySelector('#retention-select') as HTMLSelectElement;
    expect(retention.value).toBe('7');
    pickRetention(retention, '30');

    await waitFor(() => {
      const record = mock.local.data.get('settings') as {
        settings: { cacheTtlDays: number };
      };

      expect(record.settings.cacheTtlDays).toBe(30);
    });

    clickEl(document.querySelector('#clear-cache') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#cache-result')?.textContent).toBe('cacheClearedOne');
    });
    expect(mock.session.data.has('cache:a')).toBe(false);

    clickEl(document.querySelector('#clear-cache') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#cache-result')?.textContent).toBe('cacheClearedNone');
    });
  });

  it('reports retention and cache-clear failures', async () => {
    const mock = await setup();

    await waitFor(() => {
      expect(document.querySelector('#cost-line')?.textContent).toContain('optionsCostMonth');
    });

    mock.local.fault = (op) => {
      if (op === 'set') {
        throw new Error('quota');
      }
    };

    const retention = document.querySelector('#retention-select') as HTMLSelectElement;
    pickRetention(retention, '1');

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('settingsSaveFailed');
    });
    expect(retention.value).toBe('7');

    mock.local.fault = () => undefined;
    mock.session.fault = (op) => {
      if (op === 'remove') {
        throw new Error('locked');
      }
    };

    clickEl(document.querySelector('#clear-cache') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#cache-result')?.textContent).toBe('cacheClearFailed');
    });

    mock.session.fault = () => undefined;
  });

  it('keeps retention and key mode independent', async () => {
    const mock = await setup();

    const { persistKey, loadKey } = await settleWrite(import('./key_vault'));
    await settleWrite(persistKey('muse', 'LLM_x', false));

    await waitFor(() => {
      expect(document.querySelector('#cost-line')?.textContent).toContain('optionsCostMonth');
    });

    const sessionOnly = document.querySelector('#session-only') as HTMLInputElement;
    sessionOnly.checked = true;
    dispatchEl(sessionOnly, new Event('change', { bubbles: true }));

    await waitFor(async () => {
      expect((await settleWrite(loadKey('muse'))).state).toBe('ok');
    });

    const retention = document.querySelector('#retention-select') as HTMLSelectElement;
    pickRetention(retention, '30');

    await waitFor(() => {
      const record = mock.local.data.get('settings') as {
        settings: { cacheTtlDays: number; sessionOnly: boolean };
      };

      expect(record.settings.cacheTtlDays).toBe(30);
      expect(record.settings.sessionOnly).toBe(true);
    });

    expect(await settleWrite(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_x' });
    expect(mock.session.data.has('apiKey:muse')).toBe(true);
  });

  it('reflects settings changed in another surface without a reload', async () => {
    const mock = await setup();

    await waitFor(() => {
      expect(document.querySelector('#cost-line')?.textContent).toContain('optionsCostMonth');
    });

    expect((document.querySelector('#image-only') as HTMLInputElement).checked).toBe(false);

    await settleWrite(
      mock.local.set({
        settings: {
          v: 1,
          settings: {
            imageOnly: true,
            sessionOnly: false,
            skipWebSearch: false,
            cacheTtlDays: 30,
          },
        },
      })
    );

    await waitFor(() => {
      expect((document.querySelector('#image-only') as HTMLInputElement).checked).toBe(true);
      expect((document.querySelector('#retention-select') as HTMLSelectElement).value).toBe('30');
    });
  });

  it('preserves mode edits made during key validation', async () => {
    const mock = await setup();

    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );

    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_new';
    dispatchEl(
      document.querySelector('#key-host form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusValidatingKey');
    });

    clickEl(document.querySelector('#image-only') as HTMLInputElement);

    await waitFor(() => {
      const record = mock.local.data.get('settings') as {
        settings: { imageOnly: boolean };
      };

      expect(record.settings.imageOnly).toBe(true);
    });

    await settleWrite(
      (async () => {
        release(new Response('[]', { status: 200 }));
      })()
    );

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeySaved');
    });

    const record = mock.local.data.get('settings') as {
      settings: { imageOnly: boolean; sessionOnly: boolean };
    };
    expect(record.settings.imageOnly).toBe(true);
    expect(record.settings.sessionOnly).toBe(false);
  });
});
