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

import type { ChromeMock } from './test/chrome_mock';
import {
  chatResponse,
  clickEl,
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

// Rejects on abort, like a real fetch.
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
  });

  it('keeps every Explore section visible with empty states', async () => {
    await setup();
    expect(document.querySelector('#links-heading')?.textContent).toBe('linksHeading');
    expect(document.querySelector('#links-slot .slot-empty')?.textContent).toBe('linksEmpty');
    expect(document.querySelector('#links-slot')?.className).toContain('panel-card');
  });

  it('keeps settings in key, modes, and cost cards', async () => {
    await setup();
    await waitForSettings();
    expect(document.querySelector('#main-panel #modes-heading')).toBeNull();
    expect(document.querySelector('#settings-panel #modes-heading')?.textContent).toBe(
      'settingsModesHeading'
    );
    expect(document.querySelectorAll('#settings-panel .panel-card')).toHaveLength(3);
    expect(document.querySelector('#settings-panel #settings-cost-heading')).not.toBeNull();
    expect(document.querySelector('#settings-panel #retention-select')).toBeNull();
    expect(document.querySelector('#page-footer #privacy-line')).not.toBeNull();
    expect(document.querySelector('#page-footer #settings-run-line')).toBeNull();
  });

  it('switches tabs with roving focus and surfaces runs', async () => {
    const mock = await setup();

    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;

    const tabSettings = document.querySelector('#tab-settings') as HTMLButtonElement;
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    expect(tabMain.hasAttribute('aria-disabled')).toBe(false);
    await plantKeyAndConsent();
    clickEl(tabMain);

    expect(tabMain.textContent).toBe('mainTab');
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    expect(tabMain.tabIndex).toBe(0);
    expect(tabSettings.getAttribute('aria-selected')).toBe('false');
    expect(tabSettings.tabIndex).toBe(-1);
    expect(document.querySelector('#tab-bar')?.getAttribute('aria-label')).toBe('tabsLabel');
    expect(document.querySelector('#main-panel')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#settings-panel')?.hasAttribute('hidden')).toBe(true);
    clickEl(tabSettings);
    expect(tabSettings.getAttribute('aria-selected')).toBe('true');
    expect(tabSettings.tabIndex).toBe(0);
    expect(tabMain.tabIndex).toBe(-1);
    expect(document.querySelector('#main-panel')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#settings-panel')?.hasAttribute('hidden')).toBe(false);
    focusEl(tabMain);
    dispatchEl(tabMain, new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabSettings);
    expect(tabSettings.getAttribute('aria-selected')).toBe('true');
    dispatchEl(tabSettings, new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabMain);
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    clickEl(tabSettings);
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('Oia');
    });
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps Explore available without a key', async () => {
    await setup();

    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;

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
    expect(document.activeElement).toBe(tabSettings);
    dispatchEl(tabSettings, new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(tabSettings);
    dispatchEl(tabSettings, new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabMain);
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
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

    const { loadKey } = await settleWrite(import('./key_vault'));
    expect(await settleWrite(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_new' });
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

    const { loadKey } = await settleWrite(import('./key_vault'));
    expect((await settleWrite(loadKey('muse'))).state).toBe('missing');
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

    const { loadSettings } = await settleWrite(import('./providers/index'));
    expect((await settleWrite(loadSettings())).sessionOnly).toBe(false);
    fail.mockRestore();

    const retry = document.querySelector('#settings-panel #session-only') as HTMLInputElement;
    retry.checked = true;
    dispatchEl(retry, new Event('change', { bubbles: true }));
    await waitFor(async () => {
      expect((await settleWrite(loadSettings())).sessionOnly).toBe(true);
    });
    expect(
      (document.querySelector('#settings-panel #session-only') as HTMLInputElement).checked
    ).toBe(true);
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-error')?.hasAttribute('hidden')).toBe(
        true
      );
    });
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

    const { loadKey } = await settleWrite(import('./key_vault'));
    expect(await settleWrite(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_x' });
    expect(mock.local.data.has('apiKey:muse')).toBe(true);
    expect(mock.session.data.has('apiKey:muse')).toBe(false);

    const { loadSettings } = await settleWrite(import('./providers/index'));
    expect((await settleWrite(loadSettings())).sessionOnly).toBe(false);
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

    const { loadKey } = await settleWrite(import('./key_vault'));
    expect(await settleWrite(loadKey('muse'))).toEqual({ state: 'ok', key: 'LLM_x' });
    expect(document.querySelector('#key-saved-status')).not.toBeNull();
  });

  it('keeps live regions outside tabpanels and announces key failures', async () => {
    await setup();
    expect(document.querySelector('main > #status-region')).not.toBeNull();
    expect(document.querySelector('main > #alert-region')).not.toBeNull();
    expect(document.querySelector('#main-panel #status-region')).toBeNull();
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
    expect(shells[0]).toContain('<title>Take me there</title>');
    expect(shells[1]).toContain('<title>Take me there - Options</title>');
    expect(shells[2]).toContain('<title>Welcome to Take me there</title>');
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

    const { hashIdentifyKey, setCacheEntry } = await settleWrite(import('./result_cache'));

    const identify = await settleWrite(
      hashIdentifyKey({
        mediaSeed: 'https://cdn.example.com/oia.jpg',
        pageUrl: 'https://example.com/guide',
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
      expect(document.querySelector('#settings-run-line')?.textContent).toBe('costLine($0.00)');
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

    const { monthKey } = await settleWrite(import('./pricing'));

    await waitFor(() => {
      const record = mock.local.data.get('costTotals') as {
        v: number;
        months: Record<string, number>;
      };
      expect(record.v).toBe(1);
      expect(record.months[monthKey(new Date())]).toBeCloseTo(0.0003375, 10);
    });
  });

  it('gates cached low-confidence guesses behind the no-place card', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse({ ...VALID_PLACE, confidence: 0.2 }));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('noPlaceTitle');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('noPlaceTitle');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('charges repeat alternates in the monthly total', async () => {
    const mock = await setup();
    await plantKeyAndConsent();

    const batch = groundedResponse({
      alternatives: [
        { placeName: 'Fira', country: 'Greece', why: 'Same caldera.', bestMonth: 'May' },
      ],
    });
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(
        groundedResponse({
          alternatives: [
            { placeName: 'Naxos', country: 'Greece', why: 'Quiet beaches.', bestMonth: 'June' },
          ],
        })
      );
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');

    const card = document.querySelector('#result-slot') as HTMLElement;
    clickEl(card.querySelectorAll('.chips-row .chip')[0] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('alternatesReady(1)');
    });

    const fresh = document.querySelector('#result-slot') as HTMLElement;
    clickEl(fresh.querySelectorAll('.chips-row .chip')[1] as HTMLButtonElement);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    const { monthKey } = await settleWrite(import('./pricing'));

    await waitFor(() => {
      const record = mock.local.data.get('costTotals') as {
        v: number;
        months: Record<string, number>;
      };
      // Identify plus two grounded alternates (tokens plus one search each).
      expect(record.months[monthKey(new Date())]).toBeCloseTo(0.0065175, 10);
    });
  });

  it('keeps the consent gate for re-click when the flag write fails', async () => {
    const mock = await setup();

    const { saveKey } = await settleWrite(import('./key_vault'));
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

    const { saveKey } = await settleWrite(import('./key_vault'));
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

    const { saveKey } = await settleWrite(import('./key_vault'));

    const { hasConsented } = await settleWrite(import('./providers/index'));
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
    expect(await settleWrite(hasConsented())).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves consent unset when declined', async () => {
    const mock = await setup();

    const { saveKey } = await settleWrite(import('./key_vault'));

    const { hasConsented } = await settleWrite(import('./providers/index'));
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
    expect(await settleWrite(hasConsented())).toBe(false);
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

    const { setVideoConsented } = await settleWrite(import('./video'));
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

  it('ignores handoff records stamped for another window', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await settleWrite(mock.session.set({ [SLOT]: READY({ requestId: '200-2', windowId: 2 }) }));
    await sleep(50);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('#result-slot')?.textContent).toContain('panelIdle');
    expect(document.querySelector('#status-region')?.textContent).toBe('');
    // A distinct image, so only a true ignore keeps the total at one.
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
      // The startup chain must never observe an unmocked fetch.
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
    // Newer timestamp on purpose: clocks order nothing here.
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
    focusEl(document.querySelector('#result-slot .chips-row .chip') as HTMLButtonElement);
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
      expect(card.querySelector('.alternates')).toBeNull();
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

  it('re-announces a repeated status', async () => {
    const mock = await setup();

    const { saveKey } = await settleWrite(import('./key_vault'));
    await settleWrite(saveKey('muse', 'LLM_x', false));

    const declineConsent = async (): Promise<void> => {
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
    };

    await declineConsent();

    const first = document.querySelector('#status-region span');
    await declineConsent();

    await waitFor(() => {
      expect(document.querySelector('#status-region span')).not.toBe(first);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusConsentDeclined');
  });

  it('explains image-only implications in the video confirm', async () => {
    const mock = await setup();
    const { saveSettings } = await settleWrite(import('./providers/index'));
    await settleWrite(
      saveSettings({
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

  it('shows confidence and source', async () => {
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
    expect(card.querySelector('section.secondary')).not.toBeNull();
  });

  it('shows booking tiles for the identified place', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await settleWrite(mock.session.set({ [SLOT]: READY() }));
    await waitForHeading('Oia');
    await waitFor(() => {
      expect(document.querySelectorAll('#links-slot a.tile')).toHaveLength(2);
    });
    const tiles = document.querySelectorAll('#links-slot a.tile');
    expect((tiles[0] as HTMLAnchorElement).href).toContain(encodeURIComponent('Oia, Greece'));
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

    const chip = document.querySelector('#result-slot .chips-row .chip') as HTMLButtonElement;
    focusEl(chip);
    expect(document.activeElement).toBe(chip);

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
    expect(controls.length).toBeGreaterThan(3);

    for (const control of controls) {
      expect((control as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
    }

    expect(fresh.querySelectorAll('[role="button"]')).toHaveLength(0);
    expect((controls[0] as HTMLElement).textContent).toBe('reanalyzeButton');

    const chip = fresh.querySelector('.chips-row .chip') as HTMLButtonElement;
    focusEl(chip);
    expect(document.activeElement).toBe(chip);
  });
});
