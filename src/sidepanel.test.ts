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

import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

const SHELL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../public/sidepanel.html'),
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

const VALID_PLACE = {
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes over the caldera.',
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

const chatResponse = (place: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(place) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200 },
  );

const sseResponse = (chunks: string[]) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
};

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

const setup = async (): Promise<ChromeMock> => {
  vi.resetModules();
  const mock = installChromeMock();
  mountShell();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  await import('./sidepanel');
  return mock;
};

const plantKeyAndConsent = async (): Promise<void> => {
  const { saveKey } = await import('./key_vault');
  const { setConsented } = await import('./providers/index');
  await saveKey('muse', 'LLM_x', false);
  await setConsented();
};

afterEach(() => {
  document.body.innerHTML = '';
  uninstallChromeMock();
  vi.unstubAllGlobals();
});

describe('sidepanel', () => {
  it('renders idle with the manual form', async () => {
    await setup();
    const card = document.querySelector('trip-card');
    expect(card?.shadowRoot?.querySelector('.hint')?.textContent).toBe('panelIdle');
    expect(document.querySelector('#manual-label')?.textContent).toBe('manualLabel');
    expect(document.querySelector('#manual-go')?.textContent).toBe('manualGoButton');
    await waitFor(() => {
      expect(card?.shadowRoot?.querySelector('.shortcut')?.textContent).toBe('shortcutUnset');
    });
  });

  it('shows inline key setup when no key is saved', async () => {
    const mock = await setup();
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      expect(document.querySelector('key-setup')).not.toBeNull();
    });
    expect(document.querySelector('#status-region')?.textContent).toBe('statusKeyNeeded');
    const img = document.querySelector('#preview-frame img') as HTMLImageElement | null;
    expect(img?.src).toContain('oia.jpg');
  });

  it('runs identify plus a grounded guide end to end', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
    const grid = document.querySelector('booking-grid');
    expect(grid?.shadowRoot?.querySelectorAll('a.tile')).toHaveLength(4);
    const chips = document.querySelector('source-chips');
    expect(chips?.shadowRoot?.querySelectorAll('a.chip')).toHaveLength(1);
    expect(document.querySelector('#cost-line')?.textContent).toBe('costLine');
    expect(document.querySelector('#status-region')?.textContent).toBe('statusGuideReadySources');
  });

  it('serves repeat images from cache without fetching', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    const { hashCacheKey, setCacheEntry } = await import('./sidepanel');
    const hash = await hashCacheKey('https://cdn.example.com/oia.jpg', 'https://example.com/guide');
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
    expect(document.querySelector('#status-region')?.textContent).toBe('statusCacheHit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers from a rejected key through the inline fix', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorAuthTitle');
    });
    expect(document.querySelector('key-setup')).not.toBeNull();
    fetchMock
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    const keySetup = document.querySelector('key-setup') as HTMLElement;
    keySetup.dispatchEvent(
      new CustomEvent('key-save-request', {
        detail: { key: 'LLM_good', sessionOnly: false },
        bubbles: true,
        composed: true,
      }),
    );
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
  });

  it('plans manual destinations with links plus a streamed guide', async () => {
    await setup();
    await plantKeyAndConsent();
    fetchMock.mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    (document.querySelector('#manual-input') as HTMLInputElement).value = 'Oia, Greece';
    (document.querySelector('#manual-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => {
      const grid = document.querySelector('booking-grid');
      expect(grid?.shadowRoot?.querySelectorAll('a.tile')).toHaveLength(4);
    });
    await waitFor(() => {
      expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    });
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
    const buttons = [...document.querySelectorAll('.confirm-actions button')];
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
      expect(document.querySelector('.confirm-actions .primary')).not.toBeNull();
    });
    (document.querySelector('.confirm-actions .primary') as HTMLButtonElement).click();
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
    };
    expect(body.messages[1].content[1].image_url?.url).toBe('data:image/jpeg,frame');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyVideoFrame');
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
    expect(document.querySelector('.confirm-actions')).toBeNull();
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
      expect(document.querySelectorAll('.confirm-actions button')).toHaveLength(2);
    });
    const cancel = [...document.querySelectorAll('.confirm-actions button')][1] as HTMLButtonElement;
    cancel.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe(
        'statusVideoConfirmDeclined',
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
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(body.messages[1].content[1].type).toBe('video_url');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyVideoUrl');
  });

  it('pins results to the board with announcements', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    const pin = card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    pin.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned');
    });
    expect(
      (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    const board = document.querySelector('trip-board') as HTMLElement;
    const items = [...(board.shadowRoot?.querySelectorAll('li') ?? [])];
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.item-name')?.textContent).toBe('Oia, Greece');
    expect(items[0].querySelector('.item-host')?.textContent).toBe('example.com');
    expect(
      (board.shadowRoot?.querySelector('.plan-button') as HTMLButtonElement).getAttribute(
        'aria-disabled',
      ),
    ).toBe('true');
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinDuplicate');
    });
    expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(1);
    const remove = items[0].querySelector('button') as HTMLButtonElement;
    remove.click();
    await waitFor(() => {
      expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(0);
    });
    expect(
      (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('false');
  });

  it('retries failed pins without the thumbnail', async () => {
    const mock = await setup();
    await plantKeyAndConsent();
    fetchMock
      .mockResolvedValueOnce(chatResponse(VALID_PLACE))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const fail = vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#alert-region')?.textContent).toBe('alertPinFail');
    });
    const board = document.querySelector('trip-board') as HTMLElement;
    expect(board.shadowRoot?.querySelector('.notice')?.textContent).toContain('boardNoticePinFail');
    fail.mockRestore();
    (board.shadowRoot?.querySelector('.notice button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned');
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
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned');
    });
    const board = document.querySelector('trip-board') as HTMLElement;
    (board.shadowRoot?.querySelector('.clear-button') as HTMLButtonElement).click();
    expect(board.shadowRoot?.querySelector('.confirm-heading')?.textContent).toBe(
      'boardClearTitle',
    );
    const [, cancel] = [
      ...(board.shadowRoot?.querySelectorAll('.confirm-actions button') ?? []),
    ] as HTMLButtonElement[];
    cancel.click();
    expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(1);
    (board.shadowRoot?.querySelector('.clear-button') as HTMLButtonElement).click();
    const [confirm] = [
      ...(board.shadowRoot?.querySelectorAll('.confirm-actions button') ?? []),
    ] as HTMLButtonElement[];
    confirm.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('boardCleared');
    });
    expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(0);
    expect(board.shadowRoot?.activeElement?.className).toContain('disclosure');
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
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(chatResponse(FIRA))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]))
      .mockResolvedValueOnce(chatResponse(VALID_PLAN))
      .mockResolvedValueOnce(sseResponse([GUIDE_SSE]));
    await mock.session.set({ tripRequest: READY() });
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('Oia');
    });
    const card = document.querySelector('trip-card') as HTMLElement;
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusPinned');
    });
    await mock.session.set({
      tripRequest: READY({
        requestId: '200-2',
        srcUrl: 'https://cdn.example.com/fira.jpg',
      }),
    });
    await waitFor(() => {
      expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('Fira');
    });
    (card.shadowRoot?.querySelector('.pin-button') as HTMLButtonElement).click();
    await waitFor(() => {
      const board = document.querySelector('trip-board') as HTMLElement;
      expect(board.shadowRoot?.querySelectorAll('li')).toHaveLength(2);
    });
    const board = document.querySelector('trip-board') as HTMLElement;
    const plan = board.shadowRoot?.querySelector('.plan-button') as HTMLButtonElement;
    expect(plan.hasAttribute('aria-disabled')).toBe(false);
    plan.click();
    await waitFor(() => {
      expect(document.querySelector('#status-region')?.textContent).toBe('statusItineraryReady');
    });
    expect(card.shadowRoot?.querySelector('h2')?.textContent).toBe('itineraryTitle');
    expect(card.shadowRoot?.querySelectorAll('.stop-list li')).toHaveLength(2);
    const maps = card.shadowRoot?.querySelector('.maps-link') as HTMLAnchorElement;
    expect(maps.href).toContain('maps/dir');
    expect(maps.href).toContain('origin=');
    expect(document.querySelector('#guide-content')?.textContent).toContain('Hello world');
    expect(document.querySelector('#privacy-line')?.textContent).toBe('privacyBoard');
    expect(document.querySelector('#cost-line')?.textContent).toBe('costLine');
    expect((card.shadowRoot?.activeElement as HTMLElement)?.tagName).toBe('H2');
    const [, , , , structure] = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(init.body as string) as {
        messages: Array<{ content: Array<{ type: string }> }>;
        response_format: { type: string };
      };
    });
    expect(structure.response_format.type).toBe('json_schema');
    expect(structure.messages[1].content[0].type).toBe('text');
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
    await waitFor(() => {
      const card = document.querySelector('trip-card');
      expect(card?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorVideoTitle');
    });
    expect(document.querySelector('#alert-region')?.textContent).toBe('alertVideoUnreadable');
    expect(fetchMock).not.toHaveBeenCalled();
    const card = document.querySelector('trip-card');
    expect(card?.shadowRoot?.querySelector('.fallback a')).not.toBeNull();
    await mock.session.set({
      tripRequest: READY({
        requestId: '300-3',
        srcUrl: 'blob:https://example.com/bbb',
        mediaType: 'video',
        frameError: 'no-match',
      }),
    });
    await waitFor(() => {
      const retry = document.querySelector('trip-card');
      expect(retry?.shadowRoot?.querySelector('h2')?.textContent).toBe('errorVideoMatchTitle');
    });
  });
});
