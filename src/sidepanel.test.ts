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
import type { ChromeMock } from './test/chrome_mock';
import {
  chatResponse,
  clickEl,
  cover,
  dispatchEl,
  drainStragglers,
  focusEl,
  groundedResponse,
  plantKeyAndConsent,
  readShell,
  settleWrite,
  setupPage,
  sleep,
  teardownPage,
  waitFor,
} from './test/helpers';

const SHELL = readShell('sidepanel');

const CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../public/_locales/en/messages.json'
);

const selectBoardTab = (): void => {
  clickEl(document.querySelector('#tab-board') as HTMLButtonElement);
};

const selectSettingsTab = (): void => {
  clickEl(document.querySelector('#tab-settings') as HTMLButtonElement);
};

const waitForSettings = async (): Promise<void> => {
  await waitFor(() => {
    expect(document.querySelector('#settings-cost-line')?.textContent).toContain(
      'optionsCostMonth'
    );
  });
};

const waitForHeading = async (text: string): Promise<void> => {
  await waitFor(() => {
    expect(document.querySelector('#result-slot h2')?.textContent).toBe(text);
  });
};

const VALID_PLACE = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes over the caldera.',
};

const PLACE_B = {
  identified: true,
  placeName: 'Fira',
  city: 'Fira',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'White lanes above the caldera.',
};

const SIGNALS = {
  imgFound: true,
  alt: 'Blue domes',
  imgTitle: '',
  figcaption: '',
  nearestHeading: '',
  nearestParagraph: '',
  ogTitle: '',
  ogDescription: '',
  ogSiteName: '',
  docTitle: 'Guide',
  metaDescription: '',
  canonical: 'https://example.com/guide',
  pageHost: 'example.com',
  urlSlug: 'guide',
  imgFileSlug: 'oia',
  jsonLd: [],
};

const SLOT = 'tripRequest:1';

let readySeq = 1000;

const READY = (overrides: Record<string, unknown> = {}) => {
  readySeq += 1;

  return {
    requestId: '100-1',
    seq: readySeq,
    status: 'ready',
    srcUrl: 'https://cdn.example.com/oia.jpg',
    dataPending: false,
    pageUrl: 'https://example.com/guide',
    tabId: 7,
    windowId: 1,
    at: Date.now(),
    signals: SIGNALS,
    ...overrides,
  };
};

const fetchMock = vi.fn();

// A hung request with real-fetch abort semantics: it rejects when the
// caller aborts, so cancel paths behave as they do in production.
const hangUntilAbort = (): void => {
  fetchMock.mockImplementationOnce(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
  );
};

const setup = async (
  beforeImport?: (mock: ChromeMock) => void | Promise<void>
): Promise<ChromeMock> => setupPage(SHELL, fetchMock, () => import('./sidepanel'), beforeImport);

afterEach(teardownPage);

