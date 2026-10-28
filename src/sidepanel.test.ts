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
  groundedResponse,
  plantKeyAndConsent,
  readShell,
  setupPage,
  sseResponse,
  teardownPage,
  waitFor,
} from './test/helpers';

const SHELL = readShell('sidepanel');

const selectBoardTab = (): void => {
  (document.querySelector('#tab-board') as HTMLButtonElement).click();
};

const waitForHeading = async (text: string): Promise<void> => {
  await waitFor(() => {
    expect(document.querySelector('#result-slot h2')?.textContent).toBe(text);
  });
};

const clickPlanTrip = async (): Promise<void> => {
  await waitFor(() => {
    expect(document.querySelector('#result-slot .plan-trip-button')).not.toBeNull();
  });
  (document.querySelector('#result-slot .plan-trip-button') as HTMLButtonElement).click();
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

const READY = (overrides: Record<string, unknown> = {}) => ({
  requestId: '100-1',
  status: 'ready',
  srcUrl: 'https://cdn.example.com/oia.jpg',
  dataPending: false,
  pageUrl: 'https://example.com/guide',
  tabId: 7,
  signals: SIGNALS,
  ...overrides,
});

const GUIDE_SSE = [
  'event: response.web_search_call.searching\n',
  'data: {}\n',
  '\n',
  'event: response.output_text.delta\n',
  'data: {"delta":"Hello "}\n',
  '\n',
  'event: response.output_text.delta\n',
  'data: {"delta":"world"}\n',
  '\n',
  'event: response.output_text.annotation.added\n',
  'data: {"annotation":{"type":"url_citation","url":"https://example.com/a","title":"A"}}\n',
  '\n',
  'event: response.web_search_call.completed\n',
  'data: {}\n',
  '\n',
  'event: response.completed\n',
  'data: {"response":{"usage":{"input_tokens":300,"output_tokens":120}}}\n',
  '\n',
].join('');

const fetchMock = vi.fn();

const setup = async (): Promise<ChromeMock> =>
  setupPage(SHELL, fetchMock, () => import('./sidepanel'));

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

  it('switches tabs with roving focus, counts pins, and surfaces runs', async () => {
    const mock = await setup();
    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;
    const tabBoard = document.querySelector('#tab-board') as HTMLButtonElement;
    // Locked first run lands on settings with main disabled.
    await waitFor(() => {
      expect(document.querySelector('#tab-settings')?.getAttribute('aria-selected')).toBe('true');
    });
    expect(tabMain.getAttribute('aria-disabled')).toBe('true');
    await plantKeyAndConsent();
    await waitFor(() => {
      expect(tabMain.getAttribute('aria-disabled')).toBeNull();
    });
    tabMain.click();
    const i18n = vi.spyOn(chrome.i18n, 'getMessage');
    expect(tabMain.textContent).toBe('mainTab');
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    expect(tabMain.tabIndex).toBe(0);
    expect(tabBoard.getAttribute('aria-selected')).toBe('false');
    expect(tabBoard.tabIndex).toBe(-1);
    expect(document.querySelector('#tab-bar')?.getAttribute('aria-label')).toBe('tabsLabel');
    expect(document.querySelector('#main-panel')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#board-panel')?.hasAttribute('hidden')).toBe(true);
    tabBoard.click();
    expect(tabBoard.getAttribute('aria-selected')).toBe('true');
    expect(tabBoard.tabIndex).toBe(0);
    expect(tabMain.tabIndex).toBe(-1);
    expect(document.querySelector('#main-panel')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#board-panel')?.hasAttribute('hidden')).toBe(false);
    tabMain.focus();
    tabMain.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabBoard);
    expect(tabBoard.getAttribute('aria-selected')).toBe('true');
    tabBoard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabMain);
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    // A new run surfaces on the main tab even from the board tab.
    tabBoard.click();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('Oia');
    });
    expect(tabMain.getAttribute('aria-selected')).toBe('true');
    (document.querySelector('#result-slot .pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });
    expect(i18n).toHaveBeenCalledWith('boardTitle', '1');
  });

  it('skips the disabled main tab in keyboard navigation', async () => {
    await setup();
    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;
    const tabBoard = document.querySelector('#tab-board') as HTMLButtonElement;
    const tabSettings = document.querySelector('#tab-settings') as HTMLButtonElement;
    await waitFor(() => {
      expect(tabSettings.getAttribute('aria-selected')).toBe('true');
    });
    tabMain.click();
    expect(tabMain.getAttribute('aria-selected')).toBe('false');
    tabSettings.focus();
    tabSettings.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabBoard);
    tabBoard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabBoard);
    tabBoard.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(tabSettings);
    expect(tabMain.getAttribute('aria-selected')).toBe('false');
  });

  it('replaces the saved key from settings and returns to main', async () => {
    await setup();
    await plantKeyAndConsent();
    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;
    await waitFor(() => {
      expect(tabMain.getAttribute('aria-disabled')).toBeNull();
    });
    (document.querySelector('#tab-settings') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')?.textContent).toBe('keySavedStatus');
    });
    const actions = [...document.querySelectorAll('#settings-panel .confirm-actions button')];
    expect(actions.map((button) => button.textContent)).toEqual([
      'keyReplaceButton',
      'clearKeyButton',
    ]);
    (actions[0] as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-input')).not.toBeNull();
    });
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    (document.querySelector('#settings-panel #key-input') as HTMLInputElement).value = 'LLM_new';
    (document.querySelector('#settings-panel form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => {
      expect(tabMain.getAttribute('aria-selected')).toBe('true');
    });
    const { loadKey } = await import('./key_vault');
    expect(await loadKey('muse')).toEqual({ state: 'ok', key: 'LLM_new' });
  });

  it('clears the key from settings and locks the main tab', async () => {
    await setup();
    await plantKeyAndConsent();
    const tabMain = document.querySelector('#tab-main') as HTMLButtonElement;
    await waitFor(() => {
      expect(tabMain.getAttribute('aria-disabled')).toBeNull();
    });
    (document.querySelector('#tab-settings') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#key-saved-status')).not.toBeNull();
    });
    const actions = [...document.querySelectorAll('#settings-panel .confirm-actions button')];
    (actions[1] as HTMLButtonElement).click();
    await waitFor(() => {
      expect(tabMain.getAttribute('aria-disabled')).toBe('true');
    });
    expect(document.querySelector('#tab-settings')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#settings-panel #key-input')).not.toBeNull();
    const { loadKey } = await import('./key_vault');
    expect((await loadKey('muse')).state).toBe('missing');
  });

  it('shows inline key setup when no key is saved', async () => {
    const mock = await setup();
    await mock.session.set({ tripRequest: READY() });
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
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.querySelector('#settings-panel #key-error')?.textContent).toBe(
        'settingsSaveFailed'
      );
    });
    expect(
      (document.querySelector('#settings-panel #session-only') as HTMLInputElement).checked
    ).toBe(false);
    const { loadSettings } = await import('./providers/index');
    expect((await loadSettings()).sessionOnly).toBe(false);
    fail.mockRestore();
    const retry = document.querySelector('#settings-panel #session-only') as HTMLInputElement;
    retry.checked = true;
    retry.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(async () => {
      expect((await loadSettings()).sessionOnly).toBe(true);
    });
    expect(
      (document.querySelector('#settings-panel #session-only') as HTMLInputElement).checked
    ).toBe(true);
    expect(document.querySelector('#settings-panel #key-error')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps live regions outside tabpanels and announces key failures', async () => {
    await setup();
    expect(document.querySelector('main > #status-region')).not.toBeNull();
    expect(document.querySelector('main > #alert-region')).not.toBeNull();
    expect(document.querySelector('#main-panel #status-region')).toBeNull();
    expect(document.querySelector('#board-panel #alert-region')).toBeNull();
    fetchMock.mockResolvedValue(new Response('[]', { status: 401 }));
    (document.querySelector('#settings-panel #key-input') as HTMLInputElement).value = 'LLM_bad';
    (document.querySelector('#settings-panel form') as HTMLFormElement).dispatchEvent(
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

  it('runs identify plus a grounded guide end to end', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    await clickPlanTrip();
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    const grid = document.querySelector('#links-slot');
    expect(grid?.querySelectorAll('a.tile')).toHaveLength(4);
    const chips = document.querySelector('#sources-slot');
    expect(chips?.querySelectorAll('a.chip')).toHaveLength(1);
    expect(document.querySelector('#cost-line')?.textContent).toBe('costLine($0.004 | $0.004)');
    expect(document.querySelector('#status-region')?.textContent).toBe(
      'statusGuideReadySources(1)'
    );
    const guide = document.querySelector('#guide-content') as HTMLElement;
    expect(guide.getAttribute('lang')).toBe('en-US');
    expect(guide.getAttribute('dir')).toBe('ltr');
    expect(guide.getAttribute('role')).toBe('region');
    expect(guide.tabIndex).toBe(0);
    expect(guide.getAttribute('aria-labelledby')).toBe('guide-heading');
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

  it('holds the guide until the plan button is pressed', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusFoundPlan(Oia)');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#guide-slot')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#guide-content')?.textContent).toBe('');
    expect(document.querySelector('#links-slot a.tile')).not.toBeNull();
    const button = document.querySelector('#result-slot .plan-trip-button') as HTMLButtonElement;
    expect(button.textContent).toBe('planTripButton');
    expect(document.querySelector('#cost-line')?.textContent).toBe('costLine($0.000 | $0.000)');
  });

  it('shows the plan button for cached results without a guide', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    await mock.session.set({ tripRequest: READY({ requestId: '200-2' }) });
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusCacheHit(Oia)');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#guide-slot')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#result-slot .plan-trip-button')).not.toBeNull();
  });

  it('renders a long multi-chunk guide in full', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const deltas = [
      'I will research Oia for you. ',
      '## Oia, Greece\n\n',
      'First paragraph of the guide. ',
      'Second sentence here. ',
      '- bullet one\n',
      '- bullet two\n',
      '### Getting there\n\n',
      'Final paragraph at the very end MARKER-XYZ.',
    ];
    const lines: string[] = [];
    for (const d of deltas) {
      lines.push(
        'event: response.output_text.delta\n',
        `data: {"delta":${JSON.stringify(d)}}\n`,
        '\n'
      );
    }
    lines.push(
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":100,"output_tokens":200}}}\n',
      '\n'
    );
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse(lines));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    await clickPlanTrip();
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('MARKER-XYZ');
    });
    const text = document.querySelector('#guide-content')?.textContent ?? '';
    expect(text).toContain('First paragraph');
    expect(text).toContain('bullet two');
    expect(text).not.toContain('research Oia');
  });

  it('retries a failed guide without re-running identify', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    await clickPlanTrip();
    await waitForHeading('errorServerTitle');
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    expect(document.querySelector('#result-slot h2')?.textContent).toBe('Oia');
    expect(document.querySelector('#result-slot .plan-trip-button')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('serves repeat images from cache without fetching', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { hashCacheKey, setCacheEntry } = await import('./result_cache');
    const hash = await hashCacheKey({
      seed: 'https://cdn.example.com/oia.jpg',
      pageUrl: 'https://example.com/guide',
      providerId: 'muse',
      model: 'muse-spark-1.3',
      imageOnly: false,
    });
    await setCacheEntry(hash, {
      place: VALID_PLACE,
      guide: 'Cached guide text.',
      sources: [],
      usage: { inputTokens: 0, outputTokens: 0, searchCount: 0, flatFeesUsd: 0 },
      searchedWeb: false,
    });
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      expect(document.querySelector('#cost-line')?.textContent).toBe('costLineCache');
    });
    expect(document.querySelector('#guide-content')?.textContent).toContain('Cached guide text.');
    expect(document.querySelector('#status-region')?.textContent).toBe('statusCacheHit(Oia)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers from a rejected key through the inline fix', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('errorAuthTitle');
    expect(document.querySelector('#result-slot')).not.toBeNull();
    fetchMock
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    (document.querySelector('#key-input') as HTMLInputElement).value = 'LLM_good';
    (document.querySelector('#settings-panel form') as HTMLFormElement).dispatchEvent(
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
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('noPlaceTitle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.primary') as HTMLButtonElement).click();
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

  it('records each stage exactly once in the monthly total', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(
        sseResponse([
          'event: response.output_text.delta\n',
          'data: {"delta":"## Oia\\nHello world"}\n',
          '\n',
          'event: response.completed\n',
          'data: {"response":{"usage":{"input_tokens":100,"output_tokens":50}}}\n',
          '\n',
        ])
      );
    await mock.session.set({ tripRequest: READY() });
    await clickPlanTrip();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusGuideReady');
    });
    const { monthKey } = await import('./pricing');
    const record = mock.local.data.get('costTotals') as {
      v: number;
      months: Record<string, number>;
    };
    expect(record.v).toBe(1);
    expect(record.months[monthKey(new Date())]).toBeCloseTo(0.000675, 10);
  });

  it('keeps the partial guide when the stream errors mid-way', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(
        sseResponse([
          'event: response.output_text.delta\n',
          'data: {"delta":"## Oia\\nHello"}\n',
          '\n',
          'data: this unnamed block kills the stream\n',
          '\n',
        ])
      );
    await mock.session.set({ tripRequest: READY() });
    await clickPlanTrip();
    await waitFor(() => {
      expect(document.querySelector('.guide-interrupted')?.textContent).toBe('guideInterrupted');
    });
    expect(document.querySelector('#guide-content')?.textContent).toContain('Hello');
    expect(document.querySelector('#result-slot')?.querySelector('h2')?.textContent).toBe('Oia');
    expect(document.querySelector('#result-slot .plan-trip-button')?.textContent).toBe(
      'planTripButton'
    );
    expect(document.querySelector('#alert-region')?.textContent).toBe('guideInterrupted');
  });

  it('holds back guide preamble and renders from the heading', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(
        sseResponse([
          'event: response.output_text.delta\n',
          'data: {"delta":"I will research Oia to build your factual trip guide."}\n',
          '\n',
          'event: response.output_text.delta\n',
          'data: {"delta":"## Oia\\nHello world"}\n',
          '\n',
          'event: response.completed\n',
          'data: {"response":{"usage":{"input_tokens":100,"output_tokens":50}}}\n',
          '\n',
        ])
      );
    await mock.session.set({ tripRequest: READY() });
    await clickPlanTrip();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusGuideReady');
    });
    const content = document.querySelector('#guide-content');
    expect(content?.textContent).toContain('Hello world');
    expect(content?.textContent).not.toContain('research Oia');
    expect(content?.querySelector('h3')?.textContent).toBe('Oia');
  });

  it('keeps the consent gate for re-click when the flag write fails', async () => {
    const mock = await setup();
    const { saveKey } = await import('./key_vault');
    await saveKey('muse', 'LLM_x', false);
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      expect(document.querySelector('#result-slot h2')?.textContent).toBe('consentTitle');
    });
    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    const agree = [...document.querySelectorAll('#result-slot button')].find(
      (button) => button.textContent === 'agreeButton'
    ) as HTMLButtonElement;
    agree.click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('settingsSaveFailed');
    });
    expect(document.querySelector('#result-slot h2')?.textContent).toBe('consentTitle');
    expect(fetchMock).not.toHaveBeenCalled();
    fail.mockRestore();
    const retry = [...document.querySelectorAll('#result-slot button')].find(
      (button) => button.textContent === 'agreeButton'
    ) as HTMLButtonElement;
    retry.click();
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gates the first video analysis behind the frame confirm', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame', time: 12.5 },
      }),
    });
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
    expect(img?.getAttribute('src')).toBe('data:image/jpeg,frame');
    expect(img?.alt).toBe('previewAltFrame');
  });

  it('analyzes the captured frame after the video confirm', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame', time: 12.5 },
      }),
    });
    await waitFor(() => {
      expect(document.querySelector('#result-slot .confirm-actions .primary')).not.toBeNull();
    });
    (document.querySelector('#result-slot .confirm-actions .primary') as HTMLButtonElement).click();
    await waitForHeading('Oia');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
    };
    expect(body.messages[1].content[1].image_url?.url).toBe('data:image/jpeg,frame');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyVideoFrame(Meta's Muse API)"
    );
  });

  it('keeps the video confirm for re-click when the flag write fails', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame', time: 12.5 },
      }),
    });
    await waitFor(() => {
      expect(document.querySelector('#result-slot .confirm-actions .primary')).not.toBeNull();
    });
    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    (document.querySelector('#result-slot .confirm-actions .primary') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('settingsSaveFailed');
    });
    expect(document.querySelector('#result-slot h2')?.textContent).toBe('videoConfirmTitle');
    expect(fetchMock).not.toHaveBeenCalled();
    fail.mockRestore();
    (document.querySelector('#result-slot .confirm-actions .primary') as HTMLButtonElement).click();
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The gate is one-time: the next video analyzes without asking.
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({
      tripRequest: READY({
        requestId: '200-2',
        srcUrl: 'blob:https://example.com/bbb',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame2', time: 3 },
      }),
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(document.querySelector('#result-slot .confirm-actions')).toBeNull();
  });

  it('discards the staged video when the confirm is declined', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frame: { dataUrl: 'data:image/jpeg,frame', time: 12.5 },
      }),
    });
    await waitFor(() => {
      expect(document.querySelectorAll('#result-slot .confirm-actions button')).toHaveLength(2);
    });
    const cancel = [
      ...document.querySelectorAll('#result-slot .confirm-actions button'),
    ][1] as HTMLButtonElement;
    cancel.click();
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
    const { setVideoConsented } = await import('./video');
    await setVideoConsented();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'https://cdn.example.com/trip.mp4',
        mediaType: 'video',
        frameError: 'tainted',
      }),
    });
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
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    const pin = card.querySelector('.pin-button') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    pin.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });
    expect(
      (card.querySelector('.pin-button') as HTMLButtonElement).getAttribute('aria-pressed')
    ).toBe('true');
    const board = document.querySelector('#board-slot') as HTMLElement;
    const items = [...(board.querySelectorAll('li') ?? [])];
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.item-name')?.textContent).toBe('Oia, Greece');
    expect(items[0].querySelector('.item-host')?.textContent).toBe('example.com');
    expect(
      (board.querySelector('.plan-button') as HTMLButtonElement).getAttribute('aria-disabled')
    ).toBe('true');
    (card.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinDuplicate(Oia)');
    });
    expect(board.querySelectorAll('li')).toHaveLength(1);
    const remove = items[0].querySelector('button') as HTMLButtonElement;
    remove.click();
    await waitFor(() => {
      expect(board.querySelectorAll('li')).toHaveLength(0);
    });
    expect(
      (card.querySelector('.pin-button') as HTMLButtonElement).getAttribute('aria-pressed')
    ).toBe('false');
  });

  it('labels the board retry for failed removals', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    (document.querySelector('#result-slot .pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#board-slot li')).not.toBeNull();
    });
    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    (document.querySelector('#board-slot li button') as HTMLButtonElement).click();
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
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('alertPinFail(Oia)');
    });
    const board = document.querySelector('#board-slot') as HTMLElement;
    expect(board.querySelector('.notice')?.textContent).toContain('boardNoticePinFail');
    fail.mockRestore();
    selectBoardTab();
    (board.querySelector('.notice button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });
    const { listPins } = await import('./board_store');
    const pins = await listPins();
    expect(pins).toHaveLength(1);
    expect(pins[0].thumbnail).toBeUndefined();
  });

  it('clears the board through the inline confirm', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });
    const board = document.querySelector('#board-slot') as HTMLElement;
    selectBoardTab();
    (board.querySelector('.clear-button') as HTMLButtonElement).click();
    expect(board.querySelector('.confirm-heading')?.textContent).toBe('boardClearTitle(1)');
    const [, cancel] = [
      ...(board.querySelectorAll('.confirm-actions button') ?? []),
    ] as HTMLButtonElement[];
    cancel.click();
    expect(board.querySelectorAll('li')).toHaveLength(1);
    (board.querySelector('.clear-button') as HTMLButtonElement).click();
    const [confirm] = [
      ...(board.querySelectorAll('.confirm-actions button') ?? []),
    ] as HTMLButtonElement[];
    confirm.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardCleared');
    });
    expect(board.querySelectorAll('li')).toHaveLength(0);
    expect(document.activeElement?.className).toContain('disclosure');
  });

  it('plans a trip from two pins with a narrated itinerary', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const FIRA = { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', oneLiner: 'Cliff views.' };
    const VALID_PLAN = {
      stops: ['Oia, Greece', 'Fira, Greece'],
      days: [
        {
          dayTitle: 'Caldera day',
          stopNames: ['Oia, Greece', 'Fira, Greece'],
          summary: 'Walk the caldera path.',
        },
      ],
      nightsEach: [
        { stop: 'Oia, Greece', nights: 2 },
        { stop: 'Fira, Greece', nights: 1 },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(chatResponse(FIRA))
      .mockResolvedValueOnce(chatResponse(VALID_PLAN))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned(Oia | 1)');
    });
    await mock.session.set({
      tripRequest: READY({
        requestId: '200-2',
        srcUrl: 'https://cdn.example.com/fira.jpg',
      }),
    });
    await waitFor(() => {
      expect(card.querySelector('h2')?.textContent).toBe('Fira');
    });
    (card.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      const board = document.querySelector('#board-slot') as HTMLElement;
      expect(board.querySelectorAll('li')).toHaveLength(2);
    });
    const board = document.querySelector('#board-slot') as HTMLElement;
    selectBoardTab();
    const plan = board.querySelector('.plan-button') as HTMLButtonElement;
    expect(plan.hasAttribute('aria-disabled')).toBe(false);
    plan.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusItineraryReady');
    });
    expect(document.querySelector('#tab-main')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#board-panel')?.hasAttribute('hidden')).toBe(true);
    expect(card.querySelector('h2')?.textContent).toBe('itineraryTitle(2)');
    expect(card.querySelectorAll('.stop-list li')).toHaveLength(2);
    const maps = card.querySelector('.maps-link') as HTMLAnchorElement;
    expect(maps.href).toContain('maps/dir');
    expect(maps.href).toContain('origin=');
    expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyBoard(Meta's Muse API)"
    );
    expect(document.querySelector('#cost-line')?.textContent).toBe('costLine($0.004 | $0.004)');
    expect((document.activeElement as HTMLElement)?.tagName).toBe('H2');
    const [, , structure] = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(init.body as string) as {
        messages: Array<{ content: Array<{ type: string }> }>;
        response_format: { type: string };
      };
    });
    expect(structure.response_format.type).toBe('json_schema');
    expect(structure.messages[1].content[0].type).toBe('text');
  });

  it('renders the scan skeleton while the harvest is collecting', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({
        status: 'collecting',
        srcUrl: '',
        signals: undefined,
        scanImages: [],
      }),
    });
    await waitFor(() => {
      const list = document.querySelector('#result-slot');
      expect(list?.querySelector('h2')?.textContent).toBe('scanTitle');
    });
    const list = document.querySelector('#result-slot');
    const grid = list?.querySelector('.skeleton-grid');
    expect(grid?.getAttribute('aria-hidden')).toBe('true');
    expect(grid?.querySelectorAll('.skeleton-block')).toHaveLength(6);
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
    await mock.session.set({
      tripRequest: READY({
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
    });
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
    await mock.session.set({ tripRequest: READY({ requestId: '200-2', windowId: 2 }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('#result-slot')?.textContent).toContain('panelIdle');
    expect(document.querySelector('#status-region')?.textContent).toBe('');
  });

  it('runs handoff records stamped for its own window', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY({ requestId: '200-2', windowId: 1 }) });
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops numerically older handoffs even when they sort later as strings', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY({ requestId: '10-1' }) });
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await mock.session.set({ tripRequest: READY({ requestId: '9-1' }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tombstones accepted handoffs so reopens never replay them', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY({ requestId: '200-2' }) });
    await waitForHeading('Oia');
    const stored = await mock.session.get('tripRequest');
    expect(stored.tripRequest).toEqual({ requestId: '200-2', status: 'ready' });
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
    await mock.session.set({ tripRequest: READY({ requestId: '300-1' }) });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await mock.session.set({
      tripRequest: READY({
        requestId: '300-2',
        srcUrl: 'https://cdn.example.com/fira.jpg',
      }),
    });
    await waitForHeading('Fira');
    resolveFirst(chatResponse(VALID_PLACE));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector('#result-slot')?.textContent).toContain('Fira');
    expect(document.querySelector('#result-slot')?.textContent).not.toContain('Oia');
  });

  it('moves focus to the new heading when a swap removes the focused control', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY({ requestId: '400-1' }) });
    await waitForHeading('Oia');
    (document.querySelector('#result-slot .pin-button') as HTMLButtonElement).focus();
    await mock.session.set({
      tripRequest: READY({ requestId: '400-2', dataPending: true, srcUrl: '' }),
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(document.querySelector('#result-slot h2'));
    });
  });

  it('drops expired handoffs and wipes them', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({ requestId: '200-2', at: Date.now() - 11 * 60 * 1000 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    const stored = await mock.session.get('tripRequest');
    expect(stored.tripRequest).toEqual({ requestId: '200-2', status: 'ready' });
  });

  it('identifies image-only when the scrape failed and signals are omitted', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    const record = READY({ requestId: '200-2' });
    delete (record as Record<string, unknown>).signals;
    await mock.session.set({ tripRequest: record });
    await waitForHeading('Oia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows honest cards for empty harvests and empty results', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({ srcUrl: '', signals: undefined, scanImages: [] }),
    });
    await waitForHeading('scanEmptyTitle');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(chatResponse({ places: [] }));
    await mock.session.set({
      tripRequest: READY({
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
    });
    await waitForHeading('scanNoneTitle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams a scan guide with no second identify pass', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(
        chatResponse({
          places: [
            { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
          ],
        })
      )
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({
      tripRequest: READY({
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
    });
    await waitFor(() => {
      const list = document.querySelector('#result-slot');
      expect(list?.querySelectorAll('.scan-card')).toHaveLength(1);
    });
    const list = document.querySelector('#result-slot') as HTMLElement;
    (list.querySelector('.scan-card button') as HTMLButtonElement).click();
    await waitForHeading('Oia');
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pins scan cards singly and in bulk', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { listPins } = await import('./board_store');
    fetchMock.mockResolvedValueOnce(
      chatResponse({
        places: [
          { placeName: 'Oia', city: 'Oia', country: 'Greece', confidence: 0.9, imageIndex: 0 },
          { placeName: 'Fira', city: 'Fira', country: 'Greece', confidence: 0.8, imageIndex: 1 },
        ],
      })
    );
    await mock.session.set({
      tripRequest: READY({
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
    });
    await waitFor(() => {
      const list = document.querySelector('#result-slot');
      expect(list?.querySelectorAll('.scan-card')).toHaveLength(2);
    });
    const list = document.querySelector('#result-slot') as HTMLElement;
    const cards = list.querySelectorAll('.scan-card');
    (cards?.[0]?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(async () => {
      expect(await listPins()).toHaveLength(1);
    });
    expect((await listPins())[0]?.imageUrl).toBe('https://img.example.com/a.jpg');
    await waitFor(() => {
      const pressed = document
        .querySelector('#result-slot')
        ?.querySelectorAll('.scan-card')[0]
        ?.querySelector('.pin-button')
        ?.getAttribute('aria-pressed');
      expect(pressed).toBe('true');
    });
    for (const box of list.querySelectorAll('input[type="checkbox"]') ?? []) {
      (box as HTMLInputElement).click();
    }
    (list.querySelector('.pin-selected') as HTMLButtonElement).click();
    await waitFor(async () => {
      expect(await listPins()).toHaveLength(2);
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
    await mock.session.set({
      tripRequest: READY({
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
    });
    await waitForHeading('errorServerTitle');
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      const list = document.querySelector('#result-slot');
      expect(list?.querySelectorAll('.scan-card')).toHaveLength(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('duels the result against a pinned place', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace } = await import('./board_store');
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE)).mockResolvedValueOnce(
      groundedResponse(
        {
          criteria: [{ criterion: 'Cost', a: 'Pricey sunsets.', b: 'Cheaper stays.' }],
          verdict: 'Pick Oia for views; pick Fira for budget.',
        },
        [{ type: 'url_citation', url: 'https://example.com/cost', title: 'Costs' }]
      )
    );
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    await waitFor(() => {
      expect(card.querySelectorAll('.compare-row option')).toHaveLength(1);
    });
    expect(card.querySelector('.compare-row option')?.textContent).toBe('Fira, Greece');
    (card.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      const table = document.querySelector('#duel-slot');
      expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('duelReady');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyNames(Meta's Muse API)"
    );
    const table = document.querySelector('#duel-slot');
    expect(table?.querySelector('caption')?.textContent).toBe(
      'duelCaption(Oia, Greece | Fira, Greece)'
    );
    expect(table?.querySelector('table')?.getAttribute('aria-busy')).toBe('false');
    const chips = document.querySelector('#sources-slot');
    expect(chips?.querySelectorAll('a.chip')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const duelUrl = fetchMock.mock.calls[1][0] as string;
    expect(duelUrl).toContain('/responses');
  });

  it('cancels a hanging duel and clears the slot', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace } = await import('./board_store');
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    await waitFor(() => {
      expect(card.querySelectorAll('.compare-row option')).toHaveLength(1);
    });
    (card.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#duel-slot button')?.textContent).toBe('cancelButton');
    });
    (document.querySelector('#duel-slot button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#duel-slot')?.hasAttribute('hidden')).toBe(true);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
  });

  it('cancels hanging alternates and restores the chips', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    const chips = [...card.querySelectorAll('.chips-row .chip')] as HTMLButtonElement[];
    expect(chips).toHaveLength(3);
    chips[0].click();
    await waitFor(() => {
      expect(card.querySelector('.alternates button')?.textContent).toBe('cancelButton');
    });
    (card.querySelector('.alternates button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(card.querySelector('.alternates')?.hasAttribute('hidden')).toBe(true);
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusCanceled');
    expect(card.querySelectorAll('.chips-row .chip')).toHaveLength(chips.length);
  });

  it('falls back to chat when duel grounding is rejected', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace } = await import('./board_store');
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(
        chatResponse({
          criteria: [{ criterion: 'Cost', a: 'Pricey.', b: 'Cheap.' }],
          verdict: 'Pick Oia for views.',
        })
      );
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('#result-slot');
      expect(card?.querySelector('.compare-go')).not.toBeNull();
    });
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      const table = document.querySelector('#duel-slot');
      expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(document.querySelector('#sources-slot')?.hasAttribute('hidden')).toBe(true);
  });

  it('retries a failed duel inline without losing the result', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace } = await import('./board_store');
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(
        chatResponse({
          criteria: [{ criterion: 'Cost', a: 'Pricey.', b: 'Cheap.' }],
          verdict: 'Pick Oia for views.',
        })
      );
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('#result-slot');
      expect(card?.querySelector('.compare-go')).not.toBeNull();
    });
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      const table = document.querySelector('#duel-slot');
      expect(table?.querySelector('.duel-error p')?.textContent).toBe(
        'duelError(Oia, Greece | Fira, Greece)'
      );
    });
    expect(card.querySelector('h2')?.textContent).toBe('Oia');
    const table = document.querySelector('#duel-slot') as HTMLElement;
    (table.querySelector('.duel-error button') as HTMLButtonElement).click();
    await waitFor(() => {
      const retried = document.querySelector('#duel-slot');
      expect(retried?.querySelectorAll('tbody tr')).toHaveLength(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('finds alternates and re-plans the trip instead', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    const chips = card.querySelectorAll('.chips-row .chip');
    expect(chips).toHaveLength(3);
    (chips?.[0] as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('alternatesReady(2)');
    });
    const fresh = document.querySelector('#result-slot') as HTMLElement;
    expect(fresh.querySelectorAll('.alternate-card')).toHaveLength(2);
    (
      fresh.querySelector('.alternate-actions button:not(.pin-button)') as HTMLButtonElement
    ).click();
    await waitFor(() => {
      const grid = document.querySelector('#links-slot');
      const tiles = grid?.querySelectorAll('a.tile');
      expect(tiles?.length).toBeGreaterThan(0);
      expect((tiles?.[0] as HTMLAnchorElement).href).toContain('Fira');
    });
    expect(document.querySelector('#guide-content')?.textContent).toBe('Hello world');
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyNames(Meta's Muse API)"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.chips-row .chip') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('alternatesReady(1)');
    });
    const fresh = document.querySelector('#result-slot') as HTMLElement;
    const pin = fresh.querySelector('.alternate-card .pin-button') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(fresh.querySelector('.alternate-card .thumb-monogram')?.textContent).toBe('F');
    pin.click();
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
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('Oia');
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.chips-row .chip') as HTMLButtonElement).click();
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

  it('excludes the current place from duel targets and handles stale picks', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { pinPlace, removePin } = await import('./board_store');
    await pinPlace({ place: VALID_PLACE, sourceHost: 'example.com' });
    await pinPlace({
      place: { ...VALID_PLACE, placeName: 'Fira', city: 'Fira', confidence: 0.8 },
      sourceHost: 'example.com',
    });
    fetchMock.mockResolvedValueOnce(chatResponse(VALID_PLACE));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('#result-slot');
      expect(card?.querySelectorAll('.compare-row option')).toHaveLength(1);
    });
    const card = document.querySelector('#result-slot') as HTMLElement;
    expect(card.querySelector('.compare-row option')?.textContent).toBe('Fira, Greece');
    await removePin('Fira', 'Greece');
    (card.querySelector('.compare-go') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('compareStale');
    });
    expect(document.querySelector('#duel-slot table')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('#result-slot');
      expect(card?.querySelectorAll('button')).toHaveLength(2);
    });
    const card = document.querySelector('#result-slot') as HTMLElement;
    const buttons = card.querySelectorAll('button');
    expect(buttons?.[1]?.textContent).toBe('fetchRetryButton');
    (buttons?.[1] as HTMLButtonElement).click();
    await waitFor(() => {
      const retried = document.querySelector('#result-slot');
      expect(retried?.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(document.querySelector('#privacy-line')?.textContent).toBe(
      "privacyImagePixels(Meta's Muse API)"
    );
    await clickPlanTrip();
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    expect(permsRequest).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(permsRemove).toHaveBeenCalledWith({ origins: ['https://cdn.example.com/*'] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[2][0]).toBe('https://cdn.example.com/oia.jpg');
    const retryInit = fetchMock.mock.calls[3][1] as RequestInit;
    const retryBody = JSON.parse(retryInit.body as string) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = retryBody.messages[1].content.find((part) => part.type === 'image_url');
    expect(imagePart?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
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
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('#result-slot');
      expect(card?.querySelectorAll('button')).toHaveLength(2);
    });
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelectorAll('button')?.[1] as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('fetchFailed');
    });
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
    await mock.session.set({
      tripRequest: READY({ srcUrl: 'http://localhost:8000/oia.jpg' }),
    });
    await waitFor(() => {
      const card = document.querySelector('#result-slot');
      expect(card?.querySelectorAll('button')).toHaveLength(2);
    });
    const card = document.querySelector('#result-slot') as HTMLElement;
    expect(card.querySelectorAll('button')?.[1]?.textContent).toBe('fetchRetryButton');
    (card.querySelectorAll('button')?.[1] as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#result-slot')?.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(permsRequest).not.toHaveBeenCalled();
    expect(permsRemove).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8000/oia.jpg');
  });

  it('announces denial and hides the fetch button on non-400 errors', async () => {
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
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('#result-slot');
      expect(card?.querySelectorAll('button')).toHaveLength(2);
    });
    const card = document.querySelector('#result-slot') as HTMLElement;
    const buttons = card.querySelectorAll('button');
    (buttons?.[1] as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('fetchDenied');
    });
    expect(permsRemove).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await mock.session.set({ tripRequest: READY({ requestId: '200-2' }) });
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
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('noPlaceTitle');
    const card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.primary') as HTMLButtonElement).click();
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
    await mock.session.set({ tripRequest: READY() });
    await waitForHeading('noPlaceTitle');
    let card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(card.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(imageOf(3)).toBe('https://cdn.example.com/oia.jpg');
    await mock.session.set({
      tripRequest: READY({ requestId: '200-2', srcUrl: 'https://cdn.example.com/fira.jpg' }),
    });
    await waitFor(() => {
      const retry = document.querySelector('#result-slot');
      expect(retry?.querySelector('h2')?.textContent).toBe('noPlaceTitle');
    });
    card = document.querySelector('#result-slot') as HTMLElement;
    (card.querySelector('.primary') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(card.querySelector('h2')?.textContent).toBe('Oia');
    });
    expect(imageOf(7)).toBe('https://cdn.example.com/fira.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('renders honest cards with fallback links for unreadable video', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    await mock.session.set({
      tripRequest: READY({
        srcUrl: 'blob:https://example.com/aaa',
        mediaType: 'video',
        frameError: 'drm',
      }),
    });
    await waitForHeading('errorVideoTitle');
    expect(document.querySelector('#alert-region')?.textContent).toBe('alertVideoUnreadable');
    expect(fetchMock).not.toHaveBeenCalled();
    const card = document.querySelector('#result-slot');
    expect(card?.querySelector('.fallback a')).not.toBeNull();
    await mock.session.set({
      tripRequest: READY({
        requestId: '300-3',
        srcUrl: 'blob:https://example.com/bbb',
        mediaType: 'video',
        frameError: 'no-match',
      }),
    });
    await waitFor(() => {
      const retry = document.querySelector('#result-slot');
      expect(retry?.querySelector('h2')?.textContent).toBe('errorVideoMatchTitle');
    });
  });
});