describe('sidepanel', () => {
  it('renders the idle hint', async () => {
    await setup();

    const card = document.querySelector('#result-slot');
    expect(card?.querySelector('.hint')?.textContent).toBe('panelIdle');
    await waitFor(() => {
      expect(card?.querySelector('.shortcut')?.textContent).toBe('shortcutUnset');
    });
  });

  it('keeps every Explore section visible with empty states', async () => {
    await setup();
    expect(document.querySelector('#booking-heading')?.textContent).toBe('bookingHeading');
    expect(document.querySelector('#links-slot .slot-empty')?.textContent).toBe('bookingEmpty');
  });

  it('keeps settings in key, modes, and cost cards', async () => {
    await setup();
    await waitForSettings();
    expect(document.querySelector('#main-panel #modes-heading')).toBeNull();
    expect(document.querySelector('#settings-panel #modes-heading')?.textContent).toBe(
      'settingsModesHeading'
    );
    expect(document.querySelectorAll('#settings-panel .settings-card')).toHaveLength(3);
    expect(document.querySelector('#settings-panel #retention-select')).toBeNull();
    expect(document.querySelector('#settings-panel #provider-group')).not.toBeNull();
    expect(document.querySelector('#settings-panel #settings-cost-heading')).not.toBeNull();
    expect(document.querySelector('#page-footer #privacy-line')).not.toBeNull();
    expect(document.querySelector('#page-footer #settings-run-line')).toBeNull();
  });

  it('switches tabs with roving focus, counts pins, and surfaces runs', async () => {
    const mock = await setup();

    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;

    const tabBoard = document.querySelector('#tab-board') as HTMLButtonElement;
    // Explore is available immediately, key or not.
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    expect(tabMain.hasAttribute('aria-disabled')).toBe(false);
    await plantKeyAndConsent();
    clickEl(tabMain);

    const i18n = vi.spyOn(chrome.i18n, 'getMessage');
    expect(tabMain.textContent).toBe('mainTab');
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    expect(tabMain.tabIndex).toBe(0);
    expect(tabBoard.getAttribute('aria-selected')).toBe('false');
    expect(tabBoard.tabIndex).toBe(-1);
    expect(document.querySelector('#tab-bar')?.getAttribute('aria-label')).toBe('tabsLabel');
    expect(document.querySelector('#main-panel')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#board-panel')?.hasAttribute('hidden')).toBe(true);
    clickEl(tabBoard);
    expect(tabBoard.getAttribute('aria-selected')).toBe('true');
    expect(tabBoard.tabIndex).toBe(0);
    expect(tabMain.tabIndex).toBe(-1);
    expect(document.querySelector('#main-panel')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#board-panel')?.hasAttribute('hidden')).toBe(false);
    focusEl(tabMain);
    dispatchEl(tabMain, new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabBoard);
    expect(tabBoard.getAttribute('aria-selected')).toBe('true');
    dispatchEl(tabBoard, new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabMain);
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    // A new run surfaces on the main tab even from the board tab.
    clickEl(tabBoard);
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('Oia');
    });
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    clickEl(document.querySelector('#result-slot .pin-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });
    expect(i18n).toHaveBeenCalledWith('boardTitle', '1');
  });

  it('keeps Explore available without a key', async () => {
    await setup();

    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;

    const tabBoard = document.querySelector('#tab-board') as HTMLButtonElement;

    const tabSettings = document.querySelector('#tab-settings') as HTMLButtonElement;
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    expect(tabMain.hasAttribute('aria-disabled')).toBe(false);
    expect(tabMain.textContent).toBe('mainTab');
    clickEl(tabMain);
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    focusEl(tabSettings);
    dispatchEl(tabSettings, new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabMain);
    dispatchEl(tabMain, new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabBoard);
    dispatchEl(tabBoard, new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(tabSettings);
    dispatchEl(tabSettings, new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabMain);
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    // The End key selected settings and kicked its async refresh; the
    // tail below it is pure sync, so drain the aftershock here.
    await drainStragglers();
  });

  it('replaces the saved key from settings and returns to main', async () => {
    await setup();
    await plantKeyAndConsent();

    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;
    clickEl(document.querySelector('#tab-settings') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')?.textContent).toBe('keySavedStatus');
    });

    const actions = [...document.querySelectorAll('#settings-panel .confirm-actions button')];
    expect(actions.map((button) => button.textContent)).toEqual([
      'keyReplaceButton',
      'clearKeyButton',
      'clearAllKeysButton',
    ]);
    clickEl(actions[0] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-input')).not.toBeNull();
    });
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    (document.querySelector('#settings-panel #key-input') as HTMLInputElement).value = 'LLM_new';
    dispatchEl(
      document.querySelector('#settings-panel form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(tabMain.getAttribute('aria-selected')).toBe('true');
    });

    const { loadKey } = await cover(import('./key_vault'));
    expect(await cover(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_new' });
  });

  it('clears the key from settings and keeps Explore available', async () => {
    await setup();
    await plantKeyAndConsent();

    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;
    clickEl(document.querySelector('#tab-settings') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')).not.toBeNull();
    });

    const actions = [...document.querySelectorAll('#settings-panel .confirm-actions button')];
    clickEl(actions[1] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-input')).not.toBeNull();
    });
    expect(tabMain.hasAttribute('aria-disabled')).toBe(false);
    expect(document.querySelector('#tab-settings')?.getAttribute('aria-selected')).toBe('true');

    const { loadKey } = await cover(import('./key_vault'));
    expect((await cover(loadKey('muse'))).state).toBe('missing');
  });

  it('stages a keyless request and resumes it exactly once after connect', async () => {
    const mock = await setup();
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-input')).not.toBeNull();
    });

    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    (document.querySelector('#settings-panel #key-input') as HTMLInputElement).value = 'LLM_x';
    dispatchEl(
      document.querySelector('#settings-panel form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('consentTitle');
    });

    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    const buttons = document.querySelector('#result-slot')?.querySelectorAll('button');
    clickEl(buttons?.[0] as HTMLButtonElement);
    await waitForHeading('Oia');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/models');
    expect(fetchMock.mock.calls[1][0]).toContain('/chat/completions');
  });

  it('shows inline key setup when no key is saved', async () => {
    const mock = await setup();
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusKeyNeeded');
    });
    expect(document.querySelector('#settings-panel')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#key-input')).not.toBeNull();

    const img = document.querySelector('#preview-frame img') as HTMLImageElement | null;
    expect(img?.src).toContain('oia.jpg');
  });

  it('reverts the session-only toggle when migration fails', async () => {
    const mock = await setup();
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #session-only')).not.toBeNull();
    });

    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));

    const box = document.querySelector('#settings-panel #session-only') as HTMLInputElement;
    box.checked = true;
    dispatchEl(box, new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-error')?.textContent).toBe(
        'settingsSaveFailed'
      );
    });
    expect(
      (document.querySelector('#settings-panel #session-only') as HTMLInputElement).checked
    ).toBe(false);

    const { loadSettings } = await cover(import('./providers/index'));
    expect((await cover(loadSettings())).sessionOnly).toBe(false);
    fail.mockRestore();

    const retry = document.querySelector('#settings-panel #session-only') as HTMLInputElement;
    retry.checked = true;
    dispatchEl(retry, new Event('change', { bubbles: true }));
    await waitFor(async () => {
      expect((await cover(loadSettings())).sessionOnly).toBe(true);
    });
    expect(
      (document.querySelector('#settings-panel #session-only') as HTMLInputElement).checked
    ).toBe(true);
    expect(document.querySelector('#settings-panel #key-error')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps a usable key when the mode move fails mid-write', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    clickEl(document.querySelector('#tab-settings') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')).not.toBeNull();
    });

    const actions = [...document.querySelectorAll('#settings-panel .confirm-actions button')];
    clickEl(actions[0] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #session-only')).not.toBeNull();
    });

    mock.session.fault = (op) => {
      if (op === 'set') {
        throw new Error('quota');
      }
    };

    const box = document.querySelector('#settings-panel #session-only') as HTMLInputElement;
    box.checked = true;
    dispatchEl(box, new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-error')?.textContent).toBe(
        'settingsSaveFailed'
      );
    });
    expect(
      (document.querySelector('#settings-panel #session-only') as HTMLInputElement).checked
    ).toBe(false);

    mock.session.fault = () => undefined;

    const { loadKey } = await cover(import('./key_vault'));
    expect(await cover(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_x' });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
    expect(mock.session.data.has('apiKey:muse')).toBe(false);

    const { loadSettings } = await cover(import('./providers/index'));
    expect((await cover(loadSettings())).sessionOnly).toBe(false);
  });

  it('clears every provider key from settings', async () => {
    await setup();
    await plantKeyAndConsent();

    const { saveKey, loadKey } = await cover(import('./key_vault'));
    await settleWrite(saveKey('openai_compat', 'LLM_y', false));

    clickEl(document.querySelector('#tab-settings') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')).not.toBeNull();
    });

    const actions = [...document.querySelectorAll('#settings-panel .confirm-actions button')];
    const clearAll = actions.find((button) => button.textContent === 'clearAllKeysButton');
    clickEl(clearAll as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-input')).not.toBeNull();
    });

    expect((await cover(loadKey('muse'))).state).toBe('missing');
    expect((await cover(loadKey('openai_compat'))).state).toBe('missing');
  });

  it('shows a visible error when key clear fails', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    clickEl(document.querySelector('#tab-settings') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')).not.toBeNull();
    });

    const fail = (): void => {
      throw new Error('quota');
    };
    mock.session.fault = fail;
    mock.local.fault = fail;

    const actions = [...document.querySelectorAll('#settings-panel .confirm-actions button')];
    clickEl(actions[1] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-saved-error')?.textContent).toBe(
        'settingsSaveFailed'
      );
    });

    mock.session.fault = () => undefined;
    mock.local.fault = () => undefined;

    const { loadKey } = await cover(import('./key_vault'));
    expect(await cover(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_x' });
    expect(document.querySelector('#key-saved-status')).not.toBeNull();
  });

  it('keeps live regions outside tabpanels and announces key failures', async () => {
    await setup();
    expect(document.querySelector('main > #status-region')).not.toBeNull();
    expect(document.querySelector('main > #alert-region')).not.toBeNull();
    expect(document.querySelector('#main-panel #status-region')).toBeNull();
    expect(document.querySelector('#board-panel #alert-region')).toBeNull();
    clickEl(document.querySelector('#tab-settings') as HTMLButtonElement);
    fetchMock.mockResolvedValue(new Response('[]', { status: 401 }));
    (document.querySelector('#settings-panel #key-input') as HTMLInputElement).value = 'LLM_bad';
    dispatchEl(
      document.querySelector('#settings-panel form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('keyErrorRejected');
    });
    expect(document.querySelector('#tab-settings')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#settings-panel #key-error')?.getAttribute('role')).toBe(
      'alert'
    );
  });

  it('ships static shell titles and leaves document locale alone', async () => {
    await setup();
    expect(document.documentElement.lang).toBe('');
    expect(document.documentElement.dir).toBe('');

    const shells = ['sidepanel', 'options', 'onboarding'].map(readShell);

    for (const shell of shells) {
      expect(shell).toContain('<html lang="en">');
    }
    expect(shells[0]).toContain('<title>Take Me There</title>');
    expect(shells[1]).toContain('<title>Take Me There - Options</title>');
    expect(shells[2]).toContain('<title>Welcome to Take Me There</title>');
  });

  it('re-identifies after an image-only switch', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    await settleWrite(mock.local.set({ settings: { v: 1, settings: { imageOnly: true } } }));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    // Prove the second handoff re-ran identify.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitForHeading('Oia');
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls[0]).toContain('/chat/completions');
    expect(urls[1]).toContain('/chat/completions');
  });

  it('serves repeat images from cache without fetching', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    const { hashIdentifyKey, normalizeEndpoint, setCacheEntry } = await cover(
      import('./result_cache')
    );

    const identify = await cover(
      hashIdentifyKey({
        mediaSeed: 'https://cdn.example.com/oia.jpg',
        pageUrl: 'https://example.com/guide',
        providerId: 'muse',
        endpoint: normalizeEndpoint('muse', ''),
        model: 'muse-spark-1.3',
        imageOnly: false,
      })
    );
    const emptyUsage = { inputTokens: 0, outputTokens: 0, searchCount: 0, flatFeesUsd: 0 };
    await settleWrite(
      setCacheEntry(identify, {
        place: VALID_PLACE,
        usage: emptyUsage,
      })
    );
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#settings-run-line')?.textContent).toBe('costLineCache');
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusCacheHit(Oia)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers from a rejected key through the inline fix', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('errorAuthTitle');
    expect(document.querySelector('#result-slot')).not.toBeNull();
    fetchMock
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_good';
    dispatchEl(
      document.querySelector('#settings-panel form') as HTMLFormElement,
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitForHeading('Oia');
  });

  it('gates low-confidence guesses behind the no-place card', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    const GUESS = { ...VALID_PLACE, confidence: 0.2 };
    fetchMock
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('noPlaceTitle');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.primary') as HTMLButtonElement);
    await waitFor(() => {
      expect(card.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const init = fetchMock.mock.calls[1][1] as RequestInit;

    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ text?: string }> | string }>;
      reasoning_effort: string;
    };

    const parts = body.messages[1].content as Array<{ text?: string }>;
    expect(parts[0].text).toContain('NOT Oia');
    expect(body.reasoning_effort).toBe('medium');
  });

  it('records the run exactly once in the monthly total', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const { monthKey } = await cover(import('./pricing'));

    await waitFor(() => {
      const record = mock.local.data.get('costTotals') as {
        v: number;
        months: Record<string, number>;
      };
      expect(record.v).toBe(1);
      expect(record.months[monthKey(new Date())]).toBeCloseTo(0.0003375, 10);
    });
  });

  it('keeps the consent gate for re-click when the flag write fails', async () => {
    const mock = await setup();

    const { saveKey } = await cover(import('./key_vault'));
    await settleWrite(saveKey('muse', 'LLM_x', false));
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('consentTitle');
    });

    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));

    const agree = [...document.querySelectorAll('#result-slot button')].find(
      (button) => button.textContent === 'agreeButton'
    ) as HTMLButtonElement;
    clickEl(agree);
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('settingsSaveFailed');
    });
    expect(document.querySelector('#result-slot h2')?.textContent).toBe('consentTitle');
    expect(fetchMock).not.toHaveBeenCalled();
    fail.mockRestore();

    const retry = [...document.querySelectorAll('#result-slot button')].find(
      (button) => button.textContent === 'agreeButton'
    ) as HTMLButtonElement;
    clickEl(retry);
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the consent gate without any network call', async () => {
    const mock = await setup();

    const { saveKey } = await cover(import('./key_vault'));
    await settleWrite(saveKey('muse', 'LLM_x', false));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('consentTitle');
    });
    await sleep(50);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs exactly once after consent is granted', async () => {
    const mock = await setup();

    const { saveKey } = await cover(import('./key_vault'));

    const { hasConsented } = await cover(import('./providers/index'));
    await settleWrite(saveKey('muse', 'LLM_x', false));
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('consentTitle');
    });

    const agree = [...document.querySelectorAll('#result-slot button')].find(
      (button) => button.textContent === 'agreeButton'
    ) as HTMLButtonElement;
    clickEl(agree);
    await waitForHeading('Oia');
    expect(await cover(hasConsented())).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves consent unset when declined', async () => {
    const mock = await setup();

    const { saveKey } = await cover(import('./key_vault'));

    const { hasConsented } = await cover(import('./providers/index'));
    await settleWrite(saveKey('muse', 'LLM_x', false));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('consentTitle');
    });

    const decline = [...document.querySelectorAll('#result-slot button')].find(
      (button) => button.textContent === 'declineButton'
    ) as HTMLButtonElement;
    clickEl(decline);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusConsentDeclined');
    });
    expect(await cover(hasConsented())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('#result-slot .hint')?.textContent).toBe('panelIdle');
    expect(document.querySelector('#result-slot button')).toBeNull();
  });

  it('gates the first video analysis behind the frame confirm', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'blob:https://example.com/aaa',
          mediaType: 'video',
          frame: { dataUrl: 'data:image/jpeg;base64,ZnJhbWU=', time: 12.5 },
        }),
      })
    );
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('videoConfirmTitle');
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusVideoConfirmNeeded');
    expect(fetchMock).not.toHaveBeenCalled();

    const buttons = [...document.querySelectorAll('#result-slot .confirm-actions button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'videoConfirmAgree',
      'videoConfirmCancel',
    ]);

    const img = document.querySelector('#preview-frame img') as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,ZnJhbWU=');
    expect(img?.alt).toBe('previewAltFrame');
  });

  it('analyzes the captured frame after the video confirm', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'blob:https://example.com/aaa',
          mediaType: 'video',
          frame: { dataUrl: 'data:image/jpeg;base64,ZnJhbWU=', time: 12.5 },
        }),
      })
    );
    await waitFor(() => {
      expect(document.querySelector('#result-slot .confirm-actions .primary')).not.toBeNull();
    });
    clickEl(document.querySelector('#result-slot .confirm-actions .primary') as HTMLButtonElement);
    await waitForHeading('Oia');

    const init = fetchMock.mock.calls[0][1] as RequestInit;

    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
    };
    expect(body.messages[1].content[1].image_url?.url).toBe('data:image/jpeg;base64,ZnJhbWU=');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyVideoFrame(Meta's Muse API)"
    );
  });

  it('keeps the video confirm for re-click when the flag write fails', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'blob:https://example.com/aaa',
          mediaType: 'video',
          frame: { dataUrl: 'data:image/jpeg;base64,ZnJhbWU=', time: 12.5 },
        }),
      })
    );
    await waitFor(() => {
      expect(document.querySelector('#result-slot .confirm-actions .primary')).not.toBeNull();
    });

    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    clickEl(document.querySelector('#result-slot .confirm-actions .primary') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('settingsSaveFailed');
    });
    expect(document.querySelector('#result-slot h2')?.textContent).toBe('videoConfirmTitle');
    expect(fetchMock).not.toHaveBeenCalled();
    fail.mockRestore();
    clickEl(document.querySelector('#result-slot .confirm-actions .primary') as HTMLButtonElement);
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The gate is one-time: the next video analyzes without asking.
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          requestId: '200-2',
          srcUrl: 'blob:https://example.com/bbb',
          mediaType: 'video',
          frame: { dataUrl: 'data:image/jpeg;base64,ZnJhbWUy', time: 3 },
        }),
      })
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(document.querySelector('#result-slot .confirm-actions')).toBeNull();
  });

  it('discards the staged video when the confirm is declined', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'blob:https://example.com/aaa',
          mediaType: 'video',
          frame: { dataUrl: 'data:image/jpeg;base64,ZnJhbWU=', time: 12.5 },
        }),
      })
    );
    await waitFor(() => {
      expect(document.querySelectorAll('#result-slot .confirm-actions button')).toHaveLength(2);
    });

    const cancel = [
      ...document.querySelectorAll('#result-slot .confirm-actions button'),
    ][1] as HTMLButtonElement;
    clickEl(cancel);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe(
        'statusVideoConfirmDeclined'
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs rung 2 for tainted mp4 video with the video part', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    const { setVideoConsented } = await cover(import('./video'));
    await settleWrite(setVideoConsented());
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'https://cdn.example.com/trip.mp4',
          mediaType: 'video',
          frameError: 'tainted',
        }),
      })
    );
    await waitForHeading('Oia');

    const init = fetchMock.mock.calls[0][1] as RequestInit;

    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(body.messages[1].content[1].type).toBe('video_url');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyVideoUrl(Meta's Muse API)"
    );
  });

  it('pins results to the board with announcements', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;

    const pin = card.querySelector('.pin-button') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    clickEl(pin);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });
    expect(
      (card.querySelector('.pin-button') as HTMLButtonElement).getAttribute('aria-pressed')
    ).toBe('true');
    expect(card.querySelector('.pin-button')?.textContent).toBe('savedButton(Oia)');

    const board = document.querySelector('#board-slot') as HTMLElement;

    const items = [...(board.querySelectorAll('li') ?? [])];
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.item-name')?.textContent).toBe('Oia, Greece');
    expect(items[0].querySelector('.item-host')?.textContent).toBe('example.com');
    expect(
      (board.querySelector('.plan-button') as HTMLButtonElement).getAttribute('aria-disabled')
    ).toBe('true');
    clickEl(card.querySelector('.pin-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinDuplicate(Oia)');
    });
    expect(board.querySelectorAll('li')).toHaveLength(1);

    const remove = items[0].querySelector('.remove-button') as HTMLButtonElement;
    clickEl(remove);
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(0);
    });
    expect(
      (card.querySelector('.pin-button') as HTMLButtonElement).getAttribute('aria-pressed')
    ).toBe('false');
  });

  it('restores a removed pin through undo', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');
    clickEl(document.querySelector('#result-slot .pin-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#board-slot li')).not.toBeNull();
    });

    const board = document.querySelector('#board-slot') as HTMLElement;

    clickEl(board.querySelector('li .remove-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(0);
    });
    await waitFor(() => {
      expect(board.querySelector('.notice span')?.textContent).toBe('boardRemoved(Oia)');
    });

    const undo = board.querySelector('.notice button') as HTMLButtonElement;
    expect(undo.textContent).toBe('boardUndo');
    clickEl(undo);
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardRestored(Oia)');
    });
    expect(board.querySelector('.notice')?.hasAttribute('hidden')).toBe(true);
  });

  it('treats an undo after a re-pin as already restored', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');
    clickEl(document.querySelector('#result-slot .pin-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#board-slot li')).not.toBeNull();
    });

    const board = document.querySelector('#board-slot') as HTMLElement;

    clickEl(board.querySelector('li .remove-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(board.querySelector('.notice span')?.textContent).toBe('boardRemoved(Oia)');
    });

    const { pinPlace } = await cover(import('./board_store'));
    const again = await cover(pinPlace({ place: { ...VALID_PLACE }, sourceHost: 'example.com' }));
    expect(again.status).toBe('pinned');

    clickEl(board.querySelector('.notice button') as HTMLButtonElement);
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardRestored(Oia)');
    });
    expect(board.querySelector('.notice')?.hasAttribute('hidden')).toBe(true);
  });

  it('blocks undo on a full board without evicting', async () => {
    await setup();
    await plantKeyAndConsent();

    const { pinPlace } = await cover(import('./board_store'));

    for (let i = 0; i < 24; i++) {
      const out = await cover(
        pinPlace({
          place: { ...VALID_PLACE, placeName: `Place ${i}` },
          sourceHost: 'example.com',
        })
      );
      expect(out.status).toBe('pinned');
    }
    await waitFor(() => {
      expect(document.querySelectorAll('#board-slot li')).toHaveLength(24);
    });

    const board = document.querySelector('#board-slot') as HTMLElement;

    clickEl(board.querySelector('li .remove-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(23);
    });

    const filled = await cover(
      pinPlace({ place: { ...VALID_PLACE, placeName: 'Newest' }, sourceHost: 'example.com' })
    );
    expect(filled.status).toBe('pinned');

    clickEl(board.querySelector('.notice button') as HTMLButtonElement);
    await waitFor(() => {
      expect(board.querySelector('.notice span')?.textContent).toBe('boardUndoFull');
    });
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(24);
    });
    expect(board.textContent).not.toContain('Place 0');
    expect(board.textContent).toContain('Newest');
  });

  it('reorders pins with move up and move down', async () => {
    await setup();
    await plantKeyAndConsent();

    const { listPins, pinPlace } = await cover(import('./board_store'));
    await cover(pinPlace({ place: { ...VALID_PLACE }, sourceHost: 'example.com' }));
    await cover(
      pinPlace({
        place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira' },
        sourceHost: 'example.com',
      })
    );
    await cover(
      pinPlace({
        place: { ...VALID_PLACE, placeName: 'Imerovigli', city: 'Imerovigli' },
        sourceHost: 'example.com',
      })
    );

    const board = document.querySelector('#board-slot') as HTMLElement;

    const names = () => [...board.querySelectorAll('li .item-name')].map((el) => el.textContent);

    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(3);
    });
    expect(names()).toEqual(['Oia, Greece', 'Fira, Greece', 'Imerovigli, Greece']);

    const rows = board.querySelectorAll('li');
    expect((rows[0].querySelector('.move-up-button') as HTMLButtonElement).disabled).toBe(true);
    expect((rows[2].querySelector('.move-down-button') as HTMLButtonElement).disabled).toBe(true);

    const down = rows[0].querySelector('.move-down-button') as HTMLButtonElement;
    focusEl(down);
    clickEl(down);
    await waitFor(() => {
      expect(names()).toEqual(['Fira, Greece', 'Oia, Greece', 'Imerovigli, Greece']);
    });
    expect(document.activeElement?.textContent).toBe('boardMoveDownShort');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('boardMoveDown(Oia)');

    const stored = await cover(listPins());
    expect(stored.map((pin) => pin.place.placeName)).toEqual(['Fira', 'Oia', 'Imerovigli']);
  });

  it('copies the trip from stored state without a provider request', async () => {
    await setup();
    await plantKeyAndConsent();

    const { pinPlace } = await cover(import('./board_store'));
    await cover(pinPlace({ place: { ...VALID_PLACE }, sourceHost: 'example.com' }));
    await cover(
      pinPlace({
        place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira' },
        sourceHost: 'blog.example',
      })
    );
    await waitFor(() => {
      expect(document.querySelectorAll('#board-slot li')).toHaveLength(2);
    });

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    clickEl(document.querySelector('#board-slot .copy-trip-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardCopied');
    });

    expect(writeText).toHaveBeenCalledTimes(1);

    const markdown = writeText.mock.calls[0][0] as string;
    expect(markdown).toContain('**Oia, Greece** - found on example.com');
    expect(markdown).toContain('**Fira, Greece** - found on blog.example');
    expect(markdown).toContain('Open the route in Google Maps');
    expect(markdown).toContain('No itinerary generated yet.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads the trip with a markdown filename', async () => {
    await setup();
    await plantKeyAndConsent();

    const { pinPlace } = await cover(import('./board_store'));
    await cover(pinPlace({ place: { ...VALID_PLACE }, sourceHost: 'example.com' }));
    await waitFor(() => {
      expect(document.querySelectorAll('#board-slot li')).toHaveLength(1);
    });

    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:trip');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    let href = '';
    let download = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      href = this.href;
      download = this.download;
    });

    clickEl(document.querySelector('#board-slot .download-trip-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardDownloaded');
    });

    expect(create).toHaveBeenCalledTimes(1);

    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/markdown');
    expect(await blob.text()).toContain('**Oia, Greece** - found on example.com');
    expect(href).toBe('blob:trip');
    expect(download).toBe('take-me-there-trip.md');
    expect(revoke).toHaveBeenCalledWith('blob:trip');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discloses remote images and falls back to monograms', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');
    clickEl(document.querySelector('#result-slot .pin-button') as HTMLButtonElement);

    const board = document.querySelector('#board-slot') as HTMLElement;
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(1);
    });

    const remote = board.querySelector('li') as HTMLElement;
    expect(remote.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.example.com/oia.jpg'
    );
    expect(remote.querySelector('.item-remote')?.textContent).toBe('boardRemoteImage');

    const { pinPlace } = await cover(import('./board_store'));
    await cover(
      pinPlace({
        place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira' },
        sourceHost: 'blog.example',
      })
    );
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(2);
    });

    const mono = board.querySelectorAll('li')[1] as HTMLElement;
    expect(mono.querySelector('img')).toBeNull();
    expect(mono.querySelector('.thumb-monogram')?.textContent).toBe('F');
    expect(mono.querySelector('.item-remote')).toBeNull();
  });

  it('keeps pins with provenance across a panel restart', async () => {
    const first = await setup();

    const { pinPlace } = await cover(import('./board_store'));
    await cover(pinPlace({ place: { ...VALID_PLACE }, sourceHost: 'example.com' }));
    await cover(
      pinPlace({
        place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira' },
        sourceHost: 'blog.example',
      })
    );
    await waitFor(() => {
      expect(document.querySelectorAll('#board-slot li')).toHaveLength(2);
    });

    const saved = new Map(first.local.data);
    teardownPage();

    await setup((mock) => {
      for (const [key, value] of saved) {
        mock.local.data.set(key, structuredClone(value));
      }
    });

    const board = document.querySelector('#board-slot') as HTMLElement;
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(2);
    });

    const hosts = [...board.querySelectorAll('li .item-host')].map((el) => el.textContent);
    expect(hosts).toEqual(['example.com', 'blog.example']);
  });

  it('reflects another window’s board edits', async () => {
    await setup();

    const { pinPlace, removePin } = await cover(import('./board_store'));

    const board = document.querySelector('#board-slot') as HTMLElement;
    expect(board.querySelectorAll('li')).toHaveLength(0);

    await cover(pinPlace({ place: { ...VALID_PLACE }, sourceHost: 'example.com' }));
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(1);
    });
    expect(board.querySelector('li .item-host')?.textContent).toBe('example.com');

    await cover(removePin('Oia', 'Greece'));
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(0);
    });
  });

  it('views, removes, and exports the board without an API key', async () => {
    await setup();

    const { pinPlace } = await cover(import('./board_store'));
    await cover(pinPlace({ place: { ...VALID_PLACE }, sourceHost: 'example.com' }));
    await cover(
      pinPlace({
        place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira' },
        sourceHost: 'blog.example',
      })
    );

    const board = document.querySelector('#board-slot') as HTMLElement;
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(2);
    });

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    clickEl(board.querySelector('.copy-trip-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardCopied');
    });

    const markdown = writeText.mock.calls[0][0] as string;
    expect(markdown).toContain('**Oia, Greece** - found on example.com');
    expect(markdown).toContain('**Fira, Greece** - found on blog.example');
    expect(markdown).toContain('Open the route in Google Maps');

    clickEl(board.querySelector('li .remove-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(board.querySelector('.notice span')?.textContent).toBe('boardRemoved(Oia)');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('labels the board retry for failed removals', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');
    clickEl(document.querySelector('#result-slot .pin-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#board-slot li')).not.toBeNull();
    });

    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    clickEl(document.querySelector('#board-slot li .remove-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#board-slot .notice button')?.textContent).toBe(
        'boardRetryRemove'
      );
    });
    fail.mockRestore();
  });

  it('retries failed pins without the thumbnail', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.pin-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('alertPinFail(Oia)');
    });

    const board = document.querySelector('#board-slot') as HTMLElement;
    expect(board.querySelector('.notice')?.textContent).toContain('boardNoticePinFail');
    fail.mockRestore();
    selectBoardTab();
    clickEl(board.querySelector('.notice button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });

    const { listPins } = await cover(import('./board_store'));

    const pins = await cover(listPins());
    expect(pins).toHaveLength(1);
    expect(pins[0].thumbnail).toBeUndefined();
  });

  it('clears the board through the inline confirm', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.pin-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });

    const board = document.querySelector('#board-slot') as HTMLElement;
    selectBoardTab();
    clickEl(board.querySelector('.clear-button') as HTMLButtonElement);
    expect(board.querySelector('.confirm-heading')?.textContent).toBe('boardClearTitle(1)');

    const [, cancel] = [
      ...(board.querySelectorAll('.confirm-actions button') ?? []),
    ] as HTMLButtonElement[];
    clickEl(cancel);
    expect(board.querySelectorAll('li')).toHaveLength(1);
    clickEl(board.querySelector('.clear-button') as HTMLButtonElement);

    const [confirm] = [
      ...(board.querySelectorAll('.confirm-actions button') ?? []),
    ] as HTMLButtonElement[];
    clickEl(confirm);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardCleared');
    });
    expect(board.querySelectorAll('li')).toHaveLength(0);
    expect(document.activeElement?.className).toContain('disclosure');
  });

  it('renders the scan skeleton while the harvest is collecting', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          status: 'collecting',
          srcUrl: '',
          signals: undefined,
          scanImages: [],
        }),
      })
    );
    await waitFor(() => {
      const list = document.querySelector('#result-slot');
      expect(list?.querySelector('h2')?.textContent).toBe('scanTitle');
    });

    const list = document.querySelector('#result-slot');

    const grid = list?.querySelector('.skeleton-grid');
    expect(grid?.getAttribute('aria-hidden')).toBe('true');
    expect(grid?.querySelectorAll('.scan-card')).toHaveLength(3);
    expect(grid?.querySelectorAll('.skeleton-block')).toHaveLength(9);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scans the harvest into a paired shortlist', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(
      chatResponse({
        places: [
          { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 1 },
          { placeName: 'Fira', city: 'Fira', country: 'Greece', confidence: 0.8, imageIndex: 9 },
        ],
      })
    );
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: '',
          signals: undefined,
          scanImages: [
            {
              url: 'https://img.example.com/a.jpg',
              caption: '',
              heading: '',
              width: 800,
              height: 600,
            },
            {
              url: 'https://img.example.com/b.jpg',
              caption: '',
              heading: '',
              width: 800,
              height: 600,
            },
          ],
        }),
      })
    );
    await waitFor(() => {
      const list = document.querySelector('#result-slot');
      expect(list?.querySelectorAll('.scan-card')).toHaveLength(2);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('scanFound(2)');

    const list = document.querySelector('#result-slot');

    const cards = list?.querySelectorAll('.scan-card');
    expect(cards?.[0]?.querySelector('img')?.getAttribute('src')).toBe(
      'https://img.example.com/b.jpg'
    );
    expect(cards?.[1]?.querySelector('img')).toBeNull();
    expect(cards?.[1]?.querySelector('.thumb-placeholder')).not.toBeNull();
    expect(cards?.[0]?.querySelector('.pin-button')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyScan(Meta's Muse API)"
    );
  });

  it('ignores handoff records stamped for another window', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '200-2', windowId: 2 }) }));
    await sleep(50);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('#result-slot')?.textContent).toContain('panelIdle');
    expect(document.querySelector('#status-region')?.textContent).toBe('');
    // A leaked run would have fetched and cached: the follow-up uses a
    // distinct image so only a true ignore keeps the total at one.
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ requestId: '200-3', srcUrl: 'https://cdn.example.com/other.jpg' }),
      })
    );
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('delivers a stored record on startup without any storage event', async () => {
    await setup(async (mock) => {
      // The startup chain fires during import and must never observe an
      // unmocked fetch.
      fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
      await plantKeyAndConsent();
      await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '500-1' }) }));
    });
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs handoff records stamped for its own window', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '200-2', windowId: 1 }) }));
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops older sequences even with fresher timestamps', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '10-1', seq: 50 }) }));
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A distinct image with a newer timestamp: if the stale record leaked
    // through, it would miss the cache and fetch instead of being dropped
    // by the sequence guard. Clocks order nothing here.
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          requestId: '9-1',
          seq: 49,
          srcUrl: 'https://cdn.example.com/other.jpg',
          at: Date.now(),
        }),
      })
    );
    await sleep(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('acks accepted handoffs so reopens never replay them', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '200-2' }) }));
    await waitForHeading('Oia');

    await waitFor(() => {
      expect(mock.session.data.has(SLOT)).toBe(false);
    });
  });

  it('drops a superseded identify that resolves after the next run wins', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    let resolveFirst: (value: Response) => void = () => {};

    const gate = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    fetchMock.mockImplementationOnce(() => gate);
    fetchMock.mockResolvedValueOnce(chatResponse(PLACE_B));
    await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '300-1' }) }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          requestId: '300-2',
          srcUrl: 'https://cdn.example.com/fira.jpg',
        }),
      })
    );
    await waitForHeading('Fira');
    resolveFirst(chatResponse(VALID_PLACE));
    await sleep(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector('#result-slot')?.textContent).toContain('Fira');
    expect(document.querySelector('#result-slot')?.textContent).not.toContain('Oia');
  });

  it('moves focus to the new heading when a swap removes the focused control', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '400-1' }) }));
    await waitForHeading('Oia');
    focusEl(document.querySelector('#result-slot .pin-button') as HTMLButtonElement);
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ requestId: '400-2', dataPending: true, srcUrl: '' }),
      })
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(document.querySelector('#result-slot h2'));
    });
  });

  it('drops expired handoffs and clears them', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ requestId: '200-2', at: Date.now() - 11 * 60 * 1000 }),
      })
    );
    await sleep(50);
    expect(fetchMock).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mock.session.data.has(SLOT)).toBe(false);
    });
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ requestId: '200-3', srcUrl: 'https://cdn.example.com/other.jpg' }),
      })
    );
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a retryable error when the handoff fails', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ status: 'error', reason: 'collecting-failed' }),
      })
    );
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('handoffFailedTitle');
    });
    expect(document.querySelector('#result-slot p')?.textContent).toBe('handoffFailedBody');
    expect(document.querySelector('#alert-region')?.textContent).toBe('handoffFailedBody');
    expect(fetchMock).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mock.session.data.has(SLOT)).toBe(false);
    });
  });

  it('never hears records written to another window slot', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(mock.session.set({ 'tripRequest:2': READY({ windowId: 2 }) }));
    await sleep(50);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('#result-slot')?.textContent).toContain('panelIdle');
    expect(document.querySelector('#status-region')?.textContent).toBe('');
  });

  it('identifies image-only when the scrape failed and signals are omitted', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));

    const record = READY({ requestId: '200-2' });
    delete (record as Record<string, unknown>).signals;
    await settleWrite(mock.session.set({ [SLOT]: record }));
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows honest cards for empty harvests and empty results', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ srcUrl: '', signals: undefined, scanImages: [] }),
      })
    );
    await waitForHeading('scanEmptyTitle');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(chatResponse({ places: [] }));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          requestId: '200-2',
          srcUrl: '',
          signals: undefined,
          scanImages: [
            {
              url: 'https://img.example.com/a.jpg',
              caption: '',
              heading: '',
              width: 800,
              height: 600,
            },
          ],
        }),
      })
    );
    await waitForHeading('scanNoneTitle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pins scan cards singly and in bulk', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    const { listPins } = await cover(import('./board_store'));
    fetchMock.mockResolvedValueOnce(
      chatResponse({
        places: [
          { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
          { placeName: 'Fira', city: 'Fira', country: 'Greece', confidence: 0.8, imageIndex: 1 },
        ],
      })
    );
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: '',
          signals: undefined,
          scanImages: [
            {
              url: 'https://img.example.com/a.jpg',
              caption: '',
              heading: '',
              width: 800,
              height: 600,
            },
            {
              url: 'https://img.example.com/b.jpg',
              caption: '',
              heading: '',
              width: 800,
              height: 600,
            },
          ],
        }),
      })
    );
    await waitFor(() => {
      const list = document.querySelector('#result-slot');
      expect(list?.querySelectorAll('.scan-card')).toHaveLength(2);
    });

    const list = document.querySelector('#result-slot') as HTMLElement;

    const cards = list.querySelectorAll('.scan-card');
    clickEl(cards?.[0]?.querySelector('.pin-button') as HTMLButtonElement);
    await waitFor(async () => {
      expect(await cover(listPins())).toHaveLength(1);
    });
    expect((await cover(listPins()))[0]?.imageUrl).toBe('https://img.example.com/a.jpg');
    await waitFor(() => {
      const pressed = document
        .querySelector('#result-slot')
        ?.querySelectorAll('.scan-card')[0]
        ?.querySelector('.pin-button')
        ?.getAttribute('aria-pressed');
      expect(pressed).toBe('true');
    });

    for (const box of list.querySelectorAll('input[type="checkbox"]') ?? []) {
      clickEl(box as HTMLInputElement);
    }
    clickEl(list.querySelector('.pin-selected') as HTMLButtonElement);
    await waitFor(async () => {
      expect(await cover(listPins())).toHaveLength(2);
    });
  });

  it('retries a failed scan from the error card', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 })).mockResolvedValueOnce(
      chatResponse({
        places: [
          { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
        ],
      })
    );
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: '',
          signals: undefined,
          scanImages: [
            {
              url: 'https://img.example.com/a.jpg',
              caption: '',
              heading: '',
              width: 800,
              height: 600,
            },
          ],
        }),
      })
    );
    await waitForHeading('errorServerTitle');

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.primary') as HTMLButtonElement);
    await waitFor(() => {
      const list = document.querySelector('#result-slot');
      expect(list?.querySelectorAll('.scan-card')).toHaveLength(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels hanging alternates and restores the chips', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;

    const chips = [...card.querySelectorAll('.chips-row .chip')] as HTMLButtonElement[];
    expect(chips).toHaveLength(3);
    clickEl(chips[0]);
    await waitFor(() => {
      expect(card.querySelector('.alternates button')?.textContent).toBe('cancelButton');
    });
    clickEl(card.querySelector('.alternates button') as HTMLButtonElement);
    await waitFor(() => {
      expect(card.querySelector('.alternates')?.hasAttribute('hidden')).toBe(true);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
    expect(card.querySelectorAll('.chips-row .chip')).toHaveLength(chips.length);
  });

  it('finds alternates for an intent', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE)).mockResolvedValueOnce(
      groundedResponse({
        alternatives: [
          {
            placeName: 'Fira',
            country: 'Greece',
            why: 'Same caldera, lower prices.',
            bestMonth: 'May',
          },
          { placeName: 'Naxos', country: 'Greece', why: 'Quiet beaches.', bestMonth: 'June' },
        ],
      })
    );
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;

    const chips = card.querySelectorAll('.chips-row .chip');
    expect(chips).toHaveLength(3);
    clickEl(chips?.[0] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('alternatesReady(2)');
    });

    const fresh = document.querySelector('#result-slot') as HTMLElement;
    expect(fresh.querySelectorAll('.alternate-card')).toHaveLength(2);
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyNames(Meta's Muse API)"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('finds alternates over plain chat in cheap mode', async () => {
    const mock = await setup(async (seed) => {
      await settleWrite(seed.local.set({ settings: { v: 1, settings: { skipWebSearch: true } } }));
    });
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE)).mockResolvedValueOnce(
      chatResponse({
        alternatives: [
          {
            placeName: 'Fira',
            country: 'Greece',
            why: 'Same caldera, lower prices.',
            bestMonth: 'May',
          },
        ],
      })
    );
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.chips-row .chip') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('alternatesReady(1)');
    });

    const [altUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(altUrl).toContain('/chat/completions');
  });

  it('pins alternates to the board with a monogram tile', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE)).mockResolvedValueOnce(
      groundedResponse({
        alternatives: [
          {
            placeName: 'Fira',
            country: 'Greece',
            why: 'Same caldera, lower prices.',
            bestMonth: 'May',
          },
        ],
      })
    );
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.chips-row .chip') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('alternatesReady(1)');
    });

    const fresh = document.querySelector('#result-slot') as HTMLElement;

    const pin = fresh.querySelector('.alternate-card .pin-button') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(fresh.querySelector('.alternate-card .thumb-monogram')?.textContent).toBe('F');
    clickEl(pin);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Fira | 1)');
    });

    const board = document.querySelector('#board-slot') as HTMLElement;

    const entries = board.querySelectorAll('li');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.querySelector('.item-name')?.textContent).toContain('Fira');
    expect(entries[0]?.querySelector('.thumb-monogram')?.textContent).toBe('F');

    const synced = document.querySelector('#result-slot') as HTMLElement;
    expect(synced.querySelector('.alternate-card .pin-button')?.getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('recovers from alternates failure with chips intact', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.chips-row .chip') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('alternatesFail');
    });

    const fresh = document.querySelector('#result-slot') as HTMLElement;
    expect(fresh.querySelector('h2')?.textContent).toBe('Oia');
    expect(fresh.querySelectorAll('.chips-row .chip')).toHaveLength(3);
    expect(fresh.querySelector('.chip[aria-disabled]')).toBeNull();
    expect(fresh.querySelector('.alternates-skeletons')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('identifies from page text when the image cannot load', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toContain('Oia');
    });

    const card = document.querySelector('#result-slot') as HTMLElement;
    expect(card.querySelector('h2 .badge')?.textContent).toBe('bestGuessBadge');
    expect(card.querySelector('#fetch-retry-button')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries an image-400 with downloaded bytes', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    const permsRequest = vi.fn().mockResolvedValue(true);

    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['fakejpeg']),
        };
      })
    );
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      )
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      const retried = document.querySelector('#result-slot');
      expect(retried?.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyImagePixels(Meta's Muse API)"
    );
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2][0]).toBe('https://cdn.example.com/oia.jpg');
    const retryInit = fetchMock.mock.calls[3][1] as RequestInit;
    const retryBody = JSON.parse(retryInit.body as string) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = retryBody.messages[1].content.find((part) => part.type === 'image_url');
    expect(imagePart?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('shows token counts without dollar figures for custom servers', async () => {
    const mock = await setup(async (seed) => {
      await settleWrite(
        seed.local.set({
          settings: {
            v: 1,
            settings: {
              activeProviderId: 'openai_compat',
              openaiCompat: {
                baseURL: 'https://llm.example.com/v1',
                model: 'test-model',
              },
              imageOnly: false,
              sessionOnly: false,
              skipWebSearch: false,
            },
          },
        })
      );
    });
    const { saveKey } = await cover(import('./key_vault'));
    await settleWrite(saveKey('openai_compat', 'sk_x', false));
    await plantKeyAndConsent();

    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');
    expect(document.querySelector('#settings-run-line')?.textContent).toBe(
      'costLineTokens(100 | 50)'
    );
  });

  it('keeps the provider grant when the image origin is the provider origin', async () => {
    const mock = await setup(async (seed) => {
      await settleWrite(
        seed.local.set({
          settings: {
            v: 1,
            settings: {
              activeProviderId: 'openai_compat',
              openaiCompat: {
                baseURL: 'https://cdn.example.com/v1',
                model: 'test-model',
              },
              imageOnly: false,
              sessionOnly: false,
              skipWebSearch: false,
            },
          },
        })
      );
    });
    const { saveKey } = await cover(import('./key_vault'));
    await settleWrite(saveKey('openai_compat', 'sk_x', false));
    await plantKeyAndConsent();

    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['fakejpeg']),
        };
      })
    );
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      )
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('Oia');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(permsRemove).not.toHaveBeenCalled();
  });

  it('fetches retry bytes in the tab without a permission prompt', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    mock.worker.scriptingImpl = async () => [
      { result: { ok: true, dataUrl: 'data:image/jpeg;base64,/9j/4AA=' } },
    ];

    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['fakejpeg']),
        };
      })
    );
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('Oia');
    });
    expect(permsRequest).not.toHaveBeenCalled();
    expect(permsRemove).not.toHaveBeenCalled();
    expect(mock.worker.scriptingCalls).toHaveLength(1);
    expect(mock.worker.scriptingCalls[0].target).toEqual({ tabId: 7, frameIds: [0] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('removes the origin grant when the byte fetch fails', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockRejectedValueOnce(new Error('network down'));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('fetchFailed');
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('errorServerTitle');
    });
    expect(document.querySelector('#result-slot')?.querySelectorAll('button')).toHaveLength(1);
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
  });

  it('fetches loopback http images without an origin grant', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['fakejpeg']),
        };
      })
    );
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      )
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ srcUrl: 'http://localhost:8000/oia.jpg' }),
      })
    );
    await waitFor(() => {
      expect(document.querySelector('#result-slot')?.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(permsRequest).not.toHaveBeenCalled();
    expect(permsRemove).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8000/oia.jpg');
  });

  it('announces denial and shows a single retry on non-400 errors', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(false);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    fetchMock
      .mockResolvedValueOnce(new Response('bad image', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('fetchDenied');
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('errorServerTitle');
    });
    expect(document.querySelector('#result-slot')?.querySelectorAll('button')).toHaveLength(1);
    expect(permsRemove).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '200-2' }) }));
    await waitFor(() => {
      const retry = document.querySelector('#result-slot');
      expect(retry?.querySelector('h2')?.textContent).toBe('errorServerTitle');
      expect(retry?.querySelectorAll('button')).toHaveLength(1);
    });
  });

  it('looks again through a SAM crop', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['pixels']),
        };
      })
    );
    const GUESS = { ...VALID_PLACE, confidence: 0.2 };
    fetchMock
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Crop <|box;x1=100;y1=100;x2=600;y2=500;w=1000;h=1000|> here.',
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 900, output_tokens: 40 },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('noPlaceTitle');
    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.primary') as HTMLButtonElement);
    await waitFor(() => {
      expect(card.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const samUrl = fetchMock.mock.calls[2][0] as string;
    expect(samUrl).toContain('/responses');
    const samInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(samInit.body as string) as { model: string }).toMatchObject({
      model: 'sam-3.1',
    });
    const retryInit = fetchMock.mock.calls[3][1] as RequestInit;
    const retryBody = JSON.parse(retryInit.body as string) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = retryBody.messages[1].content.find((part) => part.type === 'image_url');
    expect(imagePart?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    const preview = document.querySelector('#preview-frame img') as HTMLImageElement;
    expect(preview.src.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(preview.alt).toBe('previewAltIdentified(Oia)');
    expect(document.querySelector('.preview-caption')?.textContent).toBe('samZoomCaption');
  });

  it('falls back to the full image when SAM fails or finds nothing', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const permsRequest = vi.fn().mockResolvedValue(true);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['pixels']),
        };
      })
    );
    const GUESS = { ...VALID_PLACE, confidence: 0.2 };
    const samEmpty = new Response(
      JSON.stringify({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '', annotations: [] }] },
        ],
        usage: { input_tokens: 900, output_tokens: 5 },
      }),
      { status: 200 }
    );
    fetchMock
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      )
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      )
      .mockResolvedValueOnce(samEmpty)
      .mockResolvedValueOnce(chatResponse(VALID_PLACE));
    const imageOf = (callIndex: number): string | undefined => {
      const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
      };
      return body.messages[1].content.find((part) => part.type === 'image_url')?.image_url?.url;
    };
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('noPlaceTitle');
    let card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.primary') as HTMLButtonElement);
    await waitFor(() => {
      expect(card.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(imageOf(3)).toBe('https://cdn.example.com/oia.jpg');
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ requestId: '200-2', srcUrl: 'https://cdn.example.com/fira.jpg' }),
      })
    );
    await waitFor(() => {
      const retry = document.querySelector('#result-slot');
      expect(retry?.querySelector('h2')?.textContent).toBe('noPlaceTitle');
    });
    card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.primary') as HTMLButtonElement);
    await waitFor(() => {
      expect(card.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(imageOf(7)).toBe('https://cdn.example.com/fira.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('renders honest cards with fallback links for unreadable video', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'blob:https://example.com/aaa',
          mediaType: 'video',
          frameError: 'drm',
        }),
      })
    );
    await waitForHeading('errorVideoTitle');
    expect(document.querySelector('#alert-region')?.textContent).toBe('alertVideoUnreadable');
    expect(fetchMock).not.toHaveBeenCalled();
    const card = document.querySelector('#result-slot');
    expect(card?.querySelector('.fallback a')).not.toBeNull();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          requestId: '300-3',
          srcUrl: 'blob:https://example.com/bbb',
          mediaType: 'video',
          frameError: 'no-match',
        }),
      })
    );
    await waitFor(() => {
      const retry = document.querySelector('#result-slot');
      expect(retry?.querySelector('h2')?.textContent).toBe('errorVideoMatchTitle');
    });
  });

  it('persists search modes from the settings tab', async () => {
    const mock = await setup();
    selectSettingsTab();
    await waitForSettings();

    const box = document.querySelector('#image-only') as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    dispatchEl(box, new Event('change', { bubbles: true }));

    await waitFor(() => {
      const record = mock.local.data.get('settings') as { settings: { imageOnly: boolean } };

      expect(record.settings.imageOnly).toBe(true);
    });

    const skip = document.querySelector('#skip-search') as HTMLInputElement;
    skip.checked = true;
    dispatchEl(skip, new Event('change', { bubbles: true }));

    await waitFor(() => {
      const record = mock.local.data.get('settings') as {
        settings: { skipWebSearch: boolean };
      };

      expect(record.settings.skipWebSearch).toBe(true);
    });
  });

  it('reports settings save failures from the settings tab', async () => {
    const mock = await setup();
    selectSettingsTab();
    await waitForSettings();

    mock.local.fault = (op) => {
      if (op === 'set') {
        throw new Error('quota');
      }
    };

    const box = document.querySelector('#image-only') as HTMLInputElement;
    box.checked = true;
    dispatchEl(box, new Event('change', { bubbles: true }));

    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('settingsSaveFailed');
    });
    expect(box.checked).toBe(false);

    mock.local.fault = () => undefined;
  });

  it('saves a custom server from the settings tab and switches back', async () => {
    const mock = await setup();
    selectSettingsTab();
    await waitForSettings();

    const permsRequest = vi.fn().mockResolvedValue(true);
    const permsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: permsRequest,
      remove: permsRemove,
    };

    const compat = document.querySelector('#provider-compat') as HTMLInputElement;
    compat.checked = true;
    dispatchEl(compat, new Event('change', { bubbles: true }));
    expect(document.querySelector('#compat-fields')?.hasAttribute('hidden')).toBe(false);

    (document.querySelector('#compat-base-url') as HTMLInputElement).value =
      'https://llm.example.com/v1';
    (document.querySelector('#compat-model') as HTMLInputElement).value = 'test-model';
    clickEl(document.querySelector('#compat-save') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#compat-error')?.textContent).toBe(
        'compatHostWarning(llm.example.com)'
      );
    });

    clickEl(document.querySelector('#compat-save') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusProviderSaved');
    });

    const stored = mock.local.data.get('settings') as {
      settings: { activeProviderId: string };
    };
    expect(stored.settings.activeProviderId).toBe('openai_compat');
    expect(document.querySelector('#compat-error')?.hasAttribute('hidden')).toBe(true);

    const muse = document.querySelector('#provider-muse') as HTMLInputElement;
    muse.checked = true;
    dispatchEl(muse, new Event('change', { bubbles: true }));

    await waitFor(() => {
      const record = mock.local.data.get('settings') as {
        settings: { activeProviderId: string };
      };

      expect(record.settings.activeProviderId).toBe('muse');
    });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://llm.example.com/*'] });
    expect(document.querySelector('#compat-fields')?.hasAttribute('hidden')).toBe(true);
  });

  it('resets the monthly cost from the settings tab', async () => {
    const mock = await setup(async (inner) => {
      await settleWrite(inner.local.set({ costTotals: { [monthKey()]: 2.5 } }));
    });
    selectSettingsTab();

    await waitFor(() => {
      expect(document.querySelector('#settings-cost-line')?.textContent).toBe(
        'optionsCostMonth($2.50)'
      );
    });

    clickEl(document.querySelector('#settings-reset-cost') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#settings-cost-line')?.textContent).toBe(
        'optionsCostMonth($0.00)'
      );
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusMonthlyReset');
    expect(mock.local.data.get('costTotals')).toEqual({ v: 1, months: {} });
  });

  it('re-announces a repeated status', async () => {
    await setup();
    selectSettingsTab();
    await waitForSettings();

    const reset = document.querySelector('#settings-reset-cost') as HTMLButtonElement;
    clickEl(reset);

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusMonthlyReset');
    });

    const first = document.querySelector('#status-region span');
    clickEl(reset);

    await waitFor(() => {
      expect(document.querySelector('#status-region span')).not.toBe(first);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusMonthlyReset');
  });

  it('names the custom server in the video confirm', async () => {
    const mock = await setup();
    const { saveSettings } = await cover(import('./providers/index'));
    const { saveKey } = await cover(import('./key_vault'));
    const { setConsented } = await cover(import('./providers/index'));
    await settleWrite(
      saveSettings({
        activeProviderId: 'openai_compat',
        openaiCompat: {
          baseURL: 'https://llm.example.com/v1',
          model: 'm',
        },
        imageOnly: false,
        sessionOnly: false,
        skipWebSearch: false,
        cacheTtlDays: 7,
      })
    );
    await settleWrite(saveKey('openai_compat', 'LLM_x', false));
    await settleWrite(setConsented());

    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'blob:https://example.com/aaa',
          mediaType: 'video',
          frame: { dataUrl: 'data:image/jpeg;base64,ZnJhbWU=', time: 12.5 },
        }),
      })
    );

    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('videoConfirmTitle');
    });

    const paragraphs = [...document.querySelectorAll('#result-slot p')].map((p) => p.textContent);
    expect(paragraphs).toContain('videoConfirmBodyCustom(llm.example.com)');
    expect(paragraphs).not.toContain('videoConfirmImageOnly');
  });

  it('explains image-only implications in the video confirm', async () => {
    const mock = await setup();
    const { saveSettings } = await cover(import('./providers/index'));
    await settleWrite(
      saveSettings({
        activeProviderId: 'muse',
        openaiCompat: { baseURL: '', model: '' },
        imageOnly: true,
        sessionOnly: false,
        skipWebSearch: false,
        cacheTtlDays: 7,
      })
    );
    await plantKeyAndConsent();

    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'blob:https://example.com/aaa',
          mediaType: 'video',
          frame: { dataUrl: 'data:image/jpeg;base64,ZnJhbWU=', time: 12.5 },
        }),
      })
    );

    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('videoConfirmTitle');
    });

    const paragraphs = [...document.querySelectorAll('#result-slot p')].map((p) => p.textContent);
    expect(paragraphs).toContain('videoConfirmImageOnly');

    clickEl(document.querySelector('#result-slot .confirm-actions .primary') as HTMLButtonElement);
    await waitForHeading('Oia');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyVideoFrameOnly(Meta's Muse API)"
    );
  });

  it('discloses the full-video payload when the frame is missing', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: 'https://cdn.example.com/v.mp4',
          mediaType: 'video',
        }),
      })
    );

    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('videoConfirmTitle');
    });

    const paragraphs = [...document.querySelectorAll('#result-slot p')].map((p) => p.textContent);
    expect(paragraphs).toContain('videoConfirmBody');
    expect(paragraphs).toContain('videoConfirmRung2Note');

    clickEl(document.querySelector('#result-slot .confirm-actions .primary') as HTMLButtonElement);
    await waitForHeading('Oia');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyVideoUrl(Meta's Muse API)"
    );
  });

  it('cancels a hanging identify from the loading card', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    hangUntilAbort();
    await settleWrite(mock.session.set({ [SLOT]: READY() }));

    await waitFor(() => {
      expect(document.querySelector('#result-slot .cancel-button')?.textContent).toBe(
        'cancelButton'
      );
    });
    expect(document.querySelector('#result-slot .cosmetic')?.textContent).toBe(
      'loadingPhaseIdentifying'
    );

    clickEl(document.querySelector('#result-slot .cancel-button') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
    });
    expect(document.querySelector('#result-slot .hint')?.textContent).toBe('panelIdle');
  });

  it('shows a loading state while analyzing again', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    hangUntilAbort();

    const again = [...document.querySelectorAll('#result-slot button')].find(
      (button) => button.textContent === 'reanalyzeButton'
    ) as HTMLButtonElement;
    clickEl(again);

    await waitFor(() => {
      expect(document.querySelector('#result-slot .cancel-button')?.textContent).toBe(
        'cancelButton'
      );
    });
    expect(document.querySelector('#result-slot .cosmetic')?.textContent).toBe(
      'loadingPhaseIdentifying'
    );

    clickEl(document.querySelector('#result-slot .cancel-button') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
    });
    expect(document.querySelector('#result-slot .hint')?.textContent).toBe('panelIdle');
  });

  it('shows a loading state while looking again', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    (chrome as unknown as { permissions: unknown }).permissions = {
      request: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return {
          getContext: () => ({ drawImage: vi.fn() }),
          convertToBlob: async () => new Blob(['pixels']),
        };
      })
    );
    const GUESS = { ...VALID_PLACE, confidence: 0.2 };
    fetchMock
      .mockResolvedValueOnce(chatResponse(GUESS))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Crop <|box;x1=100;y1=100;x2=600;y2=500;w=1000;h=1000|> here.',
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 900, output_tokens: 40 },
          }),
          { status: 200 }
        )
      );
    hangUntilAbort();
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('noPlaceTitle');

    clickEl(document.querySelector('#result-slot .primary') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#result-slot .cancel-button')?.textContent).toBe(
        'cancelButton'
      );
    });
    expect(document.querySelector('#result-slot .cosmetic')?.textContent).toBe(
      'loadingPhaseIdentifying'
    );

    clickEl(document.querySelector('#result-slot .cancel-button') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
    });
    expect(document.querySelector('#result-slot .hint')?.textContent).toBe('panelIdle');
  });

  it('cancels a hanging itinerary from the loading card', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    const FIRA = { ...VALID_PLACE, placeName: 'Fira', city: 'Fira' };
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(chatResponse(FIRA));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.pin-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          requestId: '200-2',
          srcUrl: 'https://cdn.example.com/fira.jpg',
        }),
      })
    );
    await waitFor(() => {
      expect(card.querySelector('h2')?.textContent).toBe('Fira');
    });
    clickEl(card.querySelector('.pin-button') as HTMLButtonElement);
    await waitFor(() => {
      const board = document.querySelector('#board-slot') as HTMLElement;
      expect(board.querySelectorAll('li')).toHaveLength(2);
    });

    hangUntilAbort();
    clickEl(document.querySelector('#board-slot .plan-button') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#result-slot .cancel-button')?.textContent).toBe(
        'cancelButton'
      );
    });
    expect(document.querySelector('#result-slot .cosmetic')?.textContent).toBe(
      'loadingPhaseWriting'
    );

    clickEl(document.querySelector('#result-slot .cancel-button') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
    });
    expect(document.querySelector('#result-slot .hint')?.textContent).toBe('panelIdle');
  });

  it('cancels a hanging scan from the scan skeleton', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    hangUntilAbort();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: '',
          signals: undefined,
          scanImages: [
            {
              url: 'https://img.example.com/a.jpg',
              caption: '',
              heading: '',
              width: 800,
              height: 600,
            },
          ],
        }),
      })
    );

    await waitFor(() => {
      expect(document.querySelector('#result-slot section > button')?.textContent).toBe(
        'cancelButton'
      );
    });

    clickEl(document.querySelector('#result-slot section > button') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
    });
    expect(document.querySelector('#result-slot .hint')?.textContent).toBe('panelIdle');
  });

  it('drops the type-a-destination instruction and prices retries honestly', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse({ ...VALID_PLACE, confidence: 0.1 }));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));

    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('noPlaceTitle');
    });
    expect(document.querySelector('#result-slot p')?.textContent).toBe('noPlaceBody');

    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<
      string,
      { message: string }
    >;
    expect(catalog.noPlaceBody.message).not.toContain('type a destination');
    expect(catalog.noPlaceBody.message).toContain('paid analysis');
  });

  it('shows confidence, source, and the save action', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;
    expect(card.querySelector('.confidence')?.textContent).toBe(
      'confidenceLine(confidenceHigh | 0.90)'
    );
    expect(card.querySelector('.confidence-scale')?.textContent).toBe('confidenceScale');
    expect(card.querySelector('.source')?.textContent).toBe('sourceLine(example.com)');
    expect(card.querySelector('.pin-button')?.textContent).toBe('pinButton(Oia)');
    expect(card.querySelector('section.secondary')).not.toBeNull();

    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<
      string,
      { message: string }
    >;
    expect(catalog.pinButton.message).toBe('Save $1 to trip');
  });

  it('marks scan pins saved with pressed state', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(
      chatResponse({
        places: [
          { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
        ],
      })
    );
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          srcUrl: '',
          signals: undefined,
          scanImages: [
            {
              url: 'https://img.example.com/a.jpg',
              caption: '',
              heading: '',
              width: 800,
              height: 600,
            },
          ],
        }),
      })
    );
    await waitFor(() => {
      expect(document.querySelectorAll('#result-slot .scan-card')).toHaveLength(1);
    });

    const pin = document.querySelector('#result-slot .scan-card .pin-button') as HTMLButtonElement;
    expect(pin.textContent).toBe('pinButton(Oia)');
    clickEl(pin);

    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });

    const saved = document.querySelector(
      '#result-slot .scan-card .pin-button'
    ) as HTMLButtonElement;
    expect(saved.textContent).toBe('savedButton(Oia)');
    expect(saved.getAttribute('aria-pressed')).toBe('true');
    expect(saved.disabled).toBe(true);
  });

  it('retries an empty scan from the error card', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse({ places: [] })).mockResolvedValueOnce(
      chatResponse({
        places: [
          { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
        ],
      })
    );
    const record = {
      srcUrl: '',
      signals: undefined,
      scanImages: [
        {
          url: 'https://img.example.com/a.jpg',
          caption: '',
          heading: '',
          width: 800,
          height: 600,
        },
      ],
    };
    await settleWrite(mock.session.set({ [SLOT]: READY(record) }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('scanNoneTitle');
    });

    clickEl(document.querySelector('#result-slot button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelectorAll('#result-slot .scan-card')).toHaveLength(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dismisses dead-end errors back to idle', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({ status: 'error', reason: 'collecting-failed' }),
      })
    );
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('handoffFailedTitle');
    });

    const dismiss = document.querySelector('#result-slot button') as HTMLButtonElement;
    expect(dismiss.textContent).toBe('dismissErrorButton');
    clickEl(dismiss);

    await waitFor(() => {
      expect(document.querySelector('#result-slot .hint')?.textContent).toBe('panelIdle');
    });
  });

  it('falls back to the preview heading after headingless loading', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    focusEl(document.querySelector('#result-slot .pin-button') as HTMLButtonElement);
    expect(document.activeElement?.className).toContain('pin-button');

    hangUntilAbort();
    await settleWrite(
      mock.session.set({
        [SLOT]: READY({
          requestId: '200-2',
          srcUrl: 'https://cdn.example.com/fira.jpg',
        }),
      })
    );

    await waitFor(() => {
      expect(document.activeElement?.id).toBe('preview-heading');
    });

    clickEl(document.querySelector('#result-slot .cancel-button') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
    });
  });

  it('keeps every result action keyboard-operable', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    const { pinPlace } = await cover(import('./board_store'));
    await settleWrite(
      pinPlace({
        place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
        sourceHost: 'example.com',
      })
    );
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE)).mockResolvedValueOnce(
      groundedResponse({
        alternatives: [
          {
            placeName: 'Fira',
            country: 'Greece',
            why: 'Same caldera, lower prices.',
            bestMonth: 'May',
          },
        ],
      })
    );
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelector('.chips-row .chip') as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('alternatesReady(1)');
    });

    const fresh = document.querySelector('#result-slot') as HTMLElement;
    const controls = [...fresh.querySelectorAll('button, select, input, a[href]')];
    expect(controls.length).toBeGreaterThan(5);

    for (const control of controls) {
      expect((control as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
    }

    expect(fresh.querySelectorAll('[role="button"]')).toHaveLength(0);
    expect((controls[0] as HTMLElement).className).toContain('pin-button');

    const pin = fresh.querySelector('.pin-button') as HTMLButtonElement;
    focusEl(pin);
    expect(document.activeElement).toBe(pin);
  });
});
